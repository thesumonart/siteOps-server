import { Router } from 'express';

import { ReportGenerationController } from '../controllers/report-generation.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { generatedReportValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

/**
 * Generated reports and the schedules that produce them.
 *
 * Three capabilities rather than one. `report:read` is held by every role,
 * because a member who cannot open the report their team produced is a member
 * who asks somebody else to email it to them. `report:create` is not, because
 * generating one spends the organization's quota and puts real load on the
 * database. `report:manage` covers schedules, which decide what is emailed to a
 * client every month — the highest-consequence thing in this module.
 */
export function reportGenerationRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const reports = new ReportGenerationController(dependencies.reportGenerationService);

  /*
   * Declared before `/reports/:reportId`. Express matches in order, and
   * `schedules` would otherwise be captured as a report id, fail the ObjectId
   * validator and answer 400 instead of listing anything.
   */
  router.get(
    '/reports/schedules',
    auth,
    requireOrganization(dependencies.organizations, 'report:manage'),
    asyncHandler(reports.listSchedules),
  );

  router.post(
    '/reports/schedules',
    auth,
    validate(generatedReportValidators.createSchedule),
    requireOrganization(dependencies.organizations, 'report:manage'),
    asyncHandler(reports.createSchedule),
  );

  router.patch(
    '/reports/schedules/:scheduleId',
    auth,
    validate(generatedReportValidators.updateSchedule),
    requireOrganization(dependencies.organizations, 'report:manage'),
    asyncHandler(reports.updateSchedule),
  );

  router.delete(
    '/reports/schedules/:scheduleId',
    auth,
    validate(generatedReportValidators.removeSchedule),
    requireOrganization(dependencies.organizations, 'report:manage'),
    asyncHandler(reports.removeSchedule),
  );

  router.get(
    '/reports',
    auth,
    validate(generatedReportValidators.list),
    requireOrganization(dependencies.organizations, 'report:read'),
    asyncHandler(reports.list),
  );

  /*
   * Rate limited well below the general allowance. Each request queues a set of
   * aggregations over the largest collections in the product, and a loop
   * pressing this button is the cheapest way for one organization to slow down
   * everybody else's monitoring writes.
   */
  router.post(
    '/reports',
    auth,
    rateLimit({ limit: 30, windowSeconds: 3600, scope: 'report-create' }),
    validate(generatedReportValidators.create),
    requireOrganization(dependencies.organizations, 'report:create'),
    asyncHandler(reports.create),
  );

  router.get(
    '/reports/:reportId',
    auth,
    validate(generatedReportValidators.getById),
    requireOrganization(dependencies.organizations, 'report:read'),
    asyncHandler(reports.getById),
  );

  /*
   * Rendering is cheap — the facts are already stored — but it is not free, and
   * a PDF render is the most CPU any single request in this API performs.
   */
  router.get(
    '/reports/:reportId/download',
    auth,
    rateLimit({ limit: 120, windowSeconds: 3600, scope: 'report-download' }),
    validate(generatedReportValidators.download),
    requireOrganization(dependencies.organizations, 'report:read'),
    asyncHandler(reports.download),
  );

  router.delete(
    '/reports/:reportId',
    auth,
    validate(generatedReportValidators.remove),
    requireOrganization(dependencies.organizations, 'report:manage'),
    asyncHandler(reports.remove),
  );

  return router;
}
