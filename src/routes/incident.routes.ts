import { Router } from 'express';

import { IncidentAnalysisController } from '../controllers/incident-analysis.controller.js';
import { IncidentController } from '../controllers/incident.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { incidentValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

export function incidentRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const incidents = new IncidentController(dependencies.incidentService);
  const analyses = new IncidentAnalysisController(dependencies.incidentAnalysisService);

  router.get(
    '/incidents',
    auth,
    validate(incidentValidators.list),
    requireOrganization(dependencies.organizations, 'incident:read'),
    asyncHandler(incidents.list),
  );

  router.get(
    '/incidents/:incidentId',
    auth,
    validate(incidentValidators.getById),
    requireOrganization(dependencies.organizations, 'incident:read'),
    asyncHandler(incidents.getById),
  );

  // Closing an incident by hand needs `incident:update`, which members do not
  // have: it changes the outage record everyone else reads.
  router.post(
    '/incidents/:incidentId/resolve',
    auth,
    validate(incidentValidators.resolve),
    requireOrganization(dependencies.organizations, 'incident:update'),
    asyncHandler(incidents.resolve),
  );

  router.get(
    '/incidents/:incidentId/analysis',
    auth,
    validate(incidentValidators.getById),
    requireOrganization(dependencies.organizations, 'incident:read'),
    asyncHandler(analyses.get),
  );

  // Asking for an analysis spends the plan's monthly allowance and a provider
  // call, so it takes the same permission as changing the incident, and a
  // budget of its own.
  router.post(
    '/incidents/:incidentId/analysis',
    auth,
    rateLimit({ limit: 20, windowSeconds: 3600, scope: 'incident-analysis' }),
    validate(incidentValidators.getById),
    requireOrganization(dependencies.organizations, 'incident:update'),
    asyncHandler(analyses.request),
  );

  return router;
}
