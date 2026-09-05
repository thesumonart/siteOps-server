import type { ApiErrorCode, ApiErrorResponse } from '../contracts/index.js';

/**
 * Translation from Better Auth's error vocabulary to the documented SiteOps
 * one.
 *
 * Kept free of imports with side effects (config, logging) so it can be
 * unit-tested on its own — this mapping *is* the API's error contract for
 * every authentication route.
 */

/** Better Auth error codes mapped onto the documented SiteOps codes. */
const CODE_MAP: Readonly<Record<string, ApiErrorCode>> = {
  INVALID_EMAIL_OR_PASSWORD: 'INVALID_CREDENTIALS',
  INVALID_PASSWORD: 'INVALID_CREDENTIALS',
  USER_NOT_FOUND: 'INVALID_CREDENTIALS',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  USER_ALREADY_EXISTS: 'EMAIL_ALREADY_REGISTERED',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'EMAIL_ALREADY_REGISTERED',
  PASSWORD_TOO_SHORT: 'VALIDATION_ERROR',
  PASSWORD_TOO_LONG: 'VALIDATION_ERROR',
  INVALID_EMAIL: 'VALIDATION_ERROR',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  SESSION_EXPIRED: 'UNAUTHENTICATED',
  FAILED_TO_CREATE_USER: 'INTERNAL_ERROR',
};

const CODE_BY_STATUS: Readonly<Record<number, ApiErrorCode>> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * User-facing wording. Sign-in failures are deliberately identical whether the
 * account exists or the password is wrong, so the endpoint cannot be used to
 * enumerate registered addresses.
 */
const MESSAGE_MAP: Partial<Readonly<Record<ApiErrorCode, string>>> = {
  INVALID_CREDENTIALS: 'That email address and password do not match an account.',
  EMAIL_NOT_VERIFIED: 'Confirm your email address before signing in.',
  EMAIL_ALREADY_REGISTERED: 'An account already exists for that email address.',
  INVALID_TOKEN: 'This link is not valid. Request a new one.',
  TOKEN_EXPIRED: 'This link has expired. Request a new one.',
  UNAUTHENTICATED: 'You must be signed in to do that.',
  FORBIDDEN: 'You do not have permission to do that.',
  RATE_LIMITED: 'Too many attempts. Try again shortly.',
  VALIDATION_ERROR: 'Check the details you entered and try again.',
  CONFLICT: 'That conflicts with something that already exists.',
  NOT_FOUND: 'Not found.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
};

const FALLBACK_MESSAGE = 'The request could not be completed.';

export interface BetterAuthErrorBody {
  readonly code?: unknown;
  readonly message?: unknown;
}

/** Exported for testing: this mapping is the API's error contract for auth. */
export function toApiError(status: number, body: BetterAuthErrorBody): ApiErrorResponse {
  const rawCode = typeof body.code === 'string' ? body.code : undefined;
  const code: ApiErrorCode =
    (rawCode ? CODE_MAP[rawCode] : undefined) ?? CODE_BY_STATUS[status] ?? 'INTERNAL_ERROR';

  /*
   * The upstream message is deliberately discarded rather than used as a
   * fallback. It is not written for end users and, for an unmapped internal
   * failure, can carry a driver error or a connection string — which must never
   * reach a client. The code is what callers branch on; the wording is ours.
   */
  const message = MESSAGE_MAP[code] ?? FALLBACK_MESSAGE;

  return { success: false, error: { code, message } };
}
