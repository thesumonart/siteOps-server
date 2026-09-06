import {
  isSuccessfulHttpStatus,
  type CheckErrorType,
  type CheckStatus,
} from '../contracts/index.js';
import { request } from 'undici';

import { closeDispatcher, createGuardedDispatcher, validateHopUrl } from './safe-request.js';

/**
 * Performs one monitoring request.
 *
 * Two things make this safe rather than an open proxy:
 *
 *  1. The socket's DNS lookup is replaced with one that only returns addresses
 *     the guard has approved, so the connection lands on a validated IP.
 *  2. Redirects are followed by hand rather than by the HTTP client, so every
 *     hop is re-validated — both its URL string and, through the lookup, the
 *     address it resolves to. A public URL that 302s into cloud metadata is
 *     refused mid-chain.
 *
 * Both live in `safe-request.ts` and are shared with the page fetcher the
 * auxiliary monitors use. A second implementation of the SSRF boundary would be
 * a second thing to get wrong.
 */

export interface CheckOptions {
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  /** Test-only: see AddressGuardOptions. Refused in production at startup. */
  readonly allowLoopback: boolean;
  readonly userAgent: string;
}

export interface CheckOutcome {
  readonly status: CheckStatus;
  readonly statusCode: number | null;
  /** Milliseconds until response headers arrived. */
  readonly responseTimeMs: number | null;
  readonly errorType: CheckErrorType | null;
  readonly errorMessage: string | null;
  readonly redirectCount: number;
  readonly finalUrl: string;
}

const MAX_ERROR_MESSAGE_LENGTH = 500;

/** Node and undici error codes mapped to the closed set the UI understands. */
const ERROR_CODE_MAP: Readonly<Record<string, CheckErrorType>> = {
  SITEOPS_BLOCKED_ADDRESS: 'blocked_target',
  ENOTFOUND: 'dns_failure',
  EAI_AGAIN: 'dns_failure',
  ECONNREFUSED: 'connection_refused',
  ECONNRESET: 'connection_reset',
  EPIPE: 'connection_reset',
  // undici reports a server that closes the connection mid-request as
  // UND_ERR_SOCKET rather than surfacing the underlying ECONNRESET — the
  // common shape of a crashed application server or an overloaded proxy.
  UND_ERR_SOCKET: 'connection_reset',
  ETIMEDOUT: 'timeout',
  UND_ERR_CONNECT_TIMEOUT: 'timeout',
  UND_ERR_HEADERS_TIMEOUT: 'timeout',
  UND_ERR_BODY_TIMEOUT: 'timeout',
  ABORT_ERR: 'timeout',
  CERT_HAS_EXPIRED: 'ssl_error',
  ERR_TLS_CERT_ALTNAME_INVALID: 'ssl_error',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'ssl_error',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'ssl_error',
  SELF_SIGNED_CERT_IN_CHAIN: 'ssl_error',
  ERR_SSL_WRONG_VERSION_NUMBER: 'ssl_error',
  /*
   * OpenSSL's chain-verification codes, surfaced by Node verbatim. A site
   * serving a leaf certificate without its intermediates is the single most
   * common TLS misconfiguration in the wild — browsers often paper over it
   * from cache, so a monitor that reported it as a generic failure would be
   * unhelpful exactly where it is most useful.
   */
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'ssl_error',
  UNABLE_TO_GET_ISSUER_CERT: 'ssl_error',
  CERT_UNTRUSTED: 'ssl_error',
  CERT_NOT_YET_VALID: 'ssl_error',
  CERT_REVOKED: 'ssl_error',
};

