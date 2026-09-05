import {
  DEGRADED_RESPONSE_TIME_MS,
  type CheckStatus,
  type WebsiteStatus,
} from '../contracts/index.js';

/**
 * Pure decision logic for incident confirmation and display status.
 *
 * Framework- and database-free on purpose, the same way `uptime.ts` is: this
 * is where "never declare a site down on one failed check" actually lives, and
 * it is cheap to get subtly wrong (an off-by-one here either pages someone for
 * a transient blip or silently fails to notice a real outage). Keeping it pure
 * means every threshold combination can be exhaustively tested without a
 * database.
 */

export interface ConsecutiveCounters {
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
}

/** Rolls one check outcome into the running streak. A success resets the failure streak and vice versa. */
export function deriveCounters(
  previous: ConsecutiveCounters,
  checkSucceeded: boolean,
): ConsecutiveCounters {
  return checkSucceeded
    ? { consecutiveFailures: 0, consecutiveSuccesses: previous.consecutiveSuccesses + 1 }
    : { consecutiveFailures: previous.consecutiveFailures + 1, consecutiveSuccesses: 0 };
}

export type IncidentTransition = 'open' | 'resolve' | 'ongoing' | 'none';

export interface TransitionInput {
  readonly counters: ConsecutiveCounters;
  readonly failureThreshold: number;
  readonly recoveryThreshold: number;
  readonly hasOpenIncident: boolean;
}

/**
 * Decides what, if anything, should happen to this website's incident state.
 *
 * - `open`: no incident exists yet, and failures have now reached the
 *   threshold — this check is the one that confirms the outage.
 * - `resolve`: an incident is open, and successes have now reached the
 *   recovery threshold — this check is the one that confirms recovery.
 * - `ongoing`: an incident is open and neither edge condition fired this
 *   check (still failing without a fresh threshold crossing — cannot happen
 *   given the counters above, but also covers "recovering, not yet enough
 *   successes to resolve").
 * - `none`: no incident, and nothing about this check changes that.
 */
export function decideIncidentTransition(input: TransitionInput): IncidentTransition {
  const { counters, failureThreshold, recoveryThreshold, hasOpenIncident } = input;

  if (!hasOpenIncident) {
    return counters.consecutiveFailures >= failureThreshold ? 'open' : 'none';
  }

  return counters.consecutiveSuccesses >= recoveryThreshold ? 'resolve' : 'ongoing';
}

export interface StatusInput {
  readonly checkStatus: CheckStatus;
  readonly responseTimeMs: number | null;
  /** Whether an incident is open *after* this check's transition has been applied. */
  readonly hasOpenIncidentAfter: boolean;
}

/**
 * The status shown in the dashboard.
 *
 * Tied to whether an incident is open, not to the raw pass/fail of the latest
 * check: during a recovering-but-not-yet-confirmed window the site is still
 * shown as `down`, because the incident is still open and showing anything
 * else would contradict the open incident on the incidents page. `degraded`
 * covers two distinct situations — a failing check that has not yet crossed
 * the failure threshold, and a successful-but-slow response — both genuinely
 * described as "responding slowly or intermittently".
 */
export function deriveDisplayStatus(input: StatusInput): WebsiteStatus {
  if (input.hasOpenIncidentAfter) return 'down';
  if (input.checkStatus !== 'up') return 'degraded';
  if (input.responseTimeMs !== null && input.responseTimeMs >= DEGRADED_RESPONSE_TIME_MS) {
    return 'degraded';
  }
  return 'operational';
}
