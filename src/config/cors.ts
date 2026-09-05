import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { trustedOrigins } from './env.js';

/**
 * Cross-origin policy for the dashboard.
 *
 * An explicit allowlist, never a reflected origin: these requests carry the
 * session cookie, so echoing back whatever `Origin` arrives would let any page
 * on the internet act as the signed-in user.
 *
 * Written by hand rather than pulled from the `cors` package — the policy is
 * fifteen lines, it is security-critical enough to want to read in full, and a
 * dependency here would be one more thing between a browser and a session.
 */

const ALLOWED_METHODS = 'GET,POST,PATCH,PUT,DELETE,OPTIONS';

/**
 * `X-Organization-Id` names the organization the UI is currently showing. The
 * API treats it as a hint and re-resolves membership from the session, so it is
 * not a credential and is safe to accept cross-origin.
 */
const ALLOWED_HEADERS = 'Content-Type,Authorization,X-Organization-Id,X-Request-Id';

const EXPOSED_HEADERS = 'X-Request-Id,RateLimit-Limit,RateLimit-Remaining,RateLimit-Reset';

const MAX_AGE_SECONDS = '86400';

export function corsMiddleware(allowed: readonly string[] = trustedOrigins): RequestHandler {
  const allowlist = new Set(allowed);

  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.headers.origin;

    if (typeof origin === 'string' && allowlist.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    }

    // Always sent, even for a rejected origin: a cache that stored one origin's
    // response and replayed it for another would undo the allowlist.
    response.setHeader('Vary', 'Origin');

    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      response.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      response.setHeader('Access-Control-Max-Age', MAX_AGE_SECONDS);
      // 204 with no body. A preflight that reaches a route handler would be
      // rate-limited and authenticated for no reason.
      response.status(204).end();
      return;
    }

    next();
  };
}
