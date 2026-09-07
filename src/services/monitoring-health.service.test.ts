import { describe, expect, it } from 'vitest';

import { classify } from './monitoring-health.service.js';

/**
 * The verdict that decides whether anyone finds out monitoring has stopped.
 *
 * This is the whole point of the heartbeat: SiteOps ran for eighteen hours with
 * no monitoring process at all while every health probe stayed green, because
 * nothing anywhere asked "when did a check last actually happen". Getting the
 * thresholds wrong in the lenient direction reinstates exactly that silence.
 */
describe('classify', () => {
  it('reports a deployment that has never run monitoring separately from a stopped one', () => {
    // They need different responses: one has not been configured to run
    // monitoring, the other was and no longer is.
    expect(classify(null)).toBe('never_started');
  });

  it('is running while heartbeats are fresh', () => {
    expect(classify(0)).toBe('running');
    expect(classify(45_000)).toBe('running');
  });

  it('is degraded once several heartbeats in a row have been missed', () => {
    // One missed write is a slow database or a restart; three is worth looking
    // at, and worth saying so before it becomes an outage.
    expect(classify(3 * 60_000)).toBe('degraded');
  });

  it('is stopped well before a check interval could hide it', () => {
    expect(classify(11 * 60_000)).toBe('stopped');
    // The failure that prompted all of this must land here, unambiguously.
    expect(classify(18 * 60 * 60 * 1000)).toBe('stopped');
  });

  it('escalates monotonically, so a longer silence is never a better verdict', () => {
    const rank = { running: 0, degraded: 1, stopped: 2, never_started: 3 } as const;
    const ages = [0, 30_000, 60_000, 130_000, 300_000, 600_001, 3_600_000];

    const ranks = ages.map((age) => rank[classify(age)]);

    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
