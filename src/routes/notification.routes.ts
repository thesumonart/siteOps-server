import { Router } from 'express';

import { NotificationController } from '../controllers/notification.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { notificationValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

export function notificationRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const notifications = new NotificationController(dependencies.notificationService);

  router.get(
    '/notification-settings',
    auth,
    requireOrganization(dependencies.organizations, 'notification:read'),
    asyncHandler(notifications.get),
  );

  router.patch(
    '/notification-settings',
    auth,
    validate(notificationValidators.update),
    requireOrganization(dependencies.organizations, 'notification:update'),
    asyncHandler(notifications.update),
  );

  return router;
}
