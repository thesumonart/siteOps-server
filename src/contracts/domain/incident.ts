export const INCIDENT_STATUSES = ['open', 'resolved'] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/**
 * What kind of problem an incident represents.
 *
 * The first four are availability failures raised by the uptime checker. The
 * rest are raised by the auxiliary monitors and by anomaly detection, and each
 * belongs to a different {@link IncidentCategory} so it can coexist with an
 * outage rather than being suppressed by one.
 */
export const INCIDENT_TYPES = [
  'downtime',
  'timeout',
  'http_error',
  'connection_error',
  'ssl_expiring',
  'ssl_invalid',
  'domain_expiring',
  'performance_degraded',
  'content_changed',
  'seo_regression',
  'broken_links',
  'response_time_anomaly',
] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  downtime: 'Downtime',
  timeout: 'Timeout',
  http_error: 'HTTP error',
  connection_error: 'Connection error',
  ssl_expiring: 'Certificate expiring',
  ssl_invalid: 'Certificate invalid',
  domain_expiring: 'Domain expiring',
  performance_degraded: 'Performance degraded',
  content_changed: 'Content changed',
  seo_regression: 'SEO regression',
  broken_links: 'Broken links',
  response_time_anomaly: 'Response-time anomaly',
};

/**
 * The bucket an incident occupies for deduplication purposes.
 *
 * A website may have at most one *open* incident per category, enforced by a
 * unique partial index. Categories rather than types, because `downtime`,
 * `timeout`, `http_error` and `connection_error` are four descriptions of the
 * same outage — opening one of each for a single failure would be noise — while
 * an expiring certificate and an outage are genuinely separate problems that
 * must be able to be open at the same time.
 */
export const INCIDENT_CATEGORIES = [
  'availability',
  'ssl',
  'domain',
  'performance',
  'content',
  'seo',
  'links',
  'anomaly',
] as const;

export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export const INCIDENT_CATEGORY_LABELS: Record<IncidentCategory, string> = {
  availability: 'Availability',
  ssl: 'SSL',
  domain: 'Domain',
  performance: 'Performance',
  content: 'Content',
  seo: 'SEO',
  links: 'Links',
  anomaly: 'Anomaly',
};

const CATEGORY_BY_TYPE: Record<IncidentType, IncidentCategory> = {
  downtime: 'availability',
  timeout: 'availability',
  http_error: 'availability',
  connection_error: 'availability',
  ssl_expiring: 'ssl',
  ssl_invalid: 'ssl',
  domain_expiring: 'domain',
  performance_degraded: 'performance',
  content_changed: 'content',
  seo_regression: 'seo',
  broken_links: 'links',
  response_time_anomaly: 'anomaly',
};

export function categoryForIncidentType(type: IncidentType): IncidentCategory {
  return CATEGORY_BY_TYPE[type];
}

/**
 * Whether an incident of this kind stops a website counting as available.
 *
 * Uptime percentages and the "down" status card must reflect reachability
 * only. An expiring certificate is urgent, but reporting it as downtime would
 * make every uptime figure in the product wrong.
 */
export function affectsAvailability(category: IncidentCategory): boolean {
  return category === 'availability';
}

/**
 * How urgently an incident should be surfaced.
 *
 * Severity is a property of the incident, not of its category: a certificate
 * with two days left and one with twenty-five are both `ssl`.
 */
export const INCIDENT_SEVERITIES = ['critical', 'warning', 'info'] as const;

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

/**
 * Consecutive failed checks required before an outage is confirmed, and
 * consecutive successful checks required before it is considered resolved.
 *
 * Both exist to absorb transient network noise; see docs/MONITORING.md.
 */
export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_RECOVERY_THRESHOLD = 2;
export const MIN_THRESHOLD = 1;
export const MAX_THRESHOLD = 10;
