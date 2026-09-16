import type { Types } from 'mongoose';

import type { IncidentCategory, IncidentType } from '../contracts/index.js';
import { ANALYZABLE_INCIDENT_CATEGORIES } from '../contracts/index.js';
import type { AnalysisCheck } from '../ai/incident-facts.js';
import { AiUsageModel, IncidentModel, WebsiteCheckModel, WebsiteModel } from '../models/index.js';
import { toObjectId } from '../utils/object-id.js';
import type { IncidentRecord } from './incident.repository.js';
import { isDuplicateKeyError } from './notification.repository.js';

export interface CheckRange {
  readonly $gte?: Date;
  readonly $gt?: Date;
  readonly $lt?: Date;
  readonly $lte?: Date;
}

export interface AnalysisWebsite {
  readonly name: string;
  readonly url: string;
  readonly monitoringIntervalSeconds: number;
}

export interface RelatedIncidentRow {
  readonly type: IncidentType;
  readonly category: IncidentCategory;
  readonly startedAt: Date;
  readonly resolvedAt: Date | null;
}

/** At most this many overlapping incidents are described; more is noise, not context. */
const MAX_RELATED_INCIDENTS = 20;

const CHECK_FIELDS = {
  checkedAt: 1,
  status: 1,
  statusCode: 1,
  responseTimeMs: 1,
  errorType: 1,
  errorMessage: 1,
  anomalous: 1,
  zScore: 1,
} as const;

/**
 * Reads for writing an incident analysis, the requests that queue one, and the
 * monthly generation allowance.
 *
 * The queue transitions themselves — claim, complete, retry — live in
 * `queues/incident-analysis.queue.ts` beside the other queues.
 */
export class IncidentAnalysisRepository {
  /**
   * An incident, only if it is the organization's — and, for a client
   * membership, only if its website is assigned to that client.
   */
  async findIncident(
    organizationId: Types.ObjectId,
    incidentId: string,
    clientScope: Types.ObjectId | null,
  ): Promise<IncidentRecord | null> {
    const incidentObjectId = toObjectId(incidentId);
    if (!incidentObjectId) return null;

    const incident = await IncidentModel.findOne({ _id: incidentObjectId, organizationId })
      .lean<IncidentRecord>()
      .exec();
    if (!incident || clientScope === null) return incident;

    const visible = await WebsiteModel.exists({
      _id: incident.websiteId,
      organizationId,
      clientId: clientScope,
    }).exec();
    return visible ? incident : null;
  }

  async findIncidentById(
    organizationId: Types.ObjectId,
    incidentId: Types.ObjectId,
  ): Promise<IncidentRecord | null> {
    return IncidentModel.findOne({ _id: incidentId, organizationId }).lean<IncidentRecord>().exec();
  }

  async websiteFor(
    organizationId: Types.ObjectId,
    websiteId: Types.ObjectId,
  ): Promise<AnalysisWebsite | null> {
    return WebsiteModel.findOne({ _id: websiteId, organizationId })
      .select({ name: 1, url: 1, monitoringIntervalSeconds: 1 })
      .lean<AnalysisWebsite>()
      .exec();
  }

  /** Checks in a range, oldest first — or the newest `limit` of them when `newestFirst`. */
  async checks(
    websiteId: Types.ObjectId,
    range: CheckRange,
    options: { readonly limit: number; readonly newestFirst?: boolean },
  ): Promise<AnalysisCheck[]> {
    const direction = options.newestFirst ? -1 : 1;
    const rows = await WebsiteCheckModel.find({ websiteId, checkedAt: range })
      .select(CHECK_FIELDS)
      .sort({ checkedAt: direction, _id: direction })
      .limit(options.limit)
      .lean<AnalysisCheck[]>()
      .exec();

    return rows.map((row) => ({
      checkedAt: row.checkedAt,
      status: row.status,
      statusCode: row.statusCode,
      responseTimeMs: row.responseTimeMs,
      errorType: row.errorType,
      errorMessage: row.errorMessage,
      // Checks written before anomaly detection carry neither field.
      anomalous: row.anomalous ?? false,
      zScore: row.zScore ?? null,
    }));
  }

  async countChecks(websiteId: Types.ObjectId, range: CheckRange): Promise<number> {
    return WebsiteCheckModel.countDocuments({ websiteId, checkedAt: range }).exec();
  }

  /** Other incidents on the same website that overlapped `[from, to]`. */
  async relatedIncidents(
    organizationId: Types.ObjectId,
    websiteId: Types.ObjectId,
    excludeId: Types.ObjectId,
    from: Date,
    to: Date,
  ): Promise<readonly RelatedIncidentRow[]> {
    return IncidentModel.find({
      organizationId,
      websiteId,
      _id: { $ne: excludeId },
      startedAt: { $lte: to },
      $or: [{ resolvedAt: null }, { resolvedAt: { $gte: from } }],
    })
      .select({ type: 1, category: 1, startedAt: 1, resolvedAt: 1 })
      .sort({ startedAt: -1 })
      .limit(MAX_RELATED_INCIDENTS)
      .lean<RelatedIncidentRow[]>()
      .exec();
  }

  async countIncidentsSince(
    organizationId: Types.ObjectId,
    websiteId: Types.ObjectId,
    since: Date,
    category?: IncidentCategory,
  ): Promise<number> {
    return IncidentModel.countDocuments({
      organizationId,
      websiteId,
      startedAt: { $gte: since },
      ...(category ? { category } : {}),
    }).exec();
  }

