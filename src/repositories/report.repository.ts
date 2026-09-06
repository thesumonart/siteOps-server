import type { Types } from 'mongoose';

import type {
  ReportData,
  ReportFormat,
  ReportStatus,
  ReportType,
  ScheduleFrequency,
} from '../contracts/index.js';
import {
  ReportModel,
  ReportScheduleModel,
  type ReportAttributes,
  type ReportScheduleAttributes,
} from '../models/index.js';
import { toObjectId } from '../utils/object-id.js';
import { cursorFilter, type DecodedCursor } from '../utils/pagination.js';

export interface ReportRecord extends ReportAttributes {
  readonly _id: Types.ObjectId;
}

export interface ReportScheduleRecord extends ReportScheduleAttributes {
  readonly _id: Types.ObjectId;
}

/**
 * Reports and the schedules that produce them.
 *
 * Both are tenant-scoped in every query. The two claim methods are the
 * exception and are deliberately *not* organization-scoped: they are called by
 * the worker, which serves every tenant and has no organization context — the
 * document it claims carries its own `organizationId`, and everything the job
 * then does is scoped by that.
 */
export class ReportRepository {
  /* ---------------------------------------------------------------- reports */

  async create(input: {
    readonly organizationId: Types.ObjectId;
    readonly type: ReportType;
    readonly title: string;
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly websiteIds: readonly Types.ObjectId[];
    readonly requestedByUserId: Types.ObjectId | null;
    readonly scheduleId: Types.ObjectId | null;
  }): Promise<ReportRecord> {
    const created = await ReportModel.create({
      organizationId: input.organizationId,
      type: input.type,
      title: input.title,
      status: 'pending',
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      websiteIds: [...input.websiteIds],
      requestedByUserId: input.requestedByUserId,
      scheduleId: input.scheduleId,
      // Due immediately: the worker picks it up on its next pass.
      nextAttemptAt: new Date(),
    });

    return created.toObject<ReportRecord>();
  }

  async list(filter: {
    readonly organizationId: Types.ObjectId;
    readonly pageSize: number;
    readonly status?: ReportStatus | undefined;
    readonly type?: ReportType | undefined;
    readonly cursor?: DecodedCursor | undefined;
  }): Promise<readonly ReportRecord[]> {
    const query: Record<string, unknown> = { organizationId: filter.organizationId };
    if (filter.status) query.status = filter.status;
    if (filter.type) query.type = filter.type;
    if (filter.cursor) Object.assign(query, cursorFilter('createdAt', filter.cursor));

    return (
      ReportModel.find(query)
        .sort({ createdAt: -1, _id: -1 })
        .limit(filter.pageSize + 1)
        // The list never needs the payload, and a report's data can be
        // hundreds of kilobytes — loading fifty of them to render a table of
        // titles would be the single heaviest query in the product.
        .select({ data: 0 })
        .lean<ReportRecord[]>()
        .exec()
    );
  }

  async findById(organizationId: Types.ObjectId, reportId: string): Promise<ReportRecord | null> {
    const reportObjectId = toObjectId(reportId);
    if (!reportObjectId) return null;

    return ReportModel.findOne({ _id: reportObjectId, organizationId }).lean<ReportRecord>().exec();
  }

  async delete(organizationId: Types.ObjectId, reportId: string): Promise<ReportRecord | null> {
    const reportObjectId = toObjectId(reportId);
    if (!reportObjectId) return null;

    return ReportModel.findOneAndDelete({ _id: reportObjectId, organizationId })
      .lean<ReportRecord>()
      .exec();
  }

  async countForOrganization(organizationId: Types.ObjectId): Promise<number> {
    return ReportModel.countDocuments({ organizationId }).exec();
  }

  /**
   * Claims one report awaiting generation.
   *
   * The same atomic claim as every other queue here. `generating` is included
   * in the filter so a report abandoned by a crashed worker is reclaimed once
   * its lease expires, rather than staying "generating" forever.
   */
  async claimPending(leaseDurationMs: number): Promise<ReportRecord | null> {
    const now = new Date();

    return ReportModel.findOneAndUpdate(
      {
        status: { $in: ['pending', 'generating'] },
        nextAttemptAt: { $lte: now },
        $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
      },
      {
        $set: { status: 'generating', leaseExpiresAt: new Date(now.getTime() + leaseDurationMs) },
        $inc: { attemptCount: 1 },
      },
      { returnDocument: 'after', sort: { nextAttemptAt: 1 } },
    )
      .lean<ReportRecord>()
      .exec();
  }

  async markReady(reportId: Types.ObjectId, data: ReportData): Promise<void> {
    await ReportModel.updateOne(
      { _id: reportId },
      {
        $set: {
          status: 'ready',
          data,
          generatedAt: new Date(),
          errorMessage: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
        },
      },
    ).exec();
  }

