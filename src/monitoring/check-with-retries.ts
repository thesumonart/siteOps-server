import { checkWebsite, type CheckOptions, type CheckOutcome } from './http-checker.js';

/**
 * Retries a check within one scheduled attempt, absorbing a single transient
 * blip before it counts toward the failure-threshold streak that spans
 * multiple *poll intervals*. This is a different layer of noise absorption
 * from `incident-rules.ts`'s failure threshold: that one tolerates a bad
 * check now and then across many minutes; this one tolerates a check that
 * simply had a rough moment right now.
 *
 * Deterministic rejections are never retried — a blocked target or an invalid
 * URL will fail identically on every attempt, so retrying only delays the
 * result for no chance of a different outcome.
 */
const NON_RETRYABLE_ERROR_TYPES: ReadonlySet<string> = new Set(['blocked_target', 'invalid_url']);

export interface RetryOptions {
  /** Attempts including the first. Must be at least 1. */
  readonly maxAttempts: number;
}

export async function checkWebsiteWithRetries(
  url: string,
  checkOptions: CheckOptions,
  retryOptions: RetryOptions,
): Promise<CheckOutcome> {
  let lastOutcome: CheckOutcome | null = null;

  for (let attempt = 1; attempt <= retryOptions.maxAttempts; attempt += 1) {
    const outcome = await checkWebsite(url, checkOptions);

    if (outcome.status === 'up') return outcome;
    if (outcome.errorType && NON_RETRYABLE_ERROR_TYPES.has(outcome.errorType)) return outcome;

    lastOutcome = outcome;
  }

  // `maxAttempts >= 1` is required by the type's contract, so the loop above
  // always runs at least once and `lastOutcome` is never null here.
  return lastOutcome!;
}
