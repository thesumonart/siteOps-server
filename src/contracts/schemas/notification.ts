import { z } from 'zod';

import { cursorPaginationQuerySchema } from './common.js';

export const notificationPreferencesSchema = z.object({
  websiteDown: z.boolean(),
  websiteRecovered: z.boolean(),
});

export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferencesSchema = notificationPreferencesSchema.partial();

export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesSchema
>;

export const listNotificationsQuerySchema = cursorPaginationQuerySchema.extend({
  unreadOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const listIncidentsQuerySchema = cursorPaginationQuerySchema.extend({
  status: z.enum(['open', 'resolved']).optional(),
  websiteId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid identifier.')
    .optional(),
});

export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>;
