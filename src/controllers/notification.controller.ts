import type { Request, Response } from 'express';

import type { UpdateNotificationPreferencesInput } from '../contracts/index.js';
import { currentUser } from '../middlewares/auth.middleware.js';
import { currentOrganization } from '../middlewares/organization.middleware.js';
import { validatedBody } from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { NotificationService } from '../services/notification.service.js';

/**
 * Alert preferences for the signed-in user.
 *
 * The user is taken from the session, never from a parameter: a member must not
 * be able to change what a colleague is alerted about, and there is no route
 * shape here that would let them try.
 */
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  get = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);

    ApiResponse.ok(response, await this.notifications.get(organization, user.id));
  };

  update = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const input = validatedBody<UpdateNotificationPreferencesInput>(request);

    ApiResponse.ok(response, await this.notifications.update(organization, user.id, input));
  };
}
