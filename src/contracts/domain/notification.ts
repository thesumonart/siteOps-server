import type { MonitorType } from './monitor.js';

/** Events a user can be notified about. */
export const NOTIFICATION_EVENTS = [
  'website.down',
  'website.recovered',
  'incident.created',
  'incident.resolved',
  'monitor.problem',
  'monitor.recovered',
  'anomaly.detected',
  'report.ready',
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_CHANNELS = ['email', 'slack', 'discord', 'webhook'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  email: 'Email',
  slack: 'Slack',
  discord: 'Discord',
  webhook: 'Webhook',
};

export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'suppressed'] as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * Per-user delivery preferences.
 *
 * Everything defaults to on. In a monitoring product a missed alert is a worse
 * outcome than an unwanted one, so silence is always an explicit choice
 * somebody made rather than the consequence of a field nobody set.
 *
 * The monitor toggles are one per {@link MonitorType}, so an agency can be
 * paged about certificates and left alone about SEO scores. Naming them after
 * the monitor rather than after the alert keeps the mapping mechanical: a new
 * monitor type gets one new key and no new dispatch logic.
 */
export interface NotificationPreferences {
  readonly websiteDown: boolean;
  readonly websiteRecovered: boolean;
  readonly monitorSsl: boolean;
  readonly monitorDomain: boolean;
  readonly monitorPerformance: boolean;
  readonly monitorContent: boolean;
  readonly monitorSeo: boolean;
  readonly monitorLinks: boolean;
  readonly anomalyDetected: boolean;
  readonly reportReady: boolean;
}

export type PreferenceField = keyof NotificationPreferences;

/**
 * Every preference key, in the order the settings form renders them.
 *
 * Exported as data so the model, the repository, the validator and the form are
 * all driven by one list. Adding a preference should be one entry here, not a
 * change in five files that can disagree.
 */
export const PREFERENCE_FIELDS: readonly PreferenceField[] = [
  'websiteDown',
  'websiteRecovered',
  'monitorSsl',
  'monitorDomain',
  'monitorPerformance',
  'monitorContent',
  'monitorSeo',
  'monitorLinks',
  'anomalyDetected',
  'reportReady',
];

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  websiteDown: true,
  websiteRecovered: true,
  monitorSsl: true,
  monitorDomain: true,
  monitorPerformance: true,
  monitorContent: true,
  monitorSeo: true,
  monitorLinks: true,
  anomalyDetected: true,
  reportReady: true,
};

export const PREFERENCE_LABELS: Record<PreferenceField, string> = {
  websiteDown: 'A website goes down',
  websiteRecovered: 'A website comes back',
  monitorSsl: 'A certificate is invalid or expiring',
  monitorDomain: 'A domain registration is expiring',
  monitorPerformance: 'Performance drops below the threshold',
  monitorContent: 'Page content changes',
  monitorSeo: 'SEO health regresses',
  monitorLinks: 'A crawl finds broken links',
  anomalyDetected: 'Response times look unusual',
  reportReady: 'A scheduled report is ready',
};

/** The preference that gates alerts from each monitor type. */
export const PREFERENCE_FOR_MONITOR: Record<MonitorType, PreferenceField> = {
  ssl: 'monitorSsl',
  domain: 'monitorDomain',
  performance: 'monitorPerformance',
  content: 'monitorContent',
  seo: 'monitorSeo',
  links: 'monitorLinks',
};
