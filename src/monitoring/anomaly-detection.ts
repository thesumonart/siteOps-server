/**
 * Response-time anomaly detection, as pure functions.
 *
 * Framework- and database-free for the same reason `incident-rules.ts` is:
 * this decides when somebody is told their site has slowed down, and it is
 * cheap to get subtly wrong. Every threshold combination is testable here
 * without a database or a clock.
 *
 * The method is deliberately plain. Each website keeps its last N successful
 * response times; the mean and standard deviation of that window are its
 * baseline; a new response time is scored by how many standard deviations it
 * sits above the mean. Nothing is learned, nothing is seasonal, and the answer
 * to "why did this fire" is always three numbers a person can check by hand.
 */

export interface AnomalySettings {
  /** Successful response times kept per website. The rolling window. */
  readonly windowSize: number;
  /** Below this many samples there is no baseline, and nothing is scored. */
  readonly minSamples: number;
  /** How many standard deviations above the mean counts as unusual. */
  readonly zThreshold: number;
  /** How many times the mean a response must also be. See {@link scoreResponseTime}. */
  readonly minRatio: number;
  /** Consecutive anomalous checks before a website is declared degraded. */
  readonly triggerChecks: number;
  /** Consecutive normal checks before it is declared back to normal. */
  readonly recoveryChecks: number;
}

export interface Baseline {
  readonly sampleCount: number;
  readonly meanMs: number;
  readonly stdDevMs: number;
}

/**
 * The spread a perfectly steady site is treated as having.
 *
 * A site that has answered in exactly 42 ms a hundred times has a standard
 * deviation of zero, and any slower answer would score infinity. One
 * millisecond keeps the score finite and meaningful; the ratio guard is what
 * stops such a site being flagged for a 5 ms wobble.
 */
const MIN_STD_DEV_MS = 1;

/** Mean and population standard deviation of the window, or null if it is too short. */
export function computeBaseline(samples: readonly number[], minSamples: number): Baseline | null {
  if (samples.length === 0 || samples.length < minSamples) return null;

  const count = samples.length;
  const mean = samples.reduce((sum, value) => sum + value, 0) / count;
  // Two passes rather than a running sum of squares: the window is at most a
  // few hundred numbers, and the one-pass formula loses precision exactly when
  // the values are large and close together, which is what response times are.
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;

  return { sampleCount: count, meanMs: mean, stdDevMs: Math.sqrt(variance) };
}

export interface AnomalyScore {
  readonly anomalous: boolean;
  /** Null when there was nothing to score: a failed check, or too little history. */
  readonly zScore: number | null;
  readonly baseline: Baseline | null;
}

export const NOT_SCORED: AnomalyScore = { anomalous: false, zScore: null, baseline: null };

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Scores one successful response time against the window that preceded it.
 *
 * The window must not include the sample being scored — a slow response
 * averaged into its own baseline partly excuses itself.
 *
 * Two conditions, both required:
 *
 *  - **z > threshold.** Unusual for *this* site. A site that normally varies
 *    between 200 ms and 2 s is not anomalous at 1.5 s.
 *  - **at least `minRatio` × the mean.** Meaningfully slower in absolute terms.
 *    A site that answers in 200 ± 3 ms scores z = 13 at 240 ms, and nobody wants
 *    to be told about 40 ms.
 *
 * Either alone produces alerts people learn to ignore, which is worse than none.
 */
export function scoreResponseTime(
  responseTimeMs: number | null,
  samples: readonly number[],
  settings: Pick<AnomalySettings, 'minSamples' | 'zThreshold' | 'minRatio'>,
): AnomalyScore {
  if (responseTimeMs === null) return NOT_SCORED;

  const baseline = computeBaseline(samples, settings.minSamples);
  if (!baseline) return NOT_SCORED;

  const zScore = (responseTimeMs - baseline.meanMs) / Math.max(baseline.stdDevMs, MIN_STD_DEV_MS);
  const anomalous =
    zScore > settings.zThreshold && responseTimeMs >= baseline.meanMs * settings.minRatio;

  return { anomalous, zScore: roundTo(zScore, 2), baseline };
}

export interface AnomalyCounters {
  readonly consecutiveAnomalies: number;
  readonly consecutiveNormalChecks: number;
}

/**
 * Rolls one check into the streaks.
 *
 * A failed check moves neither. It says nothing about how fast the site is —
 * that is the availability incident's business — and letting it reset the
 * anomaly streak would mean a slow site that also drops the odd request could
 * never be declared degraded.
 *
 * A check scored against too little history counts as normal: a new website is
 * not slow, it is unmeasured, and the streak should start clean when it is.
 */
export function deriveAnomalyCounters(
  previous: AnomalyCounters,
  checkSucceeded: boolean,
  score: AnomalyScore,
): AnomalyCounters {
  if (!checkSucceeded) return previous;

  return score.anomalous
    ? { consecutiveAnomalies: previous.consecutiveAnomalies + 1, consecutiveNormalChecks: 0 }
    : { consecutiveAnomalies: 0, consecutiveNormalChecks: previous.consecutiveNormalChecks + 1 };
}

export type AnomalyTransition = 'open' | 'resolve' | 'ongoing' | 'none';

export interface AnomalyTransitionInput {
  readonly counters: AnomalyCounters;
  readonly hasOpenAnomaly: boolean;
  /** Whether an availability incident is open after this check. */
  readonly availabilityIncidentOpen: boolean;
  readonly triggerChecks: number;
  readonly recoveryChecks: number;
}

/**
 * Decides what happens to the website's anomaly incident.
 *
 * Mirrors `decideIncidentTransition`: a streak has to be long enough to open
 * one, and long enough in the other direction to close it, so one slow
 * response never pages anybody and one fast one never declares it over.
 *
 * A site that is down is not degraded. While an availability incident is open
 * no anomaly incident opens — the outage alert already said the important
 * thing, and "also slow" about a site that is not answering is noise. One
 * already open stays open: when the site comes back, it is either slow or it is
 * not, and the checks after the outage decide which.
 */
export function decideAnomalyTransition(input: AnomalyTransitionInput): AnomalyTransition {
  if (!input.hasOpenAnomaly) {
    if (input.availabilityIncidentOpen) return 'none';
    return input.counters.consecutiveAnomalies >= input.triggerChecks ? 'open' : 'none';
  }

  return input.counters.consecutiveNormalChecks >= input.recoveryChecks ? 'resolve' : 'ongoing';
}

/** One line for the incident, the alert and the dashboard: the three numbers behind the call. */
export function describeAnomaly(responseTimeMs: number, baseline: Baseline): string {
  return (
    `Responding in ${String(Math.round(responseTimeMs))} ms, against a usual ` +
    `${String(Math.round(baseline.meanMs))} ± ${String(Math.round(baseline.stdDevMs))} ms ` +
    `over the last ${String(baseline.sampleCount)} checks.`
  );
}
