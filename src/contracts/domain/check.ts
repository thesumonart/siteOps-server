/** Outcome of a single monitoring request. */
export const CHECK_STATUSES = ['up', 'down', 'timeout', 'error'] as const;

export type CheckStatus = (typeof CHECK_STATUSES)[number];

/**
 * Why a check did not succeed. Kept as a closed union so the UI can explain
 * failures without parsing free-text error messages.
 */
export const CHECK_ERROR_TYPES = [
  'dns_failure',
  'connection_refused',
  'connection_reset',
  'timeout',
  'ssl_error',
  'too_many_redirects',
  'blocked_target',
  'invalid_url',
  'http_error',
  'unknown',
] as const;

export type CheckErrorType = (typeof CHECK_ERROR_TYPES)[number];

export const CHECK_ERROR_LABELS: Record<CheckErrorType, string> = {
  dns_failure: 'DNS lookup failed',
  connection_refused: 'Connection refused',
  connection_reset: 'Connection reset',
  timeout: 'Request timed out',
  ssl_error: 'TLS/SSL error',
  too_many_redirects: 'Too many redirects',
  blocked_target: 'Target address is not permitted',
  invalid_url: 'Invalid URL',
  http_error: 'Unsuccessful HTTP status',
  unknown: 'Unknown error',
};

export function isSuccessfulCheck(status: CheckStatus): boolean {
  return status === 'up';
}

/**
 * HTTP statuses in [200, 400) count as up. Redirects are followed by the
 * checker, so a 3xx reaching this function means redirects were exhausted.
 */
export function isSuccessfulHttpStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 400;
}

/**
 * Windows the dashboard can summarise. Kept closed so a caller cannot ask for
 * an arbitrary range and scan the whole check history.
 */
export const STATS_RANGES = ['24h', '7d', '30d'] as const;

export type StatsRange = (typeof STATS_RANGES)[number];

export const STATS_RANGE_HOURS: Record<StatsRange, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

export const STATS_RANGE_LABELS: Record<StatsRange, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};
