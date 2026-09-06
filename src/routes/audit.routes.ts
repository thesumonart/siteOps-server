import { Router } from 'express';

import { AuditController } from '../controllers/audit.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { auditValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

/**
 * The organization activity feed.
 *
 * Read-only, and gated on `audit_log:read` — a capability admins and owners
 * hold but ordinary members do not, because the feed names who did what and
 * when. There is deliberately no write route: entries are created by services
 * as a side effect of the action they describe, and are removed only by the
 * collection's TTL index.
 */
export function auditRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const audit = new AuditController(dependencies.auditService, dependencies.entitlementService);

  router.get(
    '/audit-logs',
    auth,
    validate(auditValidators.list),
    requireOrganization(dependencies.organizations, 'audit_log:read'),
    asyncHandler(audit.list),
  );

  // Declared after the list route but on a distinct path, so there is no
  // ordering hazard: `actors` is a literal segment, not a parameter.
  router.get(
    '/audit-logs/actors',
    auth,
    requireOrganization(dependencies.organizations, 'audit_log:read'),
    asyncHandler(audit.actors),
  );

  return router;
}