function truncate(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : message;
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Extracts a human-readable message without risking `[object Object]`. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

/**
 * Maps a thrown error onto the check taxonomy, walking the cause chain because
 * undici wraps socket and TLS errors rather than rethrowing them.
 *
 * Exported so the taxonomy can be tested directly. Several of these codes only
 * occur against hosts we cannot conjure locally — an incomplete certificate
 * chain, a revoked certificate — and this project does not point its test
 * suite at real websites to reach them.
 */
export function classifyError(error: unknown): { type: CheckErrorType; message: string } {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const code = errorCodeOf(current);
    if (code && code in ERROR_CODE_MAP) {
      const type = ERROR_CODE_MAP[code];
      if (type) {
        return {
          type,
          message: messageOf(current),
        };
      }
    }
    if (current instanceof Error && current.name === 'AbortError') {
      return { type: 'timeout', message: 'The request timed out.' };
    }
    current = current instanceof Error ? current.cause : undefined;
  }

  return {
    type: 'unknown',
    message: messageOf(error),
  };
}

function statusForError(type: CheckErrorType): CheckStatus {
  return type === 'timeout' ? 'timeout' : type === 'http_error' ? 'down' : 'error';
}

export async function checkWebsite(url: string, options: CheckOptions): Promise<CheckOutcome> {
  const dispatcher = createGuardedDispatcher({
    timeoutMs: options.timeoutMs,
    allowLoopback: options.allowLoopback,
  });

  const startedAt = process.hrtime.bigint();
  let currentUrl = url;
  let redirectCount = 0;

  try {
    for (;;) {
      const validated = validateHopUrl(currentUrl, options.allowLoopback);
      if (!validated.ok) {
        return {
          status: 'error',
          statusCode: null,
          responseTimeMs: null,
          // Whether this is a disallowed *address* (blocked_target) or a
          // malformed/unsupported URL (invalid_url) depends on the actual
          // rejection reason, not on which hop this happened to be — a
          // redirect can land on a blocked target just as easily as the
          // origin URL can.
          errorType: validated.blocked ? 'blocked_target' : 'invalid_url',
          errorMessage: truncate(validated.reason),
          redirectCount,
          finalUrl: currentUrl,
        };
      }
      currentUrl = validated.href;

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, options.timeoutMs);

      try {
        const response = await request(currentUrl, {
          dispatcher,
          method: 'GET',
          // undici's plain `request()` never auto-follows redirects unless a
          // redirect interceptor is installed, which this dispatcher does not
          // have — so every hop naturally lands back here to be re-validated.
          signal: controller.signal,
          headers: {
            'user-agent': options.userAgent,
            accept: '*/*',
            // A monitor should see what a fresh visitor sees.
            'cache-control': 'no-cache',
          },
        });

        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

        // The body is never read — only its availability matters — but it must
        // be discarded or the socket leaks.
        await response.body.dump();

        const isRedirect = response.statusCode >= 300 && response.statusCode < 400;
        const location = response.headers.location;
        const locationValue = Array.isArray(location) ? location[0] : location;

        if (isRedirect && typeof locationValue === 'string' && locationValue.length > 0) {
          if (redirectCount >= options.maxRedirects) {
            return {
              status: 'down',
              statusCode: response.statusCode,
              responseTimeMs: Math.round(elapsedMs),
              errorType: 'too_many_redirects',
              errorMessage: `Stopped after ${options.maxRedirects} redirects.`,
              redirectCount,
              finalUrl: currentUrl,
            };
          }

          redirectCount += 1;
          // Relative locations are resolved against the current hop.
          currentUrl = new URL(locationValue, currentUrl).toString();
          continue;
        }

        const successful = isSuccessfulHttpStatus(response.statusCode);
        return {
          status: successful ? 'up' : 'down',
          statusCode: response.statusCode,
          responseTimeMs: Math.round(elapsedMs),
          errorType: successful ? null : 'http_error',
          errorMessage: successful ? null : `Responded with HTTP ${response.statusCode}.`,
          redirectCount,
          finalUrl: currentUrl,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    const { type, message } = classifyError(error);
    return {
      status: statusForError(type),
      statusCode: null,
      responseTimeMs: null,
      errorType: type,
      errorMessage: truncate(message),
      redirectCount,
      finalUrl: currentUrl,
    };
  } finally {
    await closeDispatcher(dispatcher);
  }
}
