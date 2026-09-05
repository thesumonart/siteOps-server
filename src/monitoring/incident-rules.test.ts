import { describe, expect, it } from 'vitest';

import {
  decideIncidentTransition,
  deriveCounters,
  deriveDisplayStatus,
  type ConsecutiveCounters,
} from './incident-rules.js';

describe('deriveCounters', () => {
  it('resets the failure streak and grows the success streak on a success', () => {
    const result = deriveCounters({ consecutiveFailures: 2, consecutiveSuccesses: 0 }, true);
    expect(result).toEqual({ consecutiveFailures: 0, consecutiveSuccesses: 1 });
  });

  it('resets the success streak and grows the failure streak on a failure', () => {
    const result = deriveCounters({ consecutiveFailures: 0, consecutiveSuccesses: 5 }, false);
    expect(result).toEqual({ consecutiveFailures: 1, consecutiveSuccesses: 0 });
  });

  it('keeps growing an existing streak of the same kind', () => {
    expect(deriveCounters({ consecutiveFailures: 3, consecutiveSuccesses: 0 }, false)).toEqual({
      consecutiveFailures: 4,
      consecutiveSuccesses: 0,
    });
  });
});

describe('decideIncidentTransition — the "never one failed check" guarantee', () => {
  const base = { failureThreshold: 3, recoveryThreshold: 2, hasOpenIncident: false };

  it('does not open an incident on the first failure', () => {
    const counters: ConsecutiveCounters = { consecutiveFailures: 1, consecutiveSuccesses: 0 };
    expect(decideIncidentTransition({ ...base, counters })).toBe('none');
  });

  it('does not open an incident on the second failure, one short of the threshold', () => {
    const counters: ConsecutiveCounters = { consecutiveFailures: 2, consecutiveSuccesses: 0 };
    expect(decideIncidentTransition({ ...base, counters })).toBe('none');
  });

  it('opens an incident exactly when the failure count reaches the threshold', () => {
    const counters: ConsecutiveCounters = { consecutiveFailures: 3, consecutiveSuccesses: 0 };
    expect(decideIncidentTransition({ ...base, counters })).toBe('open');
  });

  it('still reports open for failures beyond the threshold — the caller is responsible for not opening twice', () => {
    const counters: ConsecutiveCounters = { consecutiveFailures: 4, consecutiveSuccesses: 0 };
    expect(decideIncidentTransition({ ...base, counters })).toBe('open');
  });

  it.each([1, 2, 3, 5, 10])(
    'opens at exactly the configured threshold of %i, never earlier',
    (threshold) => {
      const oneShort: ConsecutiveCounters = {
        consecutiveFailures: threshold - 1,
        consecutiveSuccesses: 0,
      };
      expect(
        decideIncidentTransition({ ...base, failureThreshold: threshold, counters: oneShort }),
      ).toBe('none');

      const exact: ConsecutiveCounters = {
        consecutiveFailures: threshold,
        consecutiveSuccesses: 0,
      };
      expect(
        decideIncidentTransition({ ...base, failureThreshold: threshold, counters: exact }),
      ).toBe('open');
    },
  );
});