  /**
   * Queues the analysis of an incident that has just resolved, once.
   *
   * Every condition is in the filter, so the write is its own guard: an
   * incident that is not resolved, is not an outage or slowdown, was too short,
   * or already has an analysis in any state matches nothing. Two processes
   * resolving the same incident — or a replayed job — queue it at most once.
   */
  async enqueueAutomatic(
    incidentId: Types.ObjectId,
    options: { readonly now: Date; readonly readyAt: Date; readonly minDurationSeconds: number },
  ): Promise<boolean> {
    const result = await IncidentModel.updateOne(
      {
        _id: incidentId,
        status: 'resolved',
        category: { $in: ANALYZABLE_INCIDENT_CATEGORIES },
        durationSeconds: { $gte: options.minDurationSeconds },
        analysis: null,
      },
      {
        $set: {
          analysis: pendingAnalysis({
            now: options.now,
            readyAt: options.readyAt,
            requestedByUserId: null,
            requestedByName: null,
          }),
        },
      },
    ).exec();
    return result.modifiedCount > 0;
  }

  /**
   * Queues an analysis a person asked for, now.
   *
   * Refuses — returns null — for an incident that is not resolved or already
   * has one pending. A previous summary is kept until the new one replaces it,
   * so asking again never leaves the incident with nothing to read.
   */
  async requestAnalysis(
    organizationId: Types.ObjectId,
    incidentId: Types.ObjectId,
    requester: {
      readonly now: Date;
      readonly requestedByUserId: Types.ObjectId | null;
      readonly requestedByName: string;
    },
  ): Promise<IncidentRecord | null> {
    const base = { _id: incidentId, organizationId, status: 'resolved' } as const;

    const first = await IncidentModel.findOneAndUpdate(
      { ...base, analysis: null },
      { $set: { analysis: pendingAnalysis({ ...requester, readyAt: requester.now }) } },
      { returnDocument: 'after' },
    )
      .lean<IncidentRecord>()
      .exec();
    if (first) return first;

    return IncidentModel.findOneAndUpdate(
      { ...base, analysis: { $ne: null }, 'analysis.status': { $ne: 'pending' } },
      {
        $set: {
          'analysis.status': 'pending',
          'analysis.requestedAt': requester.now,
          'analysis.requestedByUserId': requester.requestedByUserId,
          'analysis.requestedByName': requester.requestedByName,
          'analysis.attempts': 0,
          'analysis.nextAttemptAt': requester.now,
          'analysis.leaseExpiresAt': null,
          'analysis.failureReason': null,
        },
      },
      { returnDocument: 'after' },
    )
      .lean<IncidentRecord>()
      .exec();
  }

  /**
   * Takes one generation from the organization's monthly allowance, or refuses.
   *
   * Atomic, and done before the provider is called: the filter only matches a
   * counter still under `limit`, so concurrent analyses cannot each see room
   * and all spend it. With no counter yet the upsert creates it; with one
   * already at the limit the upsert collides with the unique index instead,
   * which is the refusal.
   */
  async reserveGeneration(
    organizationId: Types.ObjectId,
    now: Date,
    limit: number,
  ): Promise<boolean> {
    if (limit <= 0) return false;
    const { month, monthStart } = utcMonth(now);
    const filter = { organizationId, month, generations: { $lt: limit } };
    const update = { $inc: { generations: 1 }, $setOnInsert: { monthStart } };

    try {
      const row = await AiUsageModel.findOneAndUpdate(filter, update, {
        upsert: true,
        returnDocument: 'after',
      }).exec();
      return row !== null;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // Either the counter is at the limit, or another process created it a
      // moment ago. Without the upsert, only the second can still succeed.
      const row = await AiUsageModel.findOneAndUpdate(filter, update, {
        returnDocument: 'after',
      }).exec();
      return row !== null;
    }
  }

  /** Gives back a reservation whose generation produced nothing. */
  async releaseGeneration(organizationId: Types.ObjectId, reservedAt: Date): Promise<void> {
    await AiUsageModel.updateOne(
      { organizationId, month: utcMonth(reservedAt).month, generations: { $gt: 0 } },
      { $inc: { generations: -1 } },
    ).exec();
  }

  async generationsThisMonth(
    organizationId: Types.ObjectId,
    now: Date = new Date(),
  ): Promise<number> {
    const row = await AiUsageModel.findOne({ organizationId, month: utcMonth(now).month })
      .select({ generations: 1 })
      .lean<{ generations: number }>()
      .exec();
    return row?.generations ?? 0;
  }
}

function pendingAnalysis(input: {
  readonly now: Date;
  readonly readyAt: Date;
  readonly requestedByUserId: Types.ObjectId | null;
  readonly requestedByName: string | null;
}) {
  return {
    status: 'pending' as const,
    requestedAt: input.now,
    requestedByUserId: input.requestedByUserId,
    requestedByName: input.requestedByName,
    attempts: 0,
    nextAttemptAt: input.readyAt,
    leaseExpiresAt: null,
    summary: null,
    provider: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    generatedAt: null,
    failureReason: null,
  };
}

function utcMonth(now: Date): { readonly month: string; readonly monthStart: Date } {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { month: monthStart.toISOString().slice(0, 7), monthStart };
}
