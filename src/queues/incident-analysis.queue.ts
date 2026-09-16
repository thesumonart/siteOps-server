import type { Types } from 'mongoose';

import type { AiProvider } from '../contracts/index.js';
import { IncidentModel } from '../models/index.js';

/**
 * The incident analysis queue.
 *
 * The same lease mechanism as every other queue in SiteOps, over the incidents
 * collection itself: `analysis.nextAttemptAt` is the ready time,
 * `analysis.leaseExpiresAt` the visibility timeout, and one atomic
 * `findOneAndUpdate` claims an analysis. The attempt is counted in that same
 * update, so a generation that crashes the process still uses one up.
 *
 * Every settling write is conditioned on the analysis still being pending, so
 * a process holding an expired lease cannot overwrite what another finished.
 */

export interface ClaimedAnalysis {
  readonly incidentId: Types.ObjectId;
  readonly organizationId: Types.ObjectId;
  /** This attempt's number, counted at claim time. */
  readonly attempts: number;
  readonly requestedByUserId: Types.ObjectId | null;
  readonly requestedByName: string | null;
}

export interface AnalysisQueueOptions {
  readonly batchSize: number;
  /** Must comfortably exceed one generation's timeout, or a slow one is claimed twice. */
  readonly leaseDurationMs: number;
}

interface ClaimedRow {
  readonly _id: Types.ObjectId;
  readonly organizationId: Types.ObjectId;
  readonly analysis: {
    readonly attempts: number;
    readonly requestedByUserId: Types.ObjectId | null;
    readonly requestedByName: string | null;
  };
}

async function claimOne(leaseDurationMs: number): Promise<ClaimedAnalysis | null> {
  const now = new Date();

  const row = await IncidentModel.findOneAndUpdate(
    {
      'analysis.status': 'pending',
      'analysis.nextAttemptAt': { $lte: now },
      $or: [{ 'analysis.leaseExpiresAt': null }, { 'analysis.leaseExpiresAt': { $lte: now } }],
    },
    {
      $set: { 'analysis.leaseExpiresAt': new Date(now.getTime() + leaseDurationMs) },
      $inc: { 'analysis.attempts': 1 },
    },
    { returnDocument: 'after', sort: { 'analysis.nextAttemptAt': 1 } },
  )
    .select({ organizationId: 1, analysis: 1 })
    .lean<ClaimedRow>()
    .exec();

  if (!row) return null;

  return {
    incidentId: row._id,
    organizationId: row.organizationId,
    attempts: row.analysis.attempts,
    requestedByUserId: row.analysis.requestedByUserId,
    requestedByName: row.analysis.requestedByName,
  };
}

/** Claims up to `batchSize` due analyses; the batch shrinks to whatever is actually due. */
export async function claimAnalysisBatch(
  options: AnalysisQueueOptions,
): Promise<readonly ClaimedAnalysis[]> {
  const claimed: ClaimedAnalysis[] = [];

  for (let index = 0; index < options.batchSize; index += 1) {
    const analysis = await claimOne(options.leaseDurationMs);
    if (!analysis) break;
    claimed.push(analysis);
  }

  return claimed;
}

const PENDING = { 'analysis.status': 'pending' } as const;

export async function completeAnalysis(
  incidentId: Types.ObjectId,
  outcome: {
    readonly at: Date;
    readonly summary: string;
    readonly provider: AiProvider;
    readonly model: string;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  },
): Promise<boolean> {
  const result = await IncidentModel.updateOne(
    { _id: incidentId, ...PENDING },
    {
      $set: {
        'analysis.status': 'completed',
        'analysis.summary': outcome.summary,
        'analysis.provider': outcome.provider,
        'analysis.model': outcome.model,
        'analysis.inputTokens': outcome.inputTokens,
        'analysis.outputTokens': outcome.outputTokens,
        'analysis.generatedAt': outcome.at,
        'analysis.failureReason': null,
        'analysis.nextAttemptAt': null,
        'analysis.leaseExpiresAt': null,
      },
    },
  ).exec();
  return result.modifiedCount > 0;
}

export async function retryAnalysis(
  incidentId: Types.ObjectId,
  outcome: { readonly nextAttemptAt: Date; readonly failureReason: string },
): Promise<void> {
  await IncidentModel.updateOne(
    { _id: incidentId, ...PENDING },
    {
      $set: {
        'analysis.nextAttemptAt': outcome.nextAttemptAt,
        'analysis.failureReason': outcome.failureReason.slice(0, 500),
        'analysis.leaseExpiresAt': null,
      },
    },
  ).exec();
}

/** Ends an analysis without a new summary: `failed` after trying, `skipped` without. */
export async function settleAnalysisWithout(
  incidentId: Types.ObjectId,
  status: 'failed' | 'skipped',
  reason: string,
): Promise<void> {
  await IncidentModel.updateOne(
    { _id: incidentId, ...PENDING },
    {
      $set: {
        'analysis.status': status,
        'analysis.failureReason': reason.slice(0, 500),
        'analysis.nextAttemptAt': null,
        'analysis.leaseExpiresAt': null,
      },
    },
  ).exec();
}
