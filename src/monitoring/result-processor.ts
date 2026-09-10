import { WebsiteCheckModel, WebsiteModel } from '../models/index.js';
import { isSuccessfulCheck, type WebhookAnomaly, type WebsiteStatus } from '../contracts/index.js';

import { createLogger } from '../utils/logger.js';
import {
  NOT_SCORED,
  decideAnomalyTransition,
  deriveAnomalyCounters,
  describeAnomaly,
  scoreResponseTime,
  type AnomalyCounters,
  type AnomalyScore,
  type AnomalySettings,
} from './anomaly-detection.js';
import {
  NO_ANOMALY,
  applyAnomalyTransition,
  closeAnomalyIncident,
  type AnomalyApplyResult,
} from './anomaly-incident.js';
import { type CheckOutcome } from './http-checker.js';
import {
  applyIncidentTransition,
  type IncidentApplyResult,
  type IncidentCheckContext,
} from './incident-processor.js';
import { decideIncidentTransition, deriveCounters, deriveDisplayStatus } from './incident-rules.js';
import type { PlanLookup } from './plan-lookup.js';
import { type ClaimedWebsite } from '../queues/monitoring.queue.js';

const logger = createLogger('result-processor');

export interface CheckProcessingOptions {
  readonly anomaly: AnomalySettings;
  readonly plans: PlanLookup;
}

export interface AnomalyOutcome extends AnomalyApplyResult {
  readonly score: AnomalyScore;
  readonly counters: AnomalyCounters;
  /** The numbers behind this check's verdict, when it was anomalous. */
  readonly facts: WebhookAnomaly | null;
}

export interface ProcessedResult {
  readonly incident: IncidentApplyResult;
  readonly anomaly: AnomalyOutcome;
  readonly newStatus: WebsiteStatus;
}

const ZEROED: AnomalyCounters = { consecutiveAnomalies: 0, consecutiveNormalChecks: 0 };

/**
 * Turns one check outcome into durable state.
 *
 * Four things happen, in order: the raw check is recorded (append-only,
 * never touched again), the incident-rules decision is applied to the
 * incidents collection, the response time is judged against the website's own
 * baseline, and the website document is updated with the new counters, status
 * and response-time window — all in one write, so a reader never observes a
 * status that contradicts the counters that produced it.
 */
export async function processCheckResult(
  website: ClaimedWebsite,
  outcome: CheckOutcome,
  checkedAt: Date,
  options: CheckProcessingOptions,
): Promise<ProcessedResult> {
  const checkSucceeded = isSuccessfulCheck(outcome.status);
  // A failed check never enters the window: how long a failure took says
  // nothing about how fast the site is.
  const sample = checkSucceeded ? outcome.responseTimeMs : null;

  const detecting = await options.plans.hasFeature(website.organizationId, 'anomaly_detection');
  // Scored against the window as it stood *before* this check, so a slow
  // response cannot partly excuse itself by being averaged into its baseline.
  const score = detecting
    ? scoreResponseTime(sample, website.responseTimeSamples, options.anomaly)
    : NOT_SCORED;

  await WebsiteCheckModel.create({
    websiteId: website.id,
    organizationId: website.organizationId,
    status: outcome.status,
    statusCode: outcome.statusCode,
    responseTimeMs: outcome.responseTimeMs,
    checkedAt,
    errorType: outcome.errorType,
    errorMessage: outcome.errorMessage,
    redirectCount: outcome.redirectCount,
    anomalous: score.anomalous,
    zScore: score.zScore,
  });

  const counters = deriveCounters(website, checkSucceeded);
  const hasOpenIncidentBefore = website.currentIncidentId !== null;

  const transition = decideIncidentTransition({
    counters,
    failureThreshold: website.failureThreshold,
    recoveryThreshold: website.recoveryThreshold,
    hasOpenIncident: hasOpenIncidentBefore,
  });

  const incidentContext: IncidentCheckContext = {
    organizationId: website.organizationId,
    websiteId: website.id,
    checkedAt,
    checkSucceeded,
    failedCheckCount: counters.consecutiveFailures,
    statusCode: outcome.statusCode,
    errorType: outcome.errorType,
    errorMessage: outcome.errorMessage,
  };

  const incident = await applyIncidentTransition(
    transition,
    website.currentIncidentId,
    incidentContext,
  );

  const anomaly = detecting
    ? await evaluateAnomaly(website, {
        checkSucceeded,
        sample,
        score,
        checkedAt,
        availabilityIncidentOpen: incident.openIncidentId !== null,
        settings: options.anomaly,
      })
    : await stopDetecting(website, checkedAt);

  const newStatus = deriveDisplayStatus({
    checkStatus: outcome.status,
    responseTimeMs: outcome.responseTimeMs,
    hasOpenIncidentAfter: incident.openIncidentId !== null,
    hasOpenAnomalyAfter: anomaly.openIncidentId !== null,
  });

  await WebsiteModel.updateOne(
    { _id: website.id },
    {
      $set: {
        status: newStatus,
        consecutiveFailures: counters.consecutiveFailures,
        consecutiveSuccesses: counters.consecutiveSuccesses,
        currentIncidentId: incident.openIncidentId,
        lastCheckedAt: checkedAt,
        lastResponseTimeMs: outcome.responseTimeMs,
        lastStatusCode: outcome.statusCode,
        consecutiveAnomalies: anomaly.counters.consecutiveAnomalies,
        consecutiveNormalChecks: anomaly.counters.consecutiveNormalChecks,
        currentAnomalyIncidentId: anomaly.openIncidentId,
        ...(checkSucceeded ? { lastSuccessfulCheckAt: checkedAt } : { lastFailedAt: checkedAt }),
      },
      // The window is kept whatever the plan, so an upgrade starts with a
      // baseline rather than thirty checks of silence. `$slice` trims it in the
      // same atomic write, so it can never grow past the window.
      ...(sample === null
        ? {}
        : {
            $push: {
              responseTimeSamples: { $each: [sample], $slice: -options.anomaly.windowSize },
            },
          }),
    },
  ).exec();
  // Deliberately not touched here: `leaseExpiresAt` and `nextCheckAt` belong
  // to the scheduler (see `releaseAndReschedule` in `scheduler.ts`), which the
  // caller runs in a `finally` block so the website is rescheduled even when
  // this function — or the check itself — throws partway through.

  logger.info(
    {
      websiteId: website.id.toHexString(),
      status: outcome.status,
      newStatus,
      responseTimeMs: outcome.responseTimeMs,
      transition,
      zScore: score.zScore,
      anomalous: score.anomalous,
    },
    'website.check.completed',
  );

  return { incident, anomaly, newStatus };
}

