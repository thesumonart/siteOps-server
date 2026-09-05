import { Router } from 'express';

import { IncidentController } from '../controllers/incident.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { incidentValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

export function incidentRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const incidents = new IncidentController(dependencies.incidentService);

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

  return router;
}
