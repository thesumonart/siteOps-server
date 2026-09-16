import { describe, expect, it } from 'vitest';

import {
  buildIncidentFacts,
  responseTimeStats,
  timelineOf,
  type AnalysisCheck,
  type IncidentFactsInput,
} from './incident-facts.js';

const START = Date.parse('2026-09-10T10:00:00.000Z');

function check(minute: number, overrides: Partial<AnalysisCheck> = {}): AnalysisCheck {
  return {
    checkedAt: new Date(START + minute * 60_000),
    status: 'up',
    statusCode: 200,
    responseTimeMs: 200,
    errorType: null,
    errorMessage: null,
    anomalous: false,
    zScore: 0.1,
    ...overrides,
  };
}

function down(minute: number, overrides: Partial<AnalysisCheck> = {}): AnalysisCheck {
  return check(minute, {
    status: 'down',
    statusCode: 503,
    responseTimeMs: 40,
    errorType: 'http_error',
    errorMessage: 'HTTP 503 Service Unavailable',
    zScore: null,
    ...overrides,
  });
}

function input(overrides: Partial<IncidentFactsInput> = {}): IncidentFactsInput {
  return {
    incident: {
      type: 'http_error',
      category: 'availability',
      severity: 'critical',
      detail: null,
      startedAt: new Date(START),
      resolvedAt: new Date(START + 5 * 60_000),
      durationSeconds: 300,
      failedCheckCount: 5,
      lastStatusCode: 503,
      lastErrorType: 'http_error',
      lastErrorMessage: 'HTTP 503 Service Unavailable',
      resolvedManually: false,
    },
    website: { name: 'Storefront', host: 'shop.example.com', checkIntervalSeconds: 60 },
    checks: {
      before: [check(-3), check(-2), check(-1)],
      during: [down(0), down(1), down(2), down(3, { statusCode: 502 }), down(4)],
      after: [check(6), check(7)],
      omittedDuring: 0,
    },
    relatedIncidents: [],
    history: { incidentsLast30Days: 3, sameCategoryLast30Days: 2 },
    ...overrides,
  };
}

describe('the timeline', () => {
  it('collapses consecutive checks with the same outcome', () => {
    const { segments, omitted } = timelineOf([
      check(-2),
      check(-1),
      down(0),
      down(1),
      down(2, { statusCode: 502 }),
      check(3),
    ]);

    expect(omitted).toBe(0);
    expect(
      segments.map((segment) => [segment.outcome, segment.statusCode, segment.checks]),
    ).toEqual([
      ['up', 200, 2],
      ['down', 503, 2],
      ['down', 502, 1],
      ['up', 200, 1],
    ]);
    expect(segments[1]).toMatchObject({
      from: '2026-09-10T10:00:00.000Z',
      to: '2026-09-10T10:01:00.000Z',
      exampleError: 'HTTP 503 Service Unavailable',
    });
  });

  it('orders checks by time whatever order they arrive in', () => {
    const { segments } = timelineOf([down(1), check(-1), down(0)]);
    expect(segments.map((segment) => segment.outcome)).toEqual(['up', 'down']);
  });

  it('keeps both ends of a timeline too long to send whole', () => {
    // Alternating outcomes: every check is its own segment.
    const flapping = Array.from({ length: 100 }, (_, minute) =>
      minute % 2 === 0 ? check(minute) : down(minute),
    );
    const { segments, omitted } = timelineOf(flapping);

    expect(segments).toHaveLength(40);
    expect(omitted).toBe(60);
    expect(segments[0]?.from).toBe(new Date(START).toISOString());
    expect(segments.at(-1)?.from).toBe(new Date(START + 99 * 60_000).toISOString());
  });

  it('separates anomalous checks from normal ones', () => {
    const { segments } = timelineOf([check(0), check(1, { anomalous: true, zScore: 4.2 })]);
    expect(segments.map((segment) => segment.anomalous)).toEqual([false, true]);
  });
});

describe('response time statistics', () => {
  it('ignores failed checks, whose duration is not the site being fast', () => {
    const stats = responseTimeStats([
      check(0, { responseTimeMs: 100 }),
      check(1, { responseTimeMs: 300 }),
      down(2, { responseTimeMs: 5 }),
    ]);
    expect(stats).toEqual({ samples: 2, meanMs: 200, p95Ms: 300, maxMs: 300 });
  });

  it('is null with nothing to measure', () => {
    expect(responseTimeStats([down(0)])).toBeNull();
  });
});

describe('the facts a model is given', () => {
  it('describes the incident, the checks around it and the history', () => {
    const facts = buildIncidentFacts(input());

    expect(facts.incident).toMatchObject({
      typeLabel: 'HTTP error',
      startedAt: '2026-09-10T10:00:00.000Z',
      resolution: 'automatic_recovery',
      failedChecks: 5,
    });
    expect(facts.checks).toEqual({ before: 3, during: 5, duringNotLoaded: 0, after: 2 });
    expect(facts.statusCodesDuring).toEqual([
      { statusCode: 503, checks: 4 },
      { statusCode: 502, checks: 1 },
    ]);
    expect(facts.errorsDuring).toEqual([
      { errorType: 'http_error', checks: 5, example: 'HTTP 503 Service Unavailable' },
    ]);
    expect(facts.responseTimeMs.before?.meanMs).toBe(200);
    expect(facts.responseTimeMs.during).toBeNull();
    expect(facts.recentHistory).toEqual({ incidentsLast30Days: 3, sameCategoryLast30Days: 2 });
  });

  it('reports the anomaly behind a slowdown', () => {
    const facts = buildIncidentFacts(
      input({
        checks: {
          before: [check(-1)],
          during: [
            check(0, { responseTimeMs: 2_400, anomalous: true, zScore: 5.123 }),
            check(1, { responseTimeMs: 2_100, anomalous: true, zScore: 4.5 }),
          ],
          after: [],
          omittedDuring: 0,
        },
      }),
    );

    expect(facts.anomaly).toEqual({ anomalousChecks: 2, maxZScore: 5.12 });
    expect(facts.responseTimeMs.during?.maxMs).toBe(2_400);
  });

  it('clips error text a server could make arbitrarily long', () => {
    const facts = buildIncidentFacts(
      input({
        checks: {
          before: [],
          during: [down(0, { errorMessage: 'x'.repeat(5_000) })],
          after: [],
          omittedDuring: 0,
        },
      }),
    );
    expect(facts.errorsDuring[0]?.example?.length).toBeLessThanOrEqual(201);
  });

  it('says when a person closed the incident rather than the site recovering', () => {
    const base = input();
    const facts = buildIncidentFacts({
      ...base,
      incident: { ...base.incident, resolvedManually: true },
    });
    expect(facts.incident.resolution).toBe('closed_by_a_person');
  });
});
