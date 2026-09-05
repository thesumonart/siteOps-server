import { Router } from 'express';

import { AuthController } from '../controllers/auth.controller.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import type { ApiDependencies } from './index.js';

/**
 * Session introspection.
 *
 * The credential routes — sign-up, sign-in, sign-out, verification, password
 * reset — are not here. They are Better Auth's own handler, mounted ahead of
 * the body parser in `app.ts` because it needs the unparsed request stream.
 *
 * This one route is deliberately unauthenticated: it is how the browser finds
 * out whether it is signed in, and a 401 would make every first paint look like
 * a failure. It answers `{ user: null }` instead. The limit is generous but
 * present, because it is the one endpoint every page load hits.
 */
export function authRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const controller = new AuthController(dependencies.authService);

  router.get(
    '/session',
    rateLimit({ limit: 60, windowSeconds: 60, scope: 'session-read' }),
    asyncHandler(controller.currentSession),
  );

  return router;
}
