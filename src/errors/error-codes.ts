import type { ApiErrorCode } from '../contracts/index.js';

/**
 * Status-to-code and status-to-message fallbacks.
 *
 * Used only where a failure did not arrive as an {@link ApiError} and therefore
 * carries no code of its own: a framework-raised HTTP error, or an upstream
 * library's error being translated. Application code should always throw an
 * `ApiError` with a specific code instead of relying on these.
 */

export const CODE_BY_STATUS: Readonly<Record<number, ApiErrorCode>> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'VALIDATION_ERROR',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'SERVICE_UNAVAILABLE',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * User-facing wording, keyed by code.
 *
 * Deliberately vague where being specific would help an attacker: a sign-in
 * failure reads the same whether the account exists or the password was wrong,
 * so the endpoint cannot be used to enumerate registered addresses.
 */
export const MESSAGE_BY_CODE: Readonly<Partial<Record<ApiErrorCode, string>>> = {
  VALIDATION_ERROR: 'Check the details you entered and try again.',
  UNAUTHENTICATED: 'You must be signed in to do that.',
  FORBIDDEN: 'You do not have permission to do that.',
  NOT_FOUND: 'Not found.',
  CONFLICT: 'That conflicts with something that already exists.',
  RATE_LIMITED: 'Too many requests. Try again shortly.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable.',

  EMAIL_ALREADY_REGISTERED: 'An account already exists for that email address.',
  INVALID_CREDENTIALS: 'That email address and password do not match an account.',
  EMAIL_NOT_VERIFIED: 'Confirm your email address before signing in.',
  INVALID_TOKEN: 'This link is not valid. Request a new one.',
  TOKEN_EXPIRED: 'This link has expired. Request a new one.',
};

export const FALLBACK_ERROR_MESSAGE = 'The request could not be completed.';

export function codeForStatus(status: number): ApiErrorCode {
  return CODE_BY_STATUS[status] ?? 'INTERNAL_ERROR';
}

export function messageForCode(code: ApiErrorCode): string {
  return MESSAGE_BY_CODE[code] ?? FALLBACK_ERROR_MESSAGE;
}
