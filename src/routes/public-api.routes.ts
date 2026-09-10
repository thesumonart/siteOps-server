import { Router } from 'express';

import { PublicApiController } from '../controllers/public-api.controller.js';
import {
  apiKeyRateLimit,
  apiQuota,
  requireApiKey,
  requireScope,
} from '../middlewares/api-key.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { incidentValidators, reportValidators, websiteValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

/**
 * The public API, mounted at `/api/v1`.
 *
 * Versioned where the dashboard's `/api` is not, because the two have
 * different clients. The dashboard ships with the API and changes with it;
 * somebody's script written against this surface does not, so it gets a
 * version to pin to, and `v2` can be mounted beside it when a breaking change
 * is genuinely needed.
 *
 * Every request passes three gates before a route sees it, in this order: a
 * valid key, that key's per-minute budget, and the organization's daily quota.
 * A request with no valid key is refused before it costs anything or counts
 * against anybody. Each route then declares the scope it needs on its own line,
 * the same way every dashboard route declares its permission.
 */
export function publicApiRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const api = new PublicApiController(
    dependencies.websiteService,
    dependencies.monitorService,
    dependencies.incidentService,
    dependencies.reportService,
  );

  router.use(
    requireApiKey(dependencies.apiKeyService, dependencies.entitlementService),
    apiKeyRateLimit(),
    apiQuota(dependencies.apiKeyService, dependencies.entitlementService),
  );

  router.get(
    '/monitors',
    requireScope('monitors:read'),
    validate(websiteValidators.list),
    asyncHandler(api.listMonitors),
  );
  router.post(
    '/monitors',
    requireScope('monitors:write'),
    validate(websiteValidators.create),
    asyncHandler(api.createMonitor),
  );
  router.get(
    '/monitors/:websiteId',
    requireScope('monitors:read'),
    validate(websiteValidators.getById),
    asyncHandler(api.getMonitor),
  );
  router.patch(
    '/monitors/:websiteId',
    requireScope('monitors:write'),
    validate(websiteValidators.update),
    asyncHandler(api.updateMonitor),
  );
  router.delete(
    '/monitors/:websiteId',
    requireScope('monitors:write'),
    validate(websiteValidators.remove),
    asyncHandler(api.deleteMonitor),
  );
  router.post(
    '/monitors/:websiteId/pause',
    requireScope('monitors:write'),
    validate(websiteValidators.toggleMonitoring),
    asyncHandler(api.pauseMonitor),
  );
  router.post(
    '/monitors/:websiteId/resume',
    requireScope('monitors:write'),
    validate(websiteValidators.toggleMonitoring),
    asyncHandler(api.resumeMonitor),
  );

  router.get(
    '/monitors/:websiteId/checks',
    requireScope('checks:read'),
    validate(reportValidators.websiteChecks),
    asyncHandler(api.listChecks),
  );
  router.get(
    '/monitors/:websiteId/stats',
    requireScope('metrics:read'),
    validate(reportValidators.websiteStats),
    asyncHandler(api.monitorStats),
  );
  router.get(
    '/monitors/:websiteId/uptime',
    requireScope('metrics:read'),
    validate(reportValidators.websiteUptime),
    asyncHandler(api.monitorUptime),
  );
  router.get('/metrics/summary', requireScope('metrics:read'), asyncHandler(api.summary));

  router.get(
    '/incidents',
    requireScope('incidents:read'),
    validate(incidentValidators.list),
    asyncHandler(api.listIncidents),
  );
  router.get(
    '/incidents/:incidentId',
    requireScope('incidents:read'),
    validate(incidentValidators.getById),
    asyncHandler(api.getIncident),
  );
  router.post(
    '/incidents/:incidentId/resolve',
    requireScope('incidents:write'),
    validate(incidentValidators.resolve),
    asyncHandler(api.resolveIncident),
  );

  return router;
}
