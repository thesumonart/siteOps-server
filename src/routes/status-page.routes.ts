import { Router } from 'express';

import { StatusPageController } from '../controllers/status-page.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { statusPageValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

/** Managing status pages, with a session, from the dashboard. */
export function statusPageRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const statusPages = new StatusPageController(dependencies.statusPageService);

  router.get(
    '/status-pages',
    auth,
    requireOrganization(dependencies.organizations, 'status_page:read'),
    asyncHandler(statusPages.list),
  );

  router.post(
    '/status-pages',
    auth,
    validate(statusPageValidators.create),
    requireOrganization(dependencies.organizations, 'status_page:manage'),
    asyncHandler(statusPages.create),
  );

  router.get(
    '/status-pages/:statusPageId',
    auth,
    validate(statusPageValidators.get),
    requireOrganization(dependencies.organizations, 'status_page:read'),
    asyncHandler(statusPages.get),
  );

  router.patch(
    '/status-pages/:statusPageId',
    auth,
    validate(statusPageValidators.update),
    requireOrganization(dependencies.organizations, 'status_page:manage'),
    asyncHandler(statusPages.update),
  );

  router.delete(
    '/status-pages/:statusPageId',
    auth,
    validate(statusPageValidators.delete),
    requireOrganization(dependencies.organizations, 'status_page:manage'),
    asyncHandler(statusPages.delete),
  );

  router.put(
    '/status-pages/:statusPageId/custom-domain',
    auth,
    validate(statusPageValidators.setCustomDomain),
    requireOrganization(dependencies.organizations, 'status_page:manage'),
    asyncHandler(statusPages.setCustomDomain),
  );

  // Each attempt is an outbound DNS query; the budget keeps a stuck "verify"
  // button from becoming a resolver hammer.
  router.post(
    '/status-pages/:statusPageId/custom-domain/verify',
    auth,
    rateLimit({ limit: 30, windowSeconds: 3600, scope: 'custom-domain-verify' }),
    validate(statusPageValidators.customDomain),
    requireOrganization(dependencies.organizations, 'status_page:manage'),
    asyncHandler(statusPages.verifyCustomDomain),
  );

  router.delete(
    '/status-pages/:statusPageId/custom-domain',
    auth,
    validate(statusPageValidators.customDomain),
    requireOrganization(dependencies.organizations, 'status_page:manage'),
    asyncHandler(statusPages.removeCustomDomain),
  );

  return router;
}
