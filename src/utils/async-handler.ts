import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Forwards a rejected promise to the error middleware.
 *
 * Express 5 already forwards rejections from an `async` handler, but only for
 * handlers it recognises as returning a promise. Wrapping explicitly makes that
 * guarantee visible at the route table and survives a handler being refactored
 * into something that returns a promise less obviously — a rejection that slips
 * past the error middleware becomes an unhandled rejection and a hung request,
 * which is the worst failure mode an API has.
 */
export function asyncHandler(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (request, response, next) => {
    handler(request, response, next).catch(next);
  };
}
