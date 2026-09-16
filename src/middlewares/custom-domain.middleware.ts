import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ApiError } from '../errors/ApiError.js';
import type { CustomDomainResolver } from '../services/custom-domain-resolver.js';

/** The only prefix a customer's domain may reach. */
export const PUBLIC_STATUS_PREFIX = '/api/public/';

/**
 * Recognises requests that arrived on a customer's verified status page domain.
 *
 * On such a request the page is attached, and everything outside the public
 * status endpoints is a 404. That second half is the important one: a domain
 * a customer controls in DNS must never serve sign-in, sessions or the
 * dashboard API. A cookie set there, or a sign-in form reachable there, would
 * be SiteOps's authentication running on somebody else's name.
 *
 * Requests on SiteOps's own hosts skip all of this without a query, and a host
 * that is neither — an internal health-check name, a load balancer address —
 * passes through untouched.
 *
 * Mounted after the health probes and before Better Auth, so it decides before
 * any authentication route can answer.
 */
export function customDomainRouting(resolver: CustomDomainResolver): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction): void => {
    // `hostname` honours `trust proxy`, which is tied to actually running behind
    // one. Without it this is the Host header the client connected with.
    const host = request.hostname;
    if (!host || resolver.isPlatformHost(host)) {
      next();
      return;
    }

    resolver.resolve(host).then(
      (pageId) => {
        if (pageId === null) {
          next();
          return;
        }
        if (!request.path.startsWith(PUBLIC_STATUS_PREFIX)) {
          next(ApiError.notFound('NOT_FOUND', 'Not found.'));
          return;
        }
        request.customDomainStatusPageId = pageId;
        next();
      },
      (error: unknown) => {
        next(error);
      },
    );
  };
}
