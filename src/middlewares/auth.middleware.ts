import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ApiError } from '../errors/ApiError.js';
import type { AuthService } from '../services/auth.service.js';
import type { AuthenticatedUser } from '../types/auth.types.js';

/**
 * Resolves the session and refuses the request when there is none.
 *
 * Applied per route rather than globally-with-exceptions. The trade-off is
 * deliberate: a global guard fails safe when a route forgets to opt in, but it
 * also means the security posture of a route is invisible at the route table.
 * Here every route states what it needs on the line that declares it, and the
 * router tests assert that no route is missing it — so a forgotten guard is
 * caught by a failing test rather than by a reviewer noticing an absence.
 */
export function requireAuth(authService: AuthService): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction): void => {
    authService
      .requireSession(request.headers)
      .then((context) => {
        request.auth = context;
        next();
      })
      .catch(next);
  };
}

/**
 * The authenticated user, for a handler running behind {@link requireAuth}.
 *
 * Throws rather than returning undefined when no session is present: reaching
 * this on a route that skipped the middleware is a wiring bug, and returning
 * undefined would let it surface later as a confusing tenant-scoping failure.
 */
export function currentUser(request: Request): AuthenticatedUser {
  if (!request.auth) throw ApiError.unauthenticated();
  return request.auth.user;
}
