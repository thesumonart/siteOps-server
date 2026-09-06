import { describe, expect, it } from 'vitest';

import { monitorConfigSchema, updateMonitorSchema } from './monitor.js';

/**
 * The monitor configuration union.
 *
 * These values decide how hard SiteOps hits someone else's website and how
 * early it warns about an expiring certificate, so the bounds are worth
 * asserting directly rather than trusting the form that renders them.
 */

describe('monitorConfigSchema', () => {
  it('accepts a valid configuration for each type', () => {
    const configs = [
      { type: 'ssl', warningDays: 30, criticalDays: 7 },
      { type: 'domain', warningDays: 45, criticalDays: 14 },
      {
        type: 'performance',
        minPerformanceScore: 50,
        maxLargestContentfulPaintMs: 4000,
        strategy: 'mobile',
      },
      { type: 'content', sensitivity: 'medium', ignoreSelectors: [], watchSelector: null },
      { type: 'seo', minScore: 70 },
      { type: 'links', maxPages: 50, maxDepth: 3, checkExternal: true, respectRobotsTxt: true },
    ];

    for (const config of configs) {
      expect(monitorConfigSchema.safeParse(config).success).toBe(true);
    }
  });

  it('refuses fields belonging to a different monitor type', () => {
    // Sending SSL thresholds to the crawler must fail rather than being ignored
    // and silently leaving the crawl at its defaults.
    const result = monitorConfigSchema.safeParse({ type: 'links', warningDays: 30 });
    expect(result.success).toBe(false);
  });

  it('refuses an unknown monitor type', () => {
    expect(monitorConfigSchema.safeParse({ type: 'telepathy' }).success).toBe(false);
  });

  it('refuses a warning threshold tighter than the critical one', () => {
    // Warning at 3 days and critical at 7 would escalate before it ever warned.
    const result = monitorConfigSchema.safeParse({
      type: 'ssl',
      warningDays: 3,
      criticalDays: 7,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['warningDays']);
  });

  it('allows the two expiry thresholds to be equal', () => {
    expect(
      monitorConfigSchema.safeParse({ type: 'domain', warningDays: 14, criticalDays: 14 }).success,
    ).toBe(true);
  });

  it('caps a crawl at the largest any plan allows', () => {
    expect(
      monitorConfigSchema.safeParse({
        type: 'links',
        maxPages: 5000,
        maxDepth: 3,
        checkExternal: false,
        respectRobotsTxt: true,
      }).success,
    ).toBe(false);

    expect(
      monitorConfigSchema.safeParse({
        type: 'links',
        maxPages: 10,
        maxDepth: 99,
        checkExternal: false,
        respectRobotsTxt: true,
      }).success,
    ).toBe(false);
  });

  it('bounds the ignore-selector list, which is applied to every fetched page', () => {
    const many = Array.from({ length: 31 }, (_, index) => `.ad-${String(index)}`);

    expect(
      monitorConfigSchema.safeParse({
        type: 'content',
        sensitivity: 'low',
        ignoreSelectors: many,
        watchSelector: null,
      }).success,
    ).toBe(false);
  });
});

describe('updateMonitorSchema', () => {
  it('treats every field as optional so a partial patch is possible', () => {
    const result = updateMonitorSchema.safeParse({ enabled: false });

    expect(result.success).toBe(true);
    // Omitting config must leave it alone, not reset it to defaults.
    expect(result.data?.config).toBeUndefined();
  });

  it('refuses an interval faster than once an hour', () => {
    expect(updateMonitorSchema.safeParse({ intervalSeconds: 60 }).success).toBe(false);
    expect(updateMonitorSchema.safeParse({ intervalSeconds: 3600 }).success).toBe(true);
  });

  it('refuses an interval beyond thirty days', () => {
    expect(updateMonitorSchema.safeParse({ intervalSeconds: 60 * 60 * 24 * 60 }).success).toBe(
      false,
    );
  });
});
