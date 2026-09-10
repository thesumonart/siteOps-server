import { describe, expect, it } from 'vitest';

import {
  NOT_SCORED,
  computeBaseline,
  decideAnomalyTransition,
  deriveAnomalyCounters,
  describeAnomaly,
  scoreResponseTime,
  type AnomalySettings,
} from './anomaly-detection.js';

const SETTINGS: AnomalySettings = {
  windowSize: 100,
  minSamples: 30,
  zThreshold: 3,
  minRatio: 1.5,
  triggerChecks: 3,
  recoveryChecks: 3,
};

/** A window alternating around `mean` by `spread`: mean exactly `mean`, std dev exactly `spread`. */
function windowAround(mean: number, spread: number, count = 100): number[] {
  return Array.from({ length: count }, (_unused, index) =>
    index % 2 === 0 ? mean - spread : mean + spread,
  );
}

describe('the baseline', () => {
  it('is the mean and population standard deviation of the window', () => {
    expect(computeBaseline([2, 4, 4, 4, 5, 5, 7, 9], 1)).toEqual({
      sampleCount: 8,
      meanMs: 5,
      stdDevMs: 2,
    });
  });

  it('does not exist until there is enough history', () => {
    // A new website is not slow; it is unmeasured.
    expect(computeBaseline(windowAround(200, 10, 29), 30)).toBeNull();
    expect(computeBaseline(windowAround(200, 10, 30), 30)).not.toBeNull();
    expect(computeBaseline([], 0)).toBeNull();
  });
});

describe('scoring a response time', () => {
  it('flags a response far above a steady baseline', () => {
    const score = scoreResponseTime(900, windowAround(200, 20), SETTINGS);

    expect(score.anomalous).toBe(true);
    expect(score.zScore).toBe(35);
    expect(score.baseline).toEqual({ sampleCount: 100, meanMs: 200, stdDevMs: 20 });
  });

  it('does not flag an ordinary response', () => {
    const score = scoreResponseTime(215, windowAround(200, 20), SETTINGS);

    expect(score.anomalous).toBe(false);
    expect(score.zScore).toBe(0.75);
  });

  it('does not flag a small absolute change on a very steady site', () => {
    // z = 13, but 40 ms is not worth anyone's attention.
    const score = scoreResponseTime(240, windowAround(200, 3), SETTINGS);

    expect(score.zScore).toBeGreaterThan(SETTINGS.zThreshold);
    expect(score.anomalous).toBe(false);
  });

  it('does not flag a slow response on a site that is always noisy', () => {
    // Double the mean, but well within how much this site normally varies.
    const score = scoreResponseTime(1_000, windowAround(500, 400), SETTINGS);

    expect(score.zScore).toBeLessThan(SETTINGS.zThreshold);
    expect(score.anomalous).toBe(false);
  });

  it('keeps a perfectly steady site finite', () => {
    const score = scoreResponseTime(
      100,
      Array.from({ length: 50 }, () => 42),
      SETTINGS,
    );

    expect(score.zScore).toBe(58);
    expect(score.anomalous).toBe(true);
  });

  it('never scores a failed check or a website without history', () => {
    expect(scoreResponseTime(null, windowAround(200, 20), SETTINGS)).toEqual(NOT_SCORED);
    expect(scoreResponseTime(5_000, windowAround(200, 20, 10), SETTINGS)).toEqual(NOT_SCORED);
  });

  it('does not flag a response faster than usual', () => {
    expect(scoreResponseTime(20, windowAround(200, 20), SETTINGS).anomalous).toBe(false);
  });
});

describe('the streaks', () => {
  const start = { consecutiveAnomalies: 2, consecutiveNormalChecks: 0 };
  const anomalous = { anomalous: true, zScore: 10, baseline: null };

  it('count anomalies and normal checks against each other', () => {
    expect(deriveAnomalyCounters(start, true, anomalous)).toEqual({
      consecutiveAnomalies: 3,
      consecutiveNormalChecks: 0,
    });
    expect(deriveAnomalyCounters(start, true, NOT_SCORED)).toEqual({
      consecutiveAnomalies: 0,
      consecutiveNormalChecks: 1,
    });
  });

  it('are left alone by a failed check, which says nothing about speed', () => {
    expect(deriveAnomalyCounters(start, false, NOT_SCORED)).toBe(start);
  });
});

describe('deciding the transition', () => {
  const input = {
    counters: { consecutiveAnomalies: 0, consecutiveNormalChecks: 0 },
    hasOpenAnomaly: false,
    availabilityIncidentOpen: false,
    triggerChecks: 3,
    recoveryChecks: 3,
  };

  it('opens exactly when the anomaly streak reaches the trigger, never earlier', () => {
    for (const streak of [1, 2]) {
      expect(
        decideAnomalyTransition({
          ...input,
          counters: { consecutiveAnomalies: streak, consecutiveNormalChecks: 0 },
        }),
      ).toBe('none');
    }
    expect(
      decideAnomalyTransition({
        ...input,
        counters: { consecutiveAnomalies: 3, consecutiveNormalChecks: 0 },
      }),
    ).toBe('open');
  });

  it('does not call a site that is down degraded', () => {
    expect(
      decideAnomalyTransition({
        ...input,
        availabilityIncidentOpen: true,
        counters: { consecutiveAnomalies: 10, consecutiveNormalChecks: 0 },
      }),
    ).toBe('none');
  });

  it('resolves exactly when the normal streak reaches the recovery threshold', () => {
    const open = { ...input, hasOpenAnomaly: true };

    expect(
      decideAnomalyTransition({
        ...open,
        counters: { consecutiveAnomalies: 0, consecutiveNormalChecks: 2 },
      }),
    ).toBe('ongoing');
    expect(
      decideAnomalyTransition({
        ...open,
        counters: { consecutiveAnomalies: 0, consecutiveNormalChecks: 3 },
      }),
    ).toBe('resolve');
  });

  it('keeps an open anomaly open through an outage', () => {
    expect(
      decideAnomalyTransition({
        ...input,
        hasOpenAnomaly: true,
        availabilityIncidentOpen: true,
        counters: { consecutiveAnomalies: 2, consecutiveNormalChecks: 0 },
      }),
    ).toBe('ongoing');
  });
});

describe('describing an anomaly', () => {
  it('names the three numbers behind the call', () => {
    expect(describeAnomaly(1_840.4, { sampleCount: 100, meanMs: 310.2, stdDevMs: 44.8 })).toBe(
      'Responding in 1840 ms, against a usual 310 ± 45 ms over the last 100 checks.',
    );
  });
});
