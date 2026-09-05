/** Events a user can be notified about. */
export const NOTIFICATION_EVENTS = [
  'website.down',
  'website.recovered',
  'incident.created',
  'incident.resolved',
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_CHANNELS = ['email'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'suppressed'] as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * Per-user delivery preferences. Events default to on for outage-related
 * notifications, because silently not alerting is worse than an extra email.
 */
export interface NotificationPreferences {
  readonly websiteDown: boolean;
  readonly websiteRecovered: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  websiteDown: true,
  websiteRecovered: true,
};
