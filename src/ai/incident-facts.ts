import {
  INCIDENT_TYPE_LABELS,
  type CheckErrorType,
  type CheckStatus,
  type IncidentCategory,
  type IncidentSeverity,
  type IncidentType,
} from '../contracts/index.js';

/**
 * Turning an incident and the checks around it into the facts a model is given.
 *
 * Pure — no database, no clock — so exactly what reaches a provider can be
 * tested, and read, without one.
 *
 * The shaping matters more than the prompt wording. Raw checks are thousands of
 * near-identical rows; what explains an incident is how the outcome *changed*
 * over time, so consecutive checks with the same outcome collapse into one
 * timeline segment, and response times become statistics before, during and
 * after. That is also what keeps a three-day outage within a model's context.
 */

export interface AnalysisCheck {
  readonly checkedAt: Date;
  readonly status: CheckStatus;
  readonly statusCode: number | null;
  readonly responseTimeMs: number | null;
  readonly errorType: CheckErrorType | null;
  readonly errorMessage: string | null;
  readonly anomalous: boolean;
  readonly zScore: number | null;
}

export interface IncidentFactsInput {
  readonly incident: {
    readonly type: IncidentType;
    readonly category: IncidentCategory;
    readonly severity: IncidentSeverity;
    readonly detail: string | null;
    readonly startedAt: Date;
    readonly resolvedAt: Date;
    readonly durationSeconds: number | null;
    readonly failedCheckCount: number;
    readonly lastStatusCode: number | null;
    readonly lastErrorType: CheckErrorType | null;
    readonly lastErrorMessage: string | null;
    readonly resolvedManually: boolean;
  };
  readonly website: {
    readonly name: string;
    readonly host: string;
    readonly checkIntervalSeconds: number;
  } | null;
  readonly checks: {
    readonly before: readonly AnalysisCheck[];
    readonly during: readonly AnalysisCheck[];
    readonly after: readonly AnalysisCheck[];
    /** Checks inside the incident that were not loaded, when it was too long to load whole. */
    readonly omittedDuring: number;
  };
  readonly relatedIncidents: readonly {
    readonly type: IncidentType;
    readonly category: IncidentCategory;
    readonly startedAt: Date;
    readonly resolvedAt: Date | null;
  }[];
  readonly history: {
    readonly incidentsLast30Days: number;
    readonly sameCategoryLast30Days: number;
  };
}

export interface ResponseTimeStats {
  readonly samples: number;
  readonly meanMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface TimelineSegment {
  readonly from: string;
  readonly to: string;
  readonly checks: number;
  readonly outcome: CheckStatus;
  readonly statusCode: number | null;
  readonly errorType: CheckErrorType | null;
  readonly anomalous: boolean;
  readonly meanResponseTimeMs: number | null;
  readonly exampleError: string | null;
}

export interface IncidentFacts {
  readonly incident: {
    readonly type: IncidentType;
    readonly typeLabel: string;
    readonly category: IncidentCategory;
    readonly severity: IncidentSeverity;
    readonly startedAt: string;
    readonly resolvedAt: string;
    readonly durationSeconds: number | null;
    readonly resolution: 'automatic_recovery' | 'closed_by_a_person';
    readonly failedChecks: number;
    readonly lastStatusCode: number | null;
    readonly lastErrorType: CheckErrorType | null;
    readonly lastErrorMessage: string | null;
    readonly detail: string | null;
  };
  readonly website: IncidentFactsInput['website'];
  readonly checks: {
    readonly before: number;
    readonly during: number;
    readonly duringNotLoaded: number;
    readonly after: number;
  };
  readonly responseTimeMs: {
    readonly before: ResponseTimeStats | null;
    readonly during: ResponseTimeStats | null;
    readonly after: ResponseTimeStats | null;
  };
  readonly statusCodesDuring: readonly { readonly statusCode: number; readonly checks: number }[];
  readonly errorsDuring: readonly {
    readonly errorType: CheckErrorType;
    readonly checks: number;
    readonly example: string | null;
  }[];
  readonly anomaly: {
    readonly anomalousChecks: number;
    readonly maxZScore: number;
  } | null;
  readonly timeline: readonly TimelineSegment[];
  readonly timelineSegmentsOmitted: number;
  readonly relatedIncidents: readonly {
    readonly type: IncidentType;
    readonly category: IncidentCategory;
    readonly startedAt: string;
    readonly resolvedAt: string | null;
  }[];
  readonly recentHistory: IncidentFactsInput['history'];
}

/** Segments kept from each end of a timeline too long to send whole. */
const TIMELINE_SEGMENTS_PER_END = 20;

/** Long enough to identify an error; short enough that a page of HTML in one cannot flood the prompt. */
const MAX_ERROR_TEXT = 200;

export function buildIncidentFacts(input: IncidentFactsInput): IncidentFacts {
  const { incident, checks } = input;
  const all = [...checks.before, ...checks.during, ...checks.after];
  const { segments, omitted } = timelineOf(all);

  return {
    incident: {
      type: incident.type,
      typeLabel: INCIDENT_TYPE_LABELS[incident.type],
      category: incident.category,
      severity: incident.severity,
      startedAt: incident.startedAt.toISOString(),
      resolvedAt: incident.resolvedAt.toISOString(),
      durationSeconds: incident.durationSeconds,
      resolution: incident.resolvedManually ? 'closed_by_a_person' : 'automatic_recovery',
      failedChecks: incident.failedCheckCount,
      lastStatusCode: incident.lastStatusCode,
      lastErrorType: incident.lastErrorType,
      lastErrorMessage: clip(incident.lastErrorMessage),
      detail: clip(incident.detail),
    },
    website: input.website,
    checks: {
      before: checks.before.length,
      during: checks.during.length,
      duringNotLoaded: checks.omittedDuring,
      after: checks.after.length,
    },
    responseTimeMs: {
      before: responseTimeStats(checks.before),
      during: responseTimeStats(checks.during),
      after: responseTimeStats(checks.after),
    },
    statusCodesDuring: statusCodesOf(checks.during),
    errorsDuring: errorsOf(checks.during),
    anomaly: anomalyOf(checks.during),
    timeline: segments,
    timelineSegmentsOmitted: omitted,
    relatedIncidents: input.relatedIncidents.map((related) => ({
      type: related.type,
      category: related.category,
      startedAt: related.startedAt.toISOString(),
      resolvedAt: related.resolvedAt?.toISOString() ?? null,
    })),
    recentHistory: input.history,
  };
}

/**
 * Mean, 95th percentile and maximum of the successful checks' response times.
 *
 * Successful checks only, as everywhere else in SiteOps: a failed check's
 * duration measures how long the failure took, not how fast the site is.
 */
export function responseTimeStats(checks: readonly AnalysisCheck[]): ResponseTimeStats | null {
  const times = checks
    .flatMap((check) =>
      check.status === 'up' && check.responseTimeMs !== null ? [check.responseTimeMs] : [],
    )
    .sort((a, b) => a - b);
  if (times.length === 0) return null;

  const sum = times.reduce((total, time) => total + time, 0);
  const p95Index = Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1);

