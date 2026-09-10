import { request } from 'undici';

import {
  closeDispatcher,
  createGuardedDispatcher,
  errorCodeOf,
  readBounded,
  validateHopUrl,
} from '../monitoring/safe-request.js';

/**
 * One POST to a notification channel, through the SSRF boundary.
 *
 * A webhook URL is chosen by a customer exactly as a monitored website is, and
 * the worker sending to it is exactly as much of an open proxy if it is
 * careless — so it goes through the same two layers: the URL string is
 * re-validated here, immediately before sending, and the connection is made by
 * the guarded dispatcher whose DNS lookup refuses a private address. A fresh
 * pool per request, as everywhere else, so no reused socket skips the lookup.
 *
 * Redirects are **not** followed. A webhook that answers 3xx is misconfigured,
 * and following it would mean re-running the SSRF checks on a hop the customer
 * never saw, to deliver a signed payload somewhere they did not choose. It is
 * reported, with the reason, instead.
 *
 * The receiver's answer is classified rather than just recorded, because what
 * happens next depends on it: a 503 is worth another attempt in two minutes,
 * and a 404 from Slack means the webhook was deleted and will never work again.
 */

export interface ChannelRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Test-only: see AddressGuardOptions. Refused in production at startup. */
  readonly allowLoopback: boolean;
}

export interface ChannelResponse {
  readonly delivered: boolean;
  /** Whether trying again later could plausibly succeed. Meaningless once delivered. */
  readonly retryable: boolean;
  readonly statusCode: number | null;
  readonly durationMs: number;
  readonly failureReason: string | null;
  /** The receiver's own `Retry-After`, in seconds, when it gave one. */
  readonly retryAfterSeconds: number | null;
}

/**
 * How much of an error response is kept for the delivery log.
 *
 * Enough for Slack's `no_service` or Discord's `{"message": "Unknown Webhook"}`,
 * which are what actually tell someone why their channel stopped working.
 * Bounded, because the body is chosen by whoever runs the endpoint.
 */
const RESPONSE_EXCERPT_BYTES = 1024;
const RESPONSE_EXCERPT_CHARS = 200;

const TIMEOUT_CODES = new Set([
  'ABORT_ERR',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const BLOCKED_REASON = 'The destination resolves to an address that must not be reached.';

export async function postToChannel(input: ChannelRequest): Promise<ChannelResponse> {
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;

  const validated = validateHopUrl(input.url, input.allowLoopback);
  if (!validated.ok) {
    return failed({
      retryable: false,
      durationMs: elapsed(),
      failureReason: validated.blocked ? BLOCKED_REASON : validated.reason,
    });
  }

  const dispatcher = createGuardedDispatcher({
    timeoutMs: input.timeoutMs,
    allowLoopback: input.allowLoopback,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, input.timeoutMs);

  try {
    const response = await request(validated.href, {
      method: 'POST',
      dispatcher,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...input.headers },
      body: input.body,
    });

    const statusCode = response.statusCode;

    if (statusCode >= 200 && statusCode < 300) {
      // Discarded explicitly, or the socket leaks.
      await response.body.dump();
      return {
        delivered: true,
        retryable: false,
        statusCode,
        durationMs: elapsed(),
        failureReason: null,
        retryAfterSeconds: null,
      };
    }

    if (statusCode >= 300 && statusCode < 400) {
      await response.body.dump();
      return failed({
        retryable: false,
        statusCode,
        durationMs: elapsed(),
        failureReason: `Answered with a redirect (HTTP ${String(statusCode)}). Redirects are not followed; use the final URL.`,
      });
    }

    const { text } = await readBounded(response.body, RESPONSE_EXCERPT_BYTES);
    const excerpt = toExcerpt(text);

    return failed({
      // A timeout, a rate limit or a server fault can clear up on its own. Any
      // other 4xx is the receiver saying this request will never be accepted.
      retryable: statusCode === 408 || statusCode === 429 || statusCode >= 500,
      statusCode,
      durationMs: elapsed(),
      failureReason: `HTTP ${String(statusCode)}${excerpt ? `: ${excerpt}` : ''}`,
      retryAfterSeconds: parseRetryAfter(response.headers['retry-after']),
    });
  } catch (error) {
    const code = errorCodeOf(error);

    if (code === 'SITEOPS_BLOCKED_ADDRESS') {
      return failed({ retryable: false, durationMs: elapsed(), failureReason: BLOCKED_REASON });
    }

    if (controller.signal.aborted || (code !== undefined && TIMEOUT_CODES.has(code))) {
      return failed({
        retryable: true,
        durationMs: elapsed(),
        failureReason: `No answer within ${String(input.timeoutMs)} ms.`,
      });
    }

    // DNS, refused, reset: all things a receiver's outage looks like, and all
    // worth another attempt once it has had time to come back.
    return failed({
      retryable: true,
      durationMs: elapsed(),
      failureReason: `Could not connect${code ? ` (${code})` : ''}.`,
    });
  } finally {
    clearTimeout(timer);
    await closeDispatcher(dispatcher);
  }
}

function failed(outcome: {
  readonly retryable: boolean;
  readonly durationMs: number;
  readonly failureReason: string;
  readonly statusCode?: number;
  readonly retryAfterSeconds?: number | null;
}): ChannelResponse {
  return {
    delivered: false,
    retryable: outcome.retryable,
    statusCode: outcome.statusCode ?? null,
    durationMs: outcome.durationMs,
    failureReason: outcome.failureReason,
    retryAfterSeconds: outcome.retryAfterSeconds ?? null,
  };
}

/** One printable line of a response body, for a person reading the delivery log. */
function toExcerpt(text: string): string {
  // Control characters from a hostile body must not reach a log line or a
  // table cell as anything but spaces.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const printable = text.replace(/[\x00-\x1F\x7F]+/g, ' ').trim();
  return printable.length <= RESPONSE_EXCERPT_CHARS
    ? printable
    : `${printable.slice(0, RESPONSE_EXCERPT_CHARS - 1)}…`;
}

/**
 * Reads `Retry-After` as either delta-seconds or an HTTP date.
 *
 * Null for anything else. A receiver's hint is honoured, but only as a lower
 * bound on the retry schedule — see the delivery job — so a malformed or
 * absurd value can delay nothing.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  // An HTTP date always names a day and a month. Without that check
  // `Date.parse` happily reads "-5" as a year, and a nonsense header would
  // quietly become an instruction.
  if (!/[A-Za-z]/.test(trimmed)) return null;

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}
