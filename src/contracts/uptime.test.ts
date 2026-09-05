import { describe, expect, it } from 'vitest';

import {
  aggregateChecks,
  bucketSizeSecondsFor,
  calculateUptimePercentage,
  estimateDowntimeSeconds,
  formatDuration,
  formatResponseTime,
  formatUptimePercentage,
  type CheckSample,
} from './uptime.js';

const sample = (successful: boolean, responseTimeMs: number | null = 200): CheckSample => ({
  successful,
  responseTimeMs,
});

describe('calculateUptimePercentage', () => {
  it('returns null when there is nothing to measure', () => {
    expect(calculateUptimePercentage(0, 0)).toBeNull();
  });

  it('returns exactly 100 for a perfect window', () => {
    expect(calculateUptimePercentage(288, 288)).toBe(100);
  });

  it('never rounds a single failure up to 100', () => {
    // 9999/10000 is 99.99%; the important property is that it is not 100.
    expect(calculateUptimePercentage(9999, 10_000)).toBe(99.99);
    expect(calculateUptimePercentage(99_999, 100_000)).toBeLessThan(100);
  });

  it('computes typical values to two decimals', () => {
    expect(calculateUptimePercentage(287, 288)).toBe(99.65);
    expect(calculateUptimePercentage(1, 2)).toBe(50);
    expect(calculateUptimePercentage(0, 10)).toBe(0);
  });
});

describe('aggregateChecks', () => {
  it('reports zeroes for an empty window', () => {
    expect(aggregateChecks([])).toEqual({
      totalChecks: 0,
      successfulChecks: 0,
      failedChecks: 0,
      uptimePercentage: null,
      averageResponseTimeMs: null,
      fastestResponseTimeMs: null,
      slowestResponseTimeMs: null,
    });
  });

  it('counts successes and failures', () => {
    const result = aggregateChecks([sample(true), sample(true), sample(false, null)]);
    expect(result.totalChecks).toBe(3);
    expect(result.successfulChecks).toBe(2);
    expect(result.failedChecks).toBe(1);
  });

  it('excludes failed checks from response-time statistics', () => {
    // The failed check took 30s to time out; including it would make the site
    // look far slower than it is.
    const result = aggregateChecks([sample(true, 100), sample(true, 300), sample(false, 30_000)]);
    expect(result.averageResponseTimeMs).toBe(200);
    expect(result.fastestResponseTimeMs).toBe(100);
    expect(result.slowestResponseTimeMs).toBe(300);
  });

  it('tolerates successful checks without a recorded duration', () => {
    const result = aggregateChecks([sample(true, null), sample(true, 250)]);
    expect(result.averageResponseTimeMs).toBe(250);
    expect(result.uptimePercentage).toBe(100);
  });
});

describe('estimateDowntimeSeconds', () => {
  it('multiplies failed checks by the monitoring interval', () => {
    expect(estimateDowntimeSeconds(3, 300)).toBe(900);
  });

  it('returns zero for degenerate input', () => {
    expect(estimateDowntimeSeconds(0, 300)).toBe(0);
    expect(estimateDowntimeSeconds(-1, 300)).toBe(0);
    expect(estimateDowntimeSeconds(3, 0)).toBe(0);
  });
});

describe('bucketSizeSecondsFor', () => {
  it('keeps chart point counts in a readable range', () => {
    expect(bucketSizeSecondsFor(24)).toBe(3600);
    expect(bucketSizeSecondsFor(24 * 7)).toBe(4 * 3600);
    expect(bucketSizeSecondsFor(24 * 30)).toBe(24 * 3600);
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(252)).toBe('4m 12s');
    expect(formatDuration(7500)).toBe('2h 05m');
    expect(formatDuration(97_200)).toBe('1d 3h');
    expect(formatDuration(-1)).toBe('—');
  });

  it('formats response times', () => {
    expect(formatResponseTime(243)).toBe('243 ms');
    expect(formatResponseTime(1800)).toBe('1.8 s');
    expect(formatResponseTime(null)).toBe('—');
  });

  it('formats uptime percentages', () => {
    expect(formatUptimePercentage(100)).toBe('100.00%');
    expect(formatUptimePercentage(99.987)).toBe('99.99%');
    expect(formatUptimePercentage(null)).toBe('—');
  });
});
