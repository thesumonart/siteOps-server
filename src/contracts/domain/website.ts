/**
 * Operational status of a website as shown in the dashboard.
 *
 * `unknown` is the state of a newly added website that has not completed its
 * first check yet — it is never used to mean "error".
 */
export const WEBSITE_STATUSES = ['operational', 'degraded', 'down', 'paused', 'unknown'] as const;

export type WebsiteStatus = (typeof WEBSITE_STATUSES)[number];

export interface WebsiteStatusPresentation {
  readonly label: string;
  /** Screen-reader text; never rely on colour alone to convey status. */
  readonly description: string;
}

export const WEBSITE_STATUS_PRESENTATION: Record<WebsiteStatus, WebsiteStatusPresentation> = {
  operational: { label: 'Operational', description: 'Responding normally' },
  degraded: { label: 'Degraded', description: 'Responding slowly or intermittently' },
  down: { label: 'Down', description: 'Not responding' },
  paused: { label: 'Paused', description: 'Monitoring is paused' },
  unknown: { label: 'Unknown', description: 'Awaiting the first check' },
};

/** Monitoring intervals offered to users, in seconds. */
export const MONITORING_INTERVALS_SECONDS = [60, 300, 900, 1800, 3600] as const;

export type MonitoringIntervalSeconds = (typeof MONITORING_INTERVALS_SECONDS)[number];

export const MONITORING_INTERVAL_LABELS: Record<MonitoringIntervalSeconds, string> = {
  60: 'Every minute',
  300: 'Every 5 minutes',
  900: 'Every 15 minutes',
  1800: 'Every 30 minutes',
  3600: 'Every hour',
};

export const DEFAULT_MONITORING_INTERVAL_SECONDS = 300 satisfies MonitoringIntervalSeconds;

export const MIN_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A website answering slower than this is reported as `degraded` rather than
 * `operational`. It is a presentation threshold, not a failure condition.
 */
export const DEGRADED_RESPONSE_TIME_MS = 2_000;

export function isWebsiteStatus(value: unknown): value is WebsiteStatus {
  return typeof value === 'string' && WEBSITE_STATUSES.includes(value as WebsiteStatus);
}
