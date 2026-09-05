export const INCIDENT_STATUSES = ['open', 'resolved'] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_TYPES = ['downtime', 'timeout', 'http_error', 'connection_error'] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  downtime: 'Downtime',
  timeout: 'Timeout',
  http_error: 'HTTP error',
  connection_error: 'Connection error',
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
