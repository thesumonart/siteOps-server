import { Router, type NextFunction, type Request, type Response } from 'express';

import { env } from '../config/env.js';
import { PublicStatusController } from '../controllers/public-status.controller.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import type { PublicStatusService } from '../services/public-status.service.js';
import { asyncHandler } from '../utils/async-handler.js';
import { publicStatusValidators } from '../validators/index.js';

export interface PublicStatusDependencies {
  readonly publicStatusService: PublicStatusService;
}

/**
 * Anyone may read a published status page, from anywhere.
 *
 * A wildcard origin is safe here and nowhere else in this API, because nothing
 * under this router reads a cookie, a session or a key: there is no ambient
 * authority for a foreign page to borrow. It is only set when the dashboard's
 * allowlist has not already answered, so a trusted origin keeps its exact
 * header rather than getting two.
 */
function allowAnyOrigin(_request: Request, response: Response, next: NextFunction): void {
  if (!response.hasHeader('Access-Control-Allow-Origin')) {
    response.setHeader('Access-Control-Allow-Origin', '*');
  }
  next();
}

/** Mounted at `/api/public`, outside the session-authenticated router. */
export function publicStatusRoutes(dependencies: PublicStatusDependencies): Router {
  const router = Router();
  const controller = new PublicStatusController(
    dependencies.publicStatusService,
    env.STATUS_PAGE_CACHE_TTL_SECONDS,
  );

  router.use(allowAnyOrigin);
  router.use(
    rateLimit({
      limit: env.PUBLIC_STATUS_RATE_LIMIT_PER_MINUTE,
      windowSeconds: 60,
      scope: 'public-status',
    }),
  );

  router.get(
    '/status-pages/:slug',
    validate(publicStatusValidators.bySlug),
    asyncHandler(controller.bySlug),
  );

  // On a verified custom domain, the page that domain serves.
  router.get(
    '/status-page',
    validate(publicStatusValidators.forHost),
    asyncHandler(controller.forHost),
  );

  return router;
}
