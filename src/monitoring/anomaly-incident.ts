import type { Types } from 'mongoose';

import { IncidentModel } from '../models/index.js';
import { createLogger } from '../utils/logger.js';
import type { AnomalyTransition } from './anomaly-detection.js';

const logger = createLogger('anomaly-incident');

/**
 * Opens and resolves the incident that says a website is degraded.
 *
 * Its own category, `anomaly`, so it can be open alongside an outage or an
 * expiring certificate without either suppressing the other — the same unique
 * partial index on `(websiteId, category)` that deduplicates every other
 * incident deduplicates this one, and a race loses at the database.
 *
 * Severity is `warning`, never `critical`. The site is answering; it is slow.
 * An outage is what `critical` means, and an anomaly never counts against
 * uptime — see `affectsAvailability`.
 */

export interface AnomalyIncidentContext {
  readonly organizationId: Types.ObjectId;
  readonly websiteId: Types.ObjectId;
  readonly checkedAt: Date;
  /** Whether this check was itself anomalous; only those update the record. */
  readonly checkAnomalous: boolean;
  /** Anomalous checks so far in this streak, recorded when the incident opens. */
  readonly anomalousChecks: number;
  /** The three numbers behind the latest anomalous check. */
  readonly detail: string | null;
}

export interface AnomalyApplyResult {
  readonly openIncidentId: Types.ObjectId | null;
  readonly newlyOpenedIncidentId: Types.ObjectId | null;
  readonly newlyResolvedIncidentId: Types.ObjectId | null;
}

export const NO_ANOMALY: AnomalyApplyResult = {
  openIncidentId: null,
  newlyOpenedIncidentId: null,
  newlyResolvedIncidentId: null,
};

export async function applyAnomalyTransition(
  transition: AnomalyTransition,
  currentIncidentId: Types.ObjectId | null,
  context: AnomalyIncidentContext,
): Promise<AnomalyApplyResult> {
  if (transition === 'none') return NO_ANOMALY;
  if (transition === 'open') return openIncident(context);

  if (currentIncidentId === null) {
    // `ongoing` and `resolve` are only decided when one is open. A missing id
    // must not throw and abandon the check that got here.
    logger.error(
      { websiteId: context.websiteId.toHexString(), transition },
      'anomaly.missing_id_for_transition',
    );
    return NO_ANOMALY;
  }

  if (transition === 'resolve') {
    return (await closeAnomalyIncident(currentIncidentId, context.checkedAt))
      ? { ...NO_ANOMALY, newlyResolvedIncidentId: currentIncidentId }
      : NO_ANOMALY;
  }

  // Ongoing. A normal check inside the recovery window writes nothing: it is
  // not evidence about the slowdown, only towards it being over.
  if (!context.checkAnomalous) return { ...NO_ANOMALY, openIncidentId: currentIncidentId };

  const updated = await IncidentModel.updateOne(
    { _id: currentIncidentId, status: 'open' },
    { $inc: { failedCheckCount: 1 }, $set: { detail: context.detail } },
  ).exec();

  // Closed underneath us — by hand, from the incidents page. Letting go of the
  // reference means the next anomalous streak opens a fresh one instead of
  // updating a closed record forever.
  return updated.matchedCount > 0
    ? { ...NO_ANOMALY, openIncidentId: currentIncidentId }
    : NO_ANOMALY;
}

async function openIncident(context: AnomalyIncidentContext): Promise<AnomalyApplyResult> {
  try {
    const created = await IncidentModel.create({
      organizationId: context.organizationId,
      websiteId: context.websiteId,
      status: 'open',
      type: 'response_time_anomaly',
      category: 'anomaly',
      severity: 'warning',
      detail: context.detail,
      // The streak started a few checks ago, but this check is the one that
      // confirmed it — the same choice uptime makes for `startedAt`.
      startedAt: context.checkedAt,
      failedCheckCount: context.anomalousChecks,
    });

    logger.info(
      { websiteId: context.websiteId.toHexString(), incidentId: created._id.toHexString() },
      'anomaly.incident_created',
    );

    return {
      openIncidentId: created._id,
      newlyOpenedIncidentId: created._id,
      newlyResolvedIncidentId: null,
    };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    // Another claim already opened one. Adopt it rather than treating this as
    // a fresh open, so no second alert fires.
    const existing = await IncidentModel.findOne({
      websiteId: context.websiteId,
      category: 'anomaly',
      status: 'open',
    })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>()
      .exec();

    logger.warn({ websiteId: context.websiteId.toHexString() }, 'anomaly.open_race_detected');
    return { ...NO_ANOMALY, openIncidentId: existing?._id ?? null };
  }
}

/**
 * Closes an anomaly incident. True only when this call is the one that closed it.
 *
 * Conditioned on `status: 'open'` in the filter, so a concurrent resolver — or
 * a person on the incidents page — wins or loses cleanly, never twice.
 */
export async function closeAnomalyIncident(
  incidentId: Types.ObjectId,
  resolvedAt: Date,
): Promise<boolean> {
  const open = await IncidentModel.findOne({ _id: incidentId, status: 'open' })
    .select({ startedAt: 1 })
    .lean<{ startedAt: Date }>()
    .exec();
  if (!open) return false;

  const durationSeconds = Math.max(
    0,
    Math.round((resolvedAt.getTime() - open.startedAt.getTime()) / 1000),
  );

  const result = await IncidentModel.updateOne(
    { _id: incidentId, status: 'open' },
    { $set: { status: 'resolved', resolvedAt, durationSeconds } },
  ).exec();

  return result.modifiedCount > 0;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}