interface AnomalyCheck {
  readonly checkSucceeded: boolean;
  readonly sample: number | null;
  readonly score: AnomalyScore;
  readonly checkedAt: Date;
  readonly availabilityIncidentOpen: boolean;
  readonly settings: AnomalySettings;
}

async function evaluateAnomaly(
  website: ClaimedWebsite,
  check: AnomalyCheck,
): Promise<AnomalyOutcome> {
  const counters = deriveAnomalyCounters(website, check.checkSucceeded, check.score);

  const transition = decideAnomalyTransition({
    counters,
    hasOpenAnomaly: website.currentAnomalyIncidentId !== null,
    availabilityIncidentOpen: check.availabilityIncidentOpen,
    triggerChecks: check.settings.triggerChecks,
    recoveryChecks: check.settings.recoveryChecks,
  });

  const facts = factsOf(check.sample, check.score);

  const result = await applyAnomalyTransition(transition, website.currentAnomalyIncidentId, {
    organizationId: website.organizationId,
    websiteId: website.id,
    checkedAt: check.checkedAt,
    checkAnomalous: check.score.anomalous,
    anomalousChecks: counters.consecutiveAnomalies,
    detail:
      facts && check.score.baseline
        ? describeAnomaly(facts.responseTimeMs, check.score.baseline)
        : null,
  });

  return { ...result, score: check.score, counters, facts };
}

/**
 * The plan does not include anomaly detection, or no longer does.
 *
 * The response-time window is still kept — see the update above. An anomaly
 * incident a downgrade left open is closed without an alert: nobody is paying
 * to hear that it ended, and leaving it open would hold the website at
 * `degraded` indefinitely.
 */
async function stopDetecting(website: ClaimedWebsite, checkedAt: Date): Promise<AnomalyOutcome> {
  if (website.currentAnomalyIncidentId !== null) {
    await closeAnomalyIncident(website.currentAnomalyIncidentId, checkedAt);
  }
  return { ...NO_ANOMALY, score: NOT_SCORED, counters: ZEROED, facts: null };
}

function factsOf(sample: number | null, score: AnomalyScore): WebhookAnomaly | null {
  if (!score.anomalous || sample === null || score.baseline === null || score.zScore === null) {
    return null;
  }
  return {
    responseTimeMs: sample,
    baselineMeanMs: Math.round(score.baseline.meanMs),
    baselineStdDevMs: Math.round(score.baseline.stdDevMs),
    sampleCount: score.baseline.sampleCount,
    zScore: score.zScore,
  };
}
