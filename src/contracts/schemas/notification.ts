import { z } from 'zod';

import { INCIDENT_CATEGORIES } from '../domain/incident.js';
import { PREFERENCE_FIELDS, type PreferenceField } from '../domain/notification.js';
import { cursorPaginationQuerySchema } from './common.js';

/**
 * Generated from the contract's field list rather than written out, so a new
 * preference cannot exist in the model and be silently unvalidated here — which
 * would let it through unchecked or reject it as unknown, depending on the day.
 */
export const notificationPreferencesSchema = z.object(
  Object.fromEntries(PREFERENCE_FIELDS.map((field) => [field, z.boolean()])) as Record<
    PreferenceField,
    z.ZodBoolean
  >,
);

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
  category: z.enum(INCIDENT_CATEGORIES).optional(),
  websiteId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid identifier.')
    .optional(),
});

export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>;
