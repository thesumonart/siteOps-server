import { Router } from 'express';

import { ClientController } from '../controllers/client.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { clientValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

/**
 * Agency clients.
 *
 * Every route here requires `client:read` or `client:manage`, and **a client
 * contact holds neither**. That is the whole point: a client must not be able
 * to enumerate the agency's other clients, and the cleanest way to guarantee
 * that is for the capability simply not to exist in their role.
 */
export function clientRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const clients = new ClientController(dependencies.clientService);

  router.get(
    '/clients',
    auth,
    validate(clientValidators.list),
    requireOrganization(dependencies.organizations, 'client:read'),
    asyncHandler(clients.list),
  );

  router.post(
    '/clients',
    auth,
    validate(clientValidators.create),
    requireOrganization(dependencies.organizations, 'client:manage'),
    asyncHandler(clients.create),
  );

  router.get(
    '/clients/:clientId',
    auth,
    validate(clientValidators.getById),
    requireOrganization(dependencies.organizations, 'client:read'),
    asyncHandler(clients.getById),
  );

  router.patch(
    '/clients/:clientId',
    auth,
    validate(clientValidators.update),
    requireOrganization(dependencies.organizations, 'client:manage'),
    asyncHandler(clients.update),
  );

  router.delete(
    '/clients/:clientId',
    auth,
    validate(clientValidators.remove),
    requireOrganization(dependencies.organizations, 'client:manage'),
    asyncHandler(clients.remove),
  );

  router.get(
    '/clients/:clientId/contacts',
    auth,
    validate(clientValidators.listContacts),
    requireOrganization(dependencies.organizations, 'client:manage'),
    asyncHandler(clients.listContacts),
  );

  /*
   * Sending an invitation sends an email, so it carries a tighter budget than
   * the general allowance — the limit protects the sending reputation of the
   * domain as much as it protects the organization.
   */
  router.post(
    '/clients/:clientId/contacts',
    auth,
    rateLimit({ limit: 20, windowSeconds: 3600, scope: 'client-invite' }),
    validate(clientValidators.inviteContact),
    requireOrganization(dependencies.organizations, 'client:manage'),
    asyncHandler(clients.inviteContact),
  );

  router.delete(
    '/clients/:clientId/contacts/:contactId',
    auth,
    validate(clientValidators.revokeContact),
    requireOrganization(dependencies.organizations, 'client:manage'),
    asyncHandler(clients.revokeContact),
  );

  return router;
}
