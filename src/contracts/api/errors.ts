/**
 * Stable, machine-readable error codes returned by the API.
 *
 * The client switches on `code`; `message` is for humans and may be reworded at
 * any time. Nothing here may leak internal details — no driver errors, no
 * stack traces, no file paths.
 */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',

  'EMAIL_ALREADY_REGISTERED',
  'INVALID_CREDENTIALS',
  'EMAIL_NOT_VERIFIED',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',

  'ORGANIZATION_NOT_FOUND',
  'ORGANIZATION_SLUG_TAKEN',
  'NOT_A_MEMBER',
  'INSUFFICIENT_ROLE',
  'CANNOT_REMOVE_LAST_OWNER',
  'MEMBER_NOT_FOUND',
  'ALREADY_A_MEMBER',

  'WEBSITE_NOT_FOUND',
  'WEBSITE_URL_ALREADY_MONITORED',
  'INVALID_WEBSITE_URL',
  'BLOCKED_WEBSITE_URL',

  'INCIDENT_NOT_FOUND',
  'INCIDENT_ALREADY_RESOLVED',

  'NOTIFICATION_NOT_FOUND',

  'PLAN_LIMIT_REACHED',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiFieldError {
  readonly field: string;
  readonly message: string;
}

export interface ApiErrorBody {
  readonly code: ApiErrorCode;
  readonly message: string;
  /** Present only for `VALIDATION_ERROR`. */
  readonly fields?: readonly ApiFieldError[];
}

export interface ApiErrorResponse {
  readonly success: false;
  readonly error: ApiErrorBody;
}

export interface ApiSuccessResponse<TData> {
  readonly success: true;
  readonly data: TData;
}

export type ApiResponse<TData> = ApiSuccessResponse<TData> | ApiErrorResponse;

export function isApiErrorResponse(value: ApiResponse<unknown>): value is ApiErrorResponse {
  return value.success === false;
}
