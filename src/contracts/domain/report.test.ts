import { describe, expect, it } from 'vitest';

import { nextScheduleRun, resolveReportPeriod } from './report.js';

/**
 * Report periods and scheduling arithmetic.
 *
 * Both are pure date maths, and both are the kind of code that is wrong in a
 * way nobody notices for a month — a monthly report that covers the wrong month
 * still looks like a report. The cases below pin down the two properties that
 * matter: calendar periods are calendar periods, and a computed next-run is
 * always strictly in the future.
 */

describe('resolveReportPeriod', () => {
  const now = new Date('2026-03-15T12:00:00Z');

  it('rolls back seven and thirty days for the rolling windows', () => {
    expect(resolveReportPeriod('last_7_days', now).from.toISOString()).toBe(
      '2026-03-08T12:00:00.000Z',
    );
    expect(resolveReportPeriod('last_30_days', now).from.toISOString()).toBe(
      '2026-02-13T12:00:00.000Z',
    );
  });

  it('covers the calendar month that just ended, not the last thirty days', () => {
    // A monthly report sent on 1 April must cover March, not 2 March to 1 April.
    const period = resolveReportPeriod('last_month', new Date('2026-04-01T08:00:00Z'));

    expect(period.from.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-03-31T23:59:59.999Z');
  });

  it('handles a January run rolling back into the previous year', () => {
    const period = resolveReportPeriod('last_month', new Date('2026-01-01T08:00:00Z'));

    expect(period.from.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2025-12-31T23:59:59.999Z');
  });

  it('handles February in a leap year', () => {
    const period = resolveReportPeriod('last_month', new Date('2028-03-01T08:00:00Z'));

    expect(period.to.toISOString()).toBe('2028-02-29T23:59:59.999Z');
  });

  it('covers the previous calendar quarter', () => {
    // Run in April: the quarter that just ended is January to March.
    const period = resolveReportPeriod('last_quarter', new Date('2026-04-05T08:00:00Z'));

    expect(period.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-03-31T23:59:59.999Z');
  });

  it('rolls a first-quarter run back into the previous year', () => {
    const period = resolveReportPeriod('last_quarter', new Date('2026-02-10T08:00:00Z'));

    expect(period.from.toISOString()).toBe('2025-10-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2025-12-31T23:59:59.999Z');
  });
});

describe('nextScheduleRun', () => {
  it('lands on the chosen weekday at the chosen hour', () => {
    // Sunday 2026-03-15. Next Monday 09:00 is the 16th.
    const next = nextScheduleRun('weekly', 9, 1, new Date('2026-03-15T12:00:00Z'));

    expect(next.toISOString()).toBe('2026-03-16T09:00:00.000Z');
    expect(next.getUTCDay()).toBe(1);
  });

  it('skips to next week when today is the target day but the hour has passed', () => {
    // Monday 14:00, wanting Monday 09:00 — this week's slot is gone.
    const next = nextScheduleRun('weekly', 9, 1, new Date('2026-03-16T14:00:00Z'));

    expect(next.toISOString()).toBe('2026-03-23T09:00:00.000Z');
  });

  it('uses today when the hour is still ahead', () => {
    const next = nextScheduleRun('weekly', 18, 1, new Date('2026-03-16T09:00:00Z'));

    expect(next.toISOString()).toBe('2026-03-16T18:00:00.000Z');
  });

  it('runs a monthly schedule on the first of the next month', () => {
    const next = nextScheduleRun('monthly', 8, 1, new Date('2026-03-15T12:00:00Z'));

    expect(next.toISOString()).toBe('2026-04-01T08:00:00.000Z');
  });

  it('uses today when a monthly schedule is computed on the 1st before its hour', () => {
    const next = nextScheduleRun('monthly', 8, 1, new Date('2026-04-01T06:00:00Z'));

    expect(next.toISOString()).toBe('2026-04-01T08:00:00.000Z');
  });

  it('rolls a December monthly schedule into the new year', () => {
    const next = nextScheduleRun('monthly', 8, 1, new Date('2026-12-20T12:00:00Z'));

    expect(next.toISOString()).toBe('2027-01-01T08:00:00.000Z');
  });

  it('always returns a time strictly in the future', () => {
    /*
     * The property that actually matters. A next-run in the past is claimed
     * again on the very next tick, and the schedule mails the same report in a
     * loop — the worst failure this feature has, because the output goes to a
     * customer's client.
     */
    const moments = [
      '2026-01-01T00:00:00Z',
      '2026-03-16T09:00:00Z',
      '2026-12-31T23:59:59Z',
      '2028-02-29T08:00:00Z',
    ];

    for (const moment of moments) {
      const after = new Date(moment);
      for (let hour = 0; hour < 24; hour += 6) {
        for (let day = 0; day < 7; day += 1) {
          expect(nextScheduleRun('weekly', hour, day, after).getTime()).toBeGreaterThan(
            after.getTime(),
          );
          expect(nextScheduleRun('monthly', hour, day, after).getTime()).toBeGreaterThan(
            after.getTime(),
          );
        }
      }
    }
  });
});
