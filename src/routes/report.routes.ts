import { Router } from 'express';

import { ReportController } from '../controllers/report.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { reportValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

/**
 * Monitoring history and rollups.
 *
 * The per-website routes share the `/websites` prefix with `website.routes.ts`
 * — they are distinct suffixes, and keeping them here means the website module
 * does not have to depend on the reporting service.
 */
export function reportRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const reports = new ReportController(dependencies.reportService);

  router.get(
    '/websites/:websiteId/stats',
    auth,
    validate(reportValidators.websiteStats),
    requireOrganization(dependencies.organizations, 'monitoring:read'),
    asyncHandler(reports.websiteStats),
  );

  router.get(
    '/websites/:websiteId/uptime',
    auth,
    validate(reportValidators.websiteUptime),
    requireOrganization(dependencies.organizations, 'monitoring:read'),
    asyncHandler(reports.websiteUptime),
  );

  router.get(
    '/websites/:websiteId/checks',
    auth,
    validate(reportValidators.websiteChecks),
    requireOrganization(dependencies.organizations, 'monitoring:read'),
    asyncHandler(reports.websiteChecks),
  );

  router.get(
    '/dashboard/stats',
    auth,
    requireOrganization(dependencies.organizations, 'monitoring:read'),
    asyncHandler(reports.dashboardStats),
  );

  return router;
}
