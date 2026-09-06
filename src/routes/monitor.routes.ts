import { Router } from 'express';

import { MonitorConfigController } from '../controllers/monitor-config.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { monitorValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

/**
 * The auxiliary monitors: SSL, domain, performance, content, SEO and links.
 *
 * Addressed by `(websiteId, type)` rather than by monitor id, because a monitor
 * is conceptually a property of the website — every website has all six, most
 * of them off — and whether a document exists yet is storage detail the client
 * should not have to know.
 *
 * Reading is `monitoring:read`; changing configuration is `monitoring:toggle`,
 * the same capability as pausing uptime checks. Turning off a certificate
 * warning is the same kind of act as silencing an outage alert.
 */
export function monitorRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const monitors = new MonitorConfigController(dependencies.monitorConfigService);

  router.get(
    '/websites/:websiteId/monitors',
    auth,
    validate(monitorValidators.list),
    requireOrganization(dependencies.organizations, 'monitoring:read'),
    asyncHandler(monitors.list),
  );

  router.patch(
    '/websites/:websiteId/monitors/:type',
    auth,
    validate(monitorValidators.update),
    requireOrganization(dependencies.organizations, 'monitoring:toggle'),
    asyncHandler(monitors.update),
  );

  /*
   * Rate limited well below the general allowance. This is the one route that
   * lets a signed-in user aim work at a third party's server on demand, and a
   * crawl is the most expensive thing SiteOps does to anyone.
   */
  router.post(
    '/websites/:websiteId/monitors/:type/run',
    auth,
    rateLimit({ limit: 20, windowSeconds: 3600, scope: 'monitor-run' }),
    validate(monitorValidators.runNow),
    requireOrganization(dependencies.organizations, 'monitoring:toggle'),
    asyncHandler(monitors.runNow),
  );

  router.get(
    '/monitors/:monitorId/results',
    auth,
    validate(monitorValidators.results),
    requireOrganization(dependencies.organizations, 'monitoring:read'),
    asyncHandler(monitors.results),
  );

  router.get(
    '/monitors/summary',
    auth,
    requireOrganization(dependencies.organizations, 'monitoring:read'),
    asyncHandler(monitors.summary),
  );

  return router;
}
