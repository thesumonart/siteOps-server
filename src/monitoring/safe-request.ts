import { Agent, request, type Dispatcher } from 'undici';

import { normalizeWebsiteUrl } from '../contracts/index.js';
import { isLoopbackAddress } from './address-guard.js';
import { createSafeLookup } from './safe-lookup.js';

/**
 * Guarded outbound HTTP for everything that fetches a customer-supplied URL.
 *
 * Extracted from `http-checker.ts` when four more monitors needed to fetch
 * pages. The SSRF boundary is the highest-stakes code in this product, and a
 * second implementation of it is a second thing to get wrong — so the hop
 * validation and the guarded dispatcher live here and the uptime checker uses
 * them too.
 *
 * Two layers, both required, neither sufficient alone:
 *
 *  1. **String validation on every hop** ({@link validateHopUrl}). Node's socket
 *     layer skips a custom DNS `lookup` entirely when the host is already an IP
 *     literal — `net.isIP()` short-circuits it — so a redirect straight to
 *     `http://169.254.169.254/` would never reach the lookup at all. This is
 *     what catches that.
 *  2. **Address validation at connect time** (`createSafeLookup`). DNS can
 *     change between validation and connection, and this is the only point
 *     where rebinding can be stopped: the address the guard approves is the
 *     exact address the kernel connects to.
 */

export interface GuardedRequestOptions {
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  /** Test-only: see AddressGuardOptions. Refused in production at startup. */
  readonly allowLoopback: boolean;
  readonly userAgent: string;
}

export type HopValidation =
  | { readonly ok: true; readonly href: string }
  | { readonly ok: false; readonly reason: string; readonly blocked: boolean };

/**
 * Re-checks a URL's *string* form.
 *
 * Run again on every redirect hop, which is the point — a public URL that 302s
 * into cloud metadata is refused mid-chain rather than at the origin.
 */
export function validateHopUrl(url: string, allowLoopback: boolean): HopValidation {
  const normalized = normalizeWebsiteUrl(url);
  if (normalized.ok) return { ok: true, href: normalized.value.href };

  /*
   * In test mode the mock server lives on loopback, which string validation
   * rejects by design. The bypass is intentionally narrow: it re-parses the URL
   * and checks that the *actual resolved hostname* is loopback via the same
   * predicate the connect-time guard uses — never "any blocked reason", which
   * would silently wave through every other private range too. That was the
   * shape of a real SSRF regression caught by this module's own test suite: a
   * first draft bypassed the string check for any `blocked_hostname` /
   * `blocked_ip` reason, which let a redirect to 169.254.169.254 through in
   * test mode.
   */
  if (allowLoopback) {
    try {
      const parsed = new URL(url);
      const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
      const bareHost = parsed.hostname.replace(/^\[|\]$/g, '');
      if (isHttp && (bareHost.toLowerCase() === 'localhost' || isLoopbackAddress(bareHost))) {
        return { ok: true, href: parsed.toString() };
      }
    } catch {
      // Falls through to the rejection below.
    }
  }

  const blocked = normalized.reason === 'blocked_ip' || normalized.reason === 'blocked_hostname';
  return { ok: false, reason: normalized.detail, blocked };
}

/**
 * A connection pool whose DNS lookup refuses non-public addresses.
 *
 * Connections are never reused across checks: a pooled socket would skip the
 * lookup, and with it the address guard, on a later request.
 */
export function createGuardedDispatcher(options: {
  readonly timeoutMs: number;
  readonly allowLoopback: boolean;
}): Agent {
  return new Agent({
    connect: {
      lookup: createSafeLookup({ allowLoopback: options.allowLoopback }),
      timeout: options.timeoutMs,
    },
    headersTimeout: options.timeoutMs,
    bodyTimeout: options.timeoutMs,
    pipelining: 0,
  });
}

/**
 * Tears down a pool without letting the teardown replace the caller's result.
 *
 * A graceful `close()` waits for in-flight requests and can reject when a
 * socket was just aborted. An exception thrown from a `finally` block
 * *replaces* the value the `try` already produced, which would turn a perfectly
 * good "the site is down" into a thrown error the caller has to classify from
 * scratch.
 */
export async function closeDispatcher(dispatcher: Dispatcher): Promise<void> {
  try {
    await dispatcher.close();
  } catch {
    try {
      await dispatcher.destroy();
    } catch {
      // Nothing further can be done, and nothing depends on it.
    }
  }
}

export interface FetchedPage {
  readonly statusCode: number;
  readonly finalUrl: string;
  readonly contentType: string | null;
  /** Decoded body, truncated at the caller's cap. */
  readonly body: string;
  /** Bytes actually read, which is the truncated length when capped. */
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly redirectCount: number;
  /** Milliseconds until response headers arrived. */
  readonly timeToFirstByteMs: number;
  /** Milliseconds until the body finished (or was cut off). */
  readonly totalTimeMs: number;
}

