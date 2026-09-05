import type { NextFunction, Request, Response } from 'express';

import { ApiError } from '../errors/ApiError.js';

/**
 * Turns an unmatched path into the documented envelope.
 *
 * Registered after every route so Express never falls through to its own HTML
 * error page — which, outside production, prints a stack trace.
 */
export function notFoundHandler(_request: Request, _response: Response, next: NextFunction): void {
  next(ApiError.notFound('NOT_FOUND', 'Not found.'));
}