  return {
    samples: times.length,
    meanMs: Math.round(sum / times.length),
    p95Ms: times[p95Index] ?? 0,
    maxMs: times.at(-1) ?? 0,
  };
}

/**
 * Consecutive checks with the same outcome, as one segment each.
 *
 * "Outcome" is status, status code, error type and whether the response time
 * was anomalous — the things whose change is the story. A timeline longer than
 * two ends' worth keeps both ends: how it started and how it recovered are what
 * explain an incident, and a flapping middle is summarised by its count.
 */
export function timelineOf(checks: readonly AnalysisCheck[]): {
  readonly segments: readonly TimelineSegment[];
  readonly omitted: number;
} {
  const ordered = [...checks].sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime());
  const groups: AnalysisCheck[][] = [];

  for (const check of ordered) {
    const current = groups.at(-1);
    const first = current?.[0];
    if (current && first && sameOutcome(first, check)) current.push(check);
    else groups.push([check]);
  }

  const segments = groups.map(toSegment);
  const limit = TIMELINE_SEGMENTS_PER_END * 2;
  if (segments.length <= limit) return { segments, omitted: 0 };

  return {
    segments: [
      ...segments.slice(0, TIMELINE_SEGMENTS_PER_END),
      ...segments.slice(-TIMELINE_SEGMENTS_PER_END),
    ],
    omitted: segments.length - limit,
  };
}

function sameOutcome(a: AnalysisCheck, b: AnalysisCheck): boolean {
  return (
    a.status === b.status &&
    a.statusCode === b.statusCode &&
    a.errorType === b.errorType &&
    a.anomalous === b.anomalous
  );
}

function toSegment(group: readonly AnalysisCheck[]): TimelineSegment {
  const first = group[0];
  const last = group.at(-1);
  // Groups are built by pushing a check into them; an empty one cannot exist.
  if (!first || !last) throw new Error('A timeline segment needs at least one check.');
  const stats = responseTimeStats(group);

  return {
    from: first.checkedAt.toISOString(),
    to: last.checkedAt.toISOString(),
    checks: group.length,
    outcome: first.status,
    statusCode: first.statusCode,
    errorType: first.errorType,
    anomalous: first.anomalous,
    meanResponseTimeMs: stats?.meanMs ?? null,
    exampleError: clip(group.find((check) => check.errorMessage !== null)?.errorMessage ?? null),
  };
}

function statusCodesOf(
  checks: readonly AnalysisCheck[],
): readonly { readonly statusCode: number; readonly checks: number }[] {
  const counts = new Map<number, number>();
  for (const check of checks) {
    if (check.statusCode === null) continue;
    counts.set(check.statusCode, (counts.get(check.statusCode) ?? 0) + 1);
  }
  return [...counts]
    .map(([statusCode, count]) => ({ statusCode, checks: count }))
    .sort((a, b) => b.checks - a.checks);
}

function errorsOf(checks: readonly AnalysisCheck[]): IncidentFacts['errorsDuring'] {
  const byType = new Map<CheckErrorType, { checks: number; example: string | null }>();
  for (const check of checks) {
    if (check.errorType === null) continue;
    const entry = byType.get(check.errorType) ?? { checks: 0, example: null };
    entry.checks += 1;
    entry.example ??= clip(check.errorMessage);
    byType.set(check.errorType, entry);
  }
  return [...byType]
    .map(([errorType, entry]) => ({ errorType, ...entry }))
    .sort((a, b) => b.checks - a.checks);
}

function anomalyOf(checks: readonly AnalysisCheck[]): IncidentFacts['anomaly'] {
  const scores = checks.flatMap((check) => (check.zScore === null ? [] : [check.zScore]));
  if (scores.length === 0) return null;
  return {
    anomalousChecks: checks.filter((check) => check.anomalous).length,
    maxZScore: Math.round(Math.max(...scores) * 100) / 100,
  };
}

function clip(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed.length > MAX_ERROR_TEXT ? `${trimmed.slice(0, MAX_ERROR_TEXT)}…` : trimmed;
}