describe('decideIncidentTransition — recovery, and the flapping guard', () => {
  const base = { failureThreshold: 3, recoveryThreshold: 2, hasOpenIncident: true };

  it('does not resolve on the first successful check after an outage', () => {
    const counters: ConsecutiveCounters = { consecutiveFailures: 0, consecutiveSuccesses: 1 };
    expect(decideIncidentTransition({ ...base, counters })).toBe('ongoing');
  });

  it('resolves exactly when successes reach the recovery threshold', () => {
    const counters: ConsecutiveCounters = { consecutiveFailures: 0, consecutiveSuccesses: 2 };
    expect(decideIncidentTransition({ ...base, counters })).toBe('resolve');
  });

  it('stays ongoing while still failing during an open incident', () => {
    const counters: ConsecutiveCounters = { consecutiveFailures: 5, consecutiveSuccesses: 0 };
    expect(decideIncidentTransition({ ...base, counters })).toBe('ongoing');
  });

  it.each([1, 2, 4])(
    'resolves at exactly the configured recovery threshold of %i, never earlier',
    (threshold) => {
      // `threshold - 1` successes is always short of `threshold` (including the
      // threshold=1 case, where this is 0 successes) — so this must always be
      // "ongoing", never "resolve".
      const oneShort: ConsecutiveCounters = {
        consecutiveFailures: 0,
        consecutiveSuccesses: threshold - 1,
      };
      expect(
        decideIncidentTransition({ ...base, recoveryThreshold: threshold, counters: oneShort }),
      ).toBe('ongoing');

      const exact: ConsecutiveCounters = {
        consecutiveFailures: 0,
        consecutiveSuccesses: threshold,
      };
      expect(
        decideIncidentTransition({ ...base, recoveryThreshold: threshold, counters: exact }),
      ).toBe('resolve');
    },
  );
});

describe('decideIncidentTransition — a single flake mid-recovery does not resolve early', () => {
  it('one success surrounded by failures never crosses recoveryThreshold=2', () => {
    // fail, fail, fail (opens) -> succeed (ongoing) -> fail again (streak reset)
    let counters: ConsecutiveCounters = { consecutiveFailures: 0, consecutiveSuccesses: 0 };
    const opts = { failureThreshold: 3, recoveryThreshold: 2 };

    counters = deriveCounters(counters, false);
    expect(decideIncidentTransition({ ...opts, counters, hasOpenIncident: false })).toBe('none');
    counters = deriveCounters(counters, false);
    expect(decideIncidentTransition({ ...opts, counters, hasOpenIncident: false })).toBe('none');
    counters = deriveCounters(counters, false);
    expect(decideIncidentTransition({ ...opts, counters, hasOpenIncident: false })).toBe('open');

    counters = deriveCounters(counters, true);
    expect(decideIncidentTransition({ ...opts, counters, hasOpenIncident: true })).toBe('ongoing');

    // Flakes back to failing: the success streak is wiped, so recovery cannot
    // have been silently counted across the gap.
    counters = deriveCounters(counters, false);
    expect(counters.consecutiveSuccesses).toBe(0);
    expect(decideIncidentTransition({ ...opts, counters, hasOpenIncident: true })).toBe('ongoing');
  });
});

describe('deriveDisplayStatus', () => {
  it('shows down whenever an incident is open, regardless of this check outcome', () => {
    expect(
      deriveDisplayStatus({ checkStatus: 'up', responseTimeMs: 50, hasOpenIncidentAfter: true }),
    ).toBe('down');
  });

  it('shows operational for a fast success with no open incident', () => {
    expect(
      deriveDisplayStatus({ checkStatus: 'up', responseTimeMs: 200, hasOpenIncidentAfter: false }),
    ).toBe('operational');
  });

  it('shows degraded for a slow-but-successful response', () => {
    expect(
      deriveDisplayStatus({
        checkStatus: 'up',
        responseTimeMs: 2_000,
        hasOpenIncidentAfter: false,
      }),
    ).toBe('degraded');
    expect(
      deriveDisplayStatus({
        checkStatus: 'up',
        responseTimeMs: 1_999,
        hasOpenIncidentAfter: false,
      }),
    ).toBe('operational');
  });

  it('shows degraded for a failure that has not yet opened an incident', () => {
    expect(
      deriveDisplayStatus({
        checkStatus: 'down',
        responseTimeMs: null,
        hasOpenIncidentAfter: false,
      }),
    ).toBe('degraded');
    expect(
      deriveDisplayStatus({
        checkStatus: 'timeout',
        responseTimeMs: null,
        hasOpenIncidentAfter: false,
      }),
    ).toBe('degraded');
  });

  it('treats a successful check with no recorded response time as operational, not degraded', () => {
    expect(
      deriveDisplayStatus({ checkStatus: 'up', responseTimeMs: null, hasOpenIncidentAfter: false }),
    ).toBe('operational');
  });
});
