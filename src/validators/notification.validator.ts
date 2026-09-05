import { updateNotificationPreferencesSchema } from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';

export const notificationValidators = {
  update: { body: updateNotificationPreferencesSchema } satisfies ValidationSchemas,
} as const;
