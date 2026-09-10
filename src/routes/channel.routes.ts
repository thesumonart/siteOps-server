import { Router } from 'express';

import { ChannelController } from '../controllers/channel.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { channelValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

/**
 * Notification channels.
 *
 * Every route needs `integration:read` or `integration:manage`, which admins
 * and owners hold and members and client contacts do not. A channel decides
 * where the whole organization's alerts go, and its URL is a credential.
 */
export function channelRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const channels = new ChannelController(dependencies.channelService);

  router.get(
    '/channels',
    auth,
    requireOrganization(dependencies.organizations, 'integration:read'),
    asyncHandler(channels.list),
  );

  router.post(
    '/channels',
    auth,
    rateLimit({ limit: 30, windowSeconds: 3600, scope: 'channel-create' }),
    validate(channelValidators.create),
    requireOrganization(dependencies.organizations, 'integration:manage'),
    asyncHandler(channels.create),
  );

  router.get(
    '/channels/:channelId',
    auth,
    validate(channelValidators.getById),
    requireOrganization(dependencies.organizations, 'integration:read'),
    asyncHandler(channels.getById),
  );

  router.patch(
    '/channels/:channelId',
    auth,
    validate(channelValidators.update),
    requireOrganization(dependencies.organizations, 'integration:manage'),
    asyncHandler(channels.update),
  );

  router.delete(
    '/channels/:channelId',
    auth,
    validate(channelValidators.remove),
    requireOrganization(dependencies.organizations, 'integration:manage'),
    asyncHandler(channels.remove),
  );

  /*
   * A test makes the server send a request to a URL the caller chose, on
   * demand. The SSRF boundary decides *where* it may go; this budget decides
   * how often, so the endpoint cannot be used to aim traffic at somebody.
   */
  router.post(
    '/channels/:channelId/test',
    auth,
    rateLimit({ limit: 10, windowSeconds: 60, scope: 'channel-test' }),
    validate(channelValidators.test),
    requireOrganization(dependencies.organizations, 'integration:manage'),
    asyncHandler(channels.test),
  );

  router.post(
    '/channels/:channelId/rotate-secret',
    auth,
    rateLimit({ limit: 20, windowSeconds: 3600, scope: 'channel-rotate' }),
    validate(channelValidators.rotateSecret),
    requireOrganization(dependencies.organizations, 'integration:manage'),
    asyncHandler(channels.rotateSecret),
  );

  router.get(
    '/channels/:channelId/deliveries',
    auth,
    validate(channelValidators.deliveries),
    requireOrganization(dependencies.organizations, 'integration:read'),
    asyncHandler(channels.deliveries),
  );

  return router;
}
