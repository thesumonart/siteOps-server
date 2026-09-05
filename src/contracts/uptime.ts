/**
 * Uptime and response-time arithmetic.
 *
 * Kept free of database and framework types so the API, the worker and the
 * test-suite all agree on what "99.98%" means.
 */

export interface CheckSample {
  readonly successful: boolean;
  readonly responseTimeMs: number | null;
}

export interface CheckAggregate {
  readonly totalChecks: number;
  readonly successfulChecks: number;
  readonly failedChecks: number;
  readonly uptimePercentage: number | null;
  readonly averageResponseTimeMs: number | null;
  readonly fastestResponseTimeMs: number | null;
  readonly slowestResponseTimeMs: number | null;
}

/**
 * Rounds to two decimals, which is the precision the dashboard renders.
 *
 * Uptime is deliberately floored at the second decimal rather than rounded up:
 * showing "100%" for a website that had a failed check erodes trust in every
 * other number on the page.
 */
export function roundUptimePercentage(value: number): number {
  const scaled = Math.floor(value * 100) / 100;
  return Number(scaled.toFixed(2));
}

export function calculateUptimePercentage(
  successfulChecks: number,
  totalChecks: number,
): number | null {
  if (totalChecks <= 0) return null;
  if (successfulChecks >= totalChecks) return 100;
  return roundUptimePercentage((successfulChecks / totalChecks) * 100);
}

/**
 * Aggregates raw samples. Response-time statistics ignore failed checks, whose
 * duration measures how long a failure took rather than how fast the site is.
 */
export function aggregateChecks(samples: readonly CheckSample[]): CheckAggregate {
  let successfulChecks = 0;
  let responseTimeTotal = 0;
  let responseTimeCount = 0;
  let fastest: number | null = null;
  let slowest: number | null = null;

  for (const sample of samples) {
    if (!sample.successful) continue;
    successfulChecks += 1;

    const responseTime = sample.responseTimeMs;
    if (responseTime === null) continue;

    responseTimeTotal += responseTime;
    responseTimeCount += 1;
    if (fastest === null || responseTime < fastest) fastest = responseTime;
    if (slowest === null || responseTime > slowest) slowest = responseTime;
  }

  const totalChecks = samples.length;
  return {
    totalChecks,
    successfulChecks,
    failedChecks: totalChecks - successfulChecks,
    uptimePercentage: calculateUptimePercentage(successfulChecks, totalChecks),
    averageResponseTimeMs:
      responseTimeCount > 0 ? Math.round(responseTimeTotal / responseTimeCount) : null,
    fastestResponseTimeMs: fastest,
    slowestResponseTimeMs: slowest,
  };
}

/**
 * Estimates downtime from check counts rather than incident timestamps.
 *
 * Each failed check stands for one monitoring interval of unavailability, which
 * is the best resolution polling can give. Incident durations remain the exact
 * figure and are what the incident pages display.
 */
export function estimateDowntimeSeconds(
  failedChecks: number,
  monitoringIntervalSeconds: number,
): number {
  if (failedChecks <= 0 || monitoringIntervalSeconds <= 0) return 0;
  return failedChecks * monitoringIntervalSeconds;
}

/**
 * Picks a chart bucket size that keeps a range readable: roughly 24-60 points
 * regardless of how much history is requested.
 */
export function bucketSizeSecondsFor(rangeHours: number): number {
  if (rangeHours <= 24) return 60 * 60;
  if (rangeHours <= 24 * 7) return 4 * 60 * 60;
  return 24 * 60 * 60;
}

/** Formats a duration for incident lists: `4m 12s`, `2h 05m`, `1d 3h`. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const seconds = Math.floor(totalSeconds);

  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Formats a response time the way the dashboard shows it: `243 ms` or `1.8 s`. */
export function formatResponseTime(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

export function formatUptimePercentage(value: number | null): string {
  if (value === null) return '—';
  return `${value.toFixed(2)}%`;
}