  /**
   * Records a failed attempt, retrying with backoff until the cap.
   *
   * A report that keeps failing settles on `failed` with the reason visible,
   * rather than being retried forever — the usual cause is a query that will
   * fail identically next time.
   */
  async markAttemptFailed(
    reportId: Types.ObjectId,
    attemptCount: number,
    maxAttempts: number,
    reason: string,
  ): Promise<void> {
    const exhausted = attemptCount >= maxAttempts;

    await ReportModel.updateOne(
      { _id: reportId },
      {
        $set: {
          status: exhausted ? 'failed' : 'pending',
          errorMessage: reason.slice(0, 500),
          leaseExpiresAt: null,
          nextAttemptAt: exhausted ? null : new Date(Date.now() + 2 ** attemptCount * 30_000),
        },
      },
    ).exec();
  }

  /* -------------------------------------------------------------- schedules */

  async createSchedule(input: {
    readonly organizationId: Types.ObjectId;
    readonly name: string;
    readonly frequency: ScheduleFrequency;
    readonly dayOfWeek: number;
    readonly hourUtc: number;
    readonly type: ReportType;
    readonly websiteIds: readonly Types.ObjectId[];
    readonly format: ReportFormat;
    readonly recipients: readonly string[];
    readonly enabled: boolean;
    readonly nextRunAt: Date;
    readonly createdByUserId: Types.ObjectId;
  }): Promise<ReportScheduleRecord> {
    const created = await ReportScheduleModel.create({
      ...input,
      websiteIds: [...input.websiteIds],
      recipients: [...input.recipients],
    });

    return created.toObject<ReportScheduleRecord>();
  }

  async listSchedules(organizationId: Types.ObjectId): Promise<readonly ReportScheduleRecord[]> {
    return ReportScheduleModel.find({ organizationId })
      .sort({ createdAt: -1 })
      .lean<ReportScheduleRecord[]>()
      .exec();
  }

  async findScheduleById(
    organizationId: Types.ObjectId,
    scheduleId: string,
  ): Promise<ReportScheduleRecord | null> {
    const scheduleObjectId = toObjectId(scheduleId);
    if (!scheduleObjectId) return null;

    return ReportScheduleModel.findOne({ _id: scheduleObjectId, organizationId })
      .lean<ReportScheduleRecord>()
      .exec();
  }

  async updateSchedule(
    organizationId: Types.ObjectId,
    scheduleId: string,
    changes: Partial<
      Pick<
        ReportScheduleAttributes,
        | 'name'
        | 'frequency'
        | 'dayOfWeek'
        | 'hourUtc'
        | 'websiteIds'
        | 'format'
        | 'recipients'
        | 'enabled'
        | 'nextRunAt'
      >
    >,
  ): Promise<ReportScheduleRecord | null> {
    const scheduleObjectId = toObjectId(scheduleId);
    if (!scheduleObjectId) return null;

    return ReportScheduleModel.findOneAndUpdate(
      { _id: scheduleObjectId, organizationId },
      { $set: changes },
      { returnDocument: 'after' },
    )
      .lean<ReportScheduleRecord>()
      .exec();
  }

  async deleteSchedule(
    organizationId: Types.ObjectId,
    scheduleId: string,
  ): Promise<ReportScheduleRecord | null> {
    const scheduleObjectId = toObjectId(scheduleId);
    if (!scheduleObjectId) return null;

    return ReportScheduleModel.findOneAndDelete({ _id: scheduleObjectId, organizationId })
      .lean<ReportScheduleRecord>()
      .exec();
  }

  async countSchedulesForOrganization(organizationId: Types.ObjectId): Promise<number> {
    return ReportScheduleModel.countDocuments({ organizationId }).exec();
  }

  /** Claims one due schedule. Duplicate claims would mail a client twice. */
  async claimDueSchedule(leaseDurationMs: number): Promise<ReportScheduleRecord | null> {
    const now = new Date();

    return ReportScheduleModel.findOneAndUpdate(
      {
        enabled: true,
        nextRunAt: { $lte: now },
        $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
      },
      { $set: { leaseExpiresAt: new Date(now.getTime() + leaseDurationMs) } },
      { returnDocument: 'after', sort: { nextRunAt: 1 } },
    )
      .lean<ReportScheduleRecord>()
      .exec();
  }

  /** Releases a schedule's lease and moves it to its next occurrence. */
  async completeScheduleRun(
    scheduleId: Types.ObjectId,
    nextRunAt: Date,
    outcome: { readonly reportId: Types.ObjectId | null; readonly error: string | null },
  ): Promise<void> {
    await ReportScheduleModel.updateOne(
      { _id: scheduleId },
      {
        $set: {
          leaseExpiresAt: null,
          lastRunAt: new Date(),
          nextRunAt,
          lastReportId: outcome.reportId,
          lastError: outcome.error?.slice(0, 500) ?? null,
        },
      },
    ).exec();
  }

  /** Removes reports and schedules for a deleted website's organization scope. */
  async detachWebsite(websiteId: Types.ObjectId): Promise<void> {
    await Promise.all([
      ReportModel.updateMany(
        { websiteIds: websiteId },
        { $pull: { websiteIds: websiteId } },
      ).exec(),
      ReportScheduleModel.updateMany(
        { websiteIds: websiteId },
        { $pull: { websiteIds: websiteId } },
      ).exec(),
    ]);
  }
}
