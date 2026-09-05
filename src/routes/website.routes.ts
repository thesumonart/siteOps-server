import { Router } from 'express';

import { MonitorController } from '../controllers/monitor.controller.js';
import { WebsiteController } from '../controllers/website.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { websiteValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

/**
 * Websites and their monitoring switch.
 *
 * The organization comes from `X-Organization-Id` here rather than the path —
 * these routes address a website, not an organization — and
 * `requireOrganization` re-resolves membership from the session either way, so
 * the header is a hint and never a credential.
 */
export function websiteRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const websites = new WebsiteController(dependencies.websiteService);
  const monitors = new MonitorController(dependencies.monitorService, dependencies.websiteService);

  router.get(
    '/websites',
    auth,
    validate(websiteValidators.list),
    requireOrganization(dependencies.organizations, 'website:read'),
    asyncHandler(websites.list),
  );

  router.post(
    '/websites',
    auth,
    rateLimit({ limit: 60, windowSeconds: 3600, scope: 'website-create' }),
    validate(websiteValidators.create),
    requireOrganization(dependencies.organizations, 'website:create'),
    asyncHandler(websites.create),
  );

  router.get(
    '/websites/:websiteId',
    auth,
    validate(websiteValidators.getById),
    requireOrganization(dependencies.organizations, 'website:read'),
    asyncHandler(websites.getById),
  );

  router.patch(
    '/websites/:websiteId',
    auth,
    validate(websiteValidators.update),
    requireOrganization(dependencies.organizations, 'website:update'),
    asyncHandler(websites.update),
  );

  router.delete(
    '/websites/:websiteId',
    auth,
    validate(websiteValidators.remove),
    requireOrganization(dependencies.organizations, 'website:delete'),
    asyncHandler(websites.remove),
  );

  // `monitoring:toggle`, not `website:update`: pausing alerts for a client site
  // is a different act from renaming it, and a role can be given one without
  // the other.
  router.post(
    '/websites/:websiteId/pause',
    auth,
    validate(websiteValidators.toggleMonitoring),
    requireOrganization(dependencies.organizations, 'monitoring:toggle'),
    asyncHandler(monitors.pause),
  );

  router.post(
    '/websites/:websiteId/resume',
    auth,
    validate(websiteValidators.toggleMonitoring),
    requireOrganization(dependencies.organizations, 'monitoring:toggle'),
    asyncHandler(monitors.resume),
  );

  return router;
}
