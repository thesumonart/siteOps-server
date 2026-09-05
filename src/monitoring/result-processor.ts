import { WebsiteCheckModel, WebsiteModel } from '../models/index.js';
import { isSuccessfulCheck, type WebsiteStatus } from '../contracts/index.js';

import { createLogger } from '../utils/logger.js';
import { type CheckOutcome } from './http-checker.js';
import {
  applyIncidentTransition,
  type IncidentApplyResult,
  type IncidentCheckContext,
} from './incident-processor.js';
import { decideIncidentTransition, deriveCounters, deriveDisplayStatus } from './incident-rules.js';
import { type ClaimedWebsite } from '../queues/monitoring.queue.js';

const logger = createLogger('result-processor');

export interface ProcessedResult {
  readonly incident: IncidentApplyResult;
  readonly newStatus: WebsiteStatus;
}

/**
 * Turns one check outcome into durable state.
 *
 * Three things happen, in order: the raw check is recorded (append-only,
 * never touched again), the incident-rules decision is applied to the
 * incidents collection, and the website document is updated with the new
 * counters, status and the outcome of the incident decision — all in one
 * write, so a reader never observes a status that contradicts the counters
 * that produced it.
 */
export async function processCheckResult(
  website: ClaimedWebsite,
  outcome: CheckOutcome,
  checkedAt: Date,
): Promise<ProcessedResult> {
  const checkSucceeded = isSuccessfulCheck(outcome.status);

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

  const newStatus = deriveDisplayStatus({
    checkStatus: outcome.status,
    responseTimeMs: outcome.responseTimeMs,
    hasOpenIncidentAfter: incident.openIncidentId !== null,
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
        ...(checkSucceeded ? { lastSuccessfulCheckAt: checkedAt } : { lastFailedAt: checkedAt }),
      },
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
    },
    'website.check.completed',
  );

  return { incident, newStatus };
}