export type FetchOutcome =
  | { readonly ok: true; readonly page: FetchedPage }
  | { readonly ok: false; readonly reason: string; readonly blocked: boolean };

export interface FetchPageOptions extends GuardedRequestOptions {
  /** Hard cap on bytes read from the body. */
  readonly maxBytes: number;
  /** Accept header. Defaults to an HTML-preferring browser-like value. */
  readonly accept?: string;
  /** HEAD instead of GET, for link checking where the body is not wanted. */
  readonly method?: 'GET' | 'HEAD';
  /** Reuses one pool across many fetches; the crawler supplies its own. */
  readonly dispatcher?: Agent;
}

const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/**
 * Fetches one page, following redirects by hand so every hop is re-validated.
 *
 * The body is read in chunks against a hard byte cap. `Content-Length` is not
 * trusted for this: it is supplied by the origin, may be absent on a chunked
 * response, and may simply lie. Counting what actually arrives is the only cap
 * that holds against a hostile or misconfigured server.
 */
export async function fetchPage(url: string, options: FetchPageOptions): Promise<FetchOutcome> {
  const ownDispatcher = options.dispatcher
    ? null
    : createGuardedDispatcher({
        timeoutMs: options.timeoutMs,
        allowLoopback: options.allowLoopback,
      });
  const dispatcher = options.dispatcher ?? ownDispatcher;
  // Unreachable: exactly one of the two is always set.
  if (!dispatcher) return { ok: false, reason: 'No dispatcher available.', blocked: false };

  const startedAt = process.hrtime.bigint();
  let currentUrl = url;
  let redirectCount = 0;

  try {
    for (;;) {
      const validated = validateHopUrl(currentUrl, options.allowLoopback);
      if (!validated.ok) {
        return { ok: false, reason: validated.reason, blocked: validated.blocked };
      }
      currentUrl = validated.href;

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, options.timeoutMs);

      try {
        const response = await request(currentUrl, {
          dispatcher,
          method: options.method ?? 'GET',
          signal: controller.signal,
          headers: {
            'user-agent': options.userAgent,
            accept: options.accept ?? DEFAULT_ACCEPT,
            'accept-language': 'en',
            'cache-control': 'no-cache',
          },
        });

        const timeToFirstByteMs = Math.round(
          Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        );

        const isRedirect = response.statusCode >= 300 && response.statusCode < 400;
        const location = response.headers.location;
        const locationValue = Array.isArray(location) ? location[0] : location;

        if (isRedirect && typeof locationValue === 'string' && locationValue.length > 0) {
          await response.body.dump();

          if (redirectCount >= options.maxRedirects) {
            return {
              ok: false,
              reason: `Stopped after ${String(options.maxRedirects)} redirects.`,
              blocked: false,
            };
          }

          redirectCount += 1;
          currentUrl = new URL(locationValue, currentUrl).toString();
          continue;
        }

        const { text, byteLength, truncated } = await readBounded(response.body, options.maxBytes);

        const contentTypeHeader = response.headers['content-type'];
        const contentType = Array.isArray(contentTypeHeader)
          ? (contentTypeHeader[0] ?? null)
          : (contentTypeHeader ?? null);

        return {
          ok: true,
          page: {
            statusCode: response.statusCode,
            finalUrl: currentUrl,
            contentType,
            body: text,
            byteLength,
            truncated,
            redirectCount,
            timeToFirstByteMs,
            totalTimeMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
          },
        };
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The request failed.';
    const code = errorCodeOf(error);
    return { ok: false, reason, blocked: code === 'SITEOPS_BLOCKED_ADDRESS' };
  } finally {
    if (ownDispatcher) await closeDispatcher(ownDispatcher);
  }
}

function errorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (typeof current === 'object') {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Reads a body up to a byte cap, discarding the rest.
 *
 * The stream is dumped rather than abandoned once the cap is hit, so the socket
 * is released instead of leaking. A truncated HTML document is still useful for
 * SEO and change detection — the head and the opening of the body are where the
 * signals are — and the caller is told it was cut off.
 */
async function readBounded(
  body: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ text: string; byteLength: number; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));

    if (total + buffer.length > maxBytes) {
      chunks.push(buffer.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      break;
    }

    chunks.push(buffer);
    total += buffer.length;
  }

  if (truncated) {
    // Release the socket rather than leaving the rest of the response hanging.
    body.resume();
  }

  return { text: Buffer.concat(chunks).toString('utf8'), byteLength: total, truncated };
}
