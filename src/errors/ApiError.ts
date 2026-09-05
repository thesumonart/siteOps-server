import type { ApiErrorCode, ApiFieldError } from '../contracts/index.js';

/**
 * The only error type application code should throw.
 *
 * Carrying a machine-readable {@link ApiErrorCode} means clients branch on a
 * stable value rather than on prose, and it keeps every failure response in the
 * documented envelope. Anything thrown that is *not* an `ApiError` is treated
 * by the global handler as an internal fault: it is logged in full and answered
 * with a generic 500, so an unexpected failure can never leak its internals.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly fields?: readonly ApiFieldError[];

  constructor(
    statusCode: number,
    message: string,
    code: ApiErrorCode,
    fields?: readonly ApiFieldError[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    if (fields) this.fields = fields;

    // Without this the stack starts at `ApiError`, which is never where the
    // interesting frame is.
    Error.captureStackTrace(this, ApiError);
  }

  static badRequest(code: ApiErrorCode, message: string): ApiError {
    return new ApiError(400, message, code);
  }

  static validation(message: string, fields: readonly ApiFieldError[] = []): ApiError {
    return new ApiError(400, message, 'VALIDATION_ERROR', fields);
  }

  static unauthenticated(message = 'You must be signed in to do that.'): ApiError {
    return new ApiError(401, message, 'UNAUTHENTICATED');
  }

  static forbidden(
    code: Extract<ApiErrorCode, 'FORBIDDEN' | 'NOT_A_MEMBER' | 'INSUFFICIENT_ROLE'> = 'FORBIDDEN',
    message = 'You do not have permission to do that.',
  ): ApiError {
    return new ApiError(403, message, code);
  }

  /**
   * Used for resources that exist but belong to another tenant as well as for
   * resources that do not exist at all. Distinguishing the two would let an
   * attacker enumerate identifiers across organizations.
   */
  static notFound(code: ApiErrorCode, message: string): ApiError {
    return new ApiError(404, message, code);
  }

  static conflict(code: ApiErrorCode, message: string): ApiError {
    return new ApiError(409, message, code);
  }

  static rateLimited(message = 'Too many requests. Try again shortly.'): ApiError {
    return new ApiError(429, message, 'RATE_LIMITED');
  }

  static planLimit(message: string): ApiError {
    return new ApiError(403, message, 'PLAN_LIMIT_REACHED');
  }

  static internal(message = 'Something went wrong. Please try again.'): ApiError {
    return new ApiError(500, message, 'INTERNAL_ERROR');
  }

  static serviceUnavailable(message = 'The service is temporarily unavailable.'): ApiError {
    return new ApiError(503, message, 'SERVICE_UNAVAILABLE');
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
