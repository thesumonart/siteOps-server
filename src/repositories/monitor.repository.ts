import type { Types } from 'mongoose';

import type { MonitorConfig, MonitorStatus, MonitorType } from '../contracts/index.js';
import {
  MonitorResultModel,
  WebsiteMonitorModel,
  type MonitorResultAttributes,
  type WebsiteMonitorAttributes,
} from '../models/index.js';
import { toObjectId } from '../utils/object-id.js';
import { cursorFilter, type DecodedCursor } from '../utils/pagination.js';

export interface MonitorRecord extends WebsiteMonitorAttributes {
  readonly _id: Types.ObjectId;
}

export interface MonitorResultRecord extends MonitorResultAttributes {
  readonly _id: Types.ObjectId;
}

export interface MonitorStatusCount {
  readonly type: MonitorType;
  readonly status: MonitorStatus;
  readonly count: number;
}

/**
 * Auxiliary monitor configuration and results.
 *
 * Every method takes `organizationId` and every query filters on it, in the
 * same way as every other repository here: a monitor belonging to another
 * tenant does not resolve at all, rather than resolving and then being
 * rejected.
 *
 * The one exception is deliberate and marked: `deleteForWebsite` is called from
 * website deletion, which has already resolved the website inside a
 * tenant-scoped query.
 */
export class MonitorRepository {
  /** Every monitor configured for one website. */
  async listForWebsite(
    organizationId: Types.ObjectId,
    websiteId: Types.ObjectId,
  ): Promise<readonly MonitorRecord[]> {
    return WebsiteMonitorModel.find({ organizationId, websiteId })
      .sort({ type: 1 })
      .lean<MonitorRecord[]>()
      .exec();
  }

  async findByType(
    organizationId: Types.ObjectId,
    websiteId: Types.ObjectId,
    type: MonitorType,
  ): Promise<MonitorRecord | null> {
    return WebsiteMonitorModel.findOne({ organizationId, websiteId, type })
      .lean<MonitorRecord>()
      .exec();
  }

  /**
   * Creates the monitor if it does not exist, then applies the changes.
   *
   * An upsert rather than a create-then-update, because a monitor is
   * conceptually always there — the website either has SSL checking on or off,
   * and the row is an implementation detail of storing that. Turning one on for
   * the first time and adjusting it later should be the same request.
   *
   * `$setOnInsert` carries the fields that only make sense at creation, and no
   * field appears in both operators — MongoDB rejects that outright.
   */
  async upsert(input: {
    readonly organizationId: Types.ObjectId;
    readonly websiteId: Types.ObjectId;
    readonly type: MonitorType;
    readonly defaultIntervalSeconds: number;
    readonly defaultConfig: MonitorConfig;
    readonly changes: {
      readonly enabled?: boolean;
      readonly intervalSeconds?: number;
      readonly config?: MonitorConfig;
    };
  }): Promise<MonitorRecord> {
    const { changes } = input;

    const set: Record<string, unknown> = {};
    if (changes.enabled !== undefined) set.enabled = changes.enabled;
    if (changes.intervalSeconds !== undefined) set.intervalSeconds = changes.intervalSeconds;
    if (changes.config !== undefined) set.config = changes.config;

    /*
     * Enabling a monitor makes it due immediately, so the first result appears
     * within a poll interval rather than after a full day. Disabling does not
     * touch the schedule: the claim query already filters on `enabled`, and
     * leaving `nextRunAt` alone means re-enabling resumes the original cadence
     * instead of restarting it.
     */
    if (changes.enabled === true) set.nextRunAt = new Date();

    const setOnInsert: Record<string, unknown> = {
      organizationId: input.organizationId,
      websiteId: input.websiteId,
      type: input.type,
      status: 'unknown',
      lastRunAt: null,
      lastSummary: null,
      consecutiveErrors: 0,
      currentIncidentId: null,
    };
    if (changes.enabled === undefined) setOnInsert.enabled = false;
    if (changes.intervalSeconds === undefined) {
      setOnInsert.intervalSeconds = input.defaultIntervalSeconds;
    }
    if (changes.config === undefined) setOnInsert.config = input.defaultConfig;
    if (changes.enabled !== true) setOnInsert.nextRunAt = new Date();

    const updated = await WebsiteMonitorModel.findOneAndUpdate(
      { organizationId: input.organizationId, websiteId: input.websiteId, type: input.type },
      { $set: set, $setOnInsert: setOnInsert },
      { upsert: true, returnDocument: 'after' },
    )
      .lean<MonitorRecord>()
      .exec();

    // Unreachable: an upsert with `returnDocument: 'after'` always yields one.
    if (!updated) throw new Error(`Monitor ${input.type} could not be written.`);
    return updated;
  }

  /** Makes a monitor due now, for a manual "run it again" from the UI. */
  async scheduleNow(
    organizationId: Types.ObjectId,
    monitorId: Types.ObjectId,
  ): Promise<MonitorRecord | null> {
    return WebsiteMonitorModel.findOneAndUpdate(
      { _id: monitorId, organizationId, enabled: true },
      { $set: { nextRunAt: new Date() } },
      { returnDocument: 'after' },
    )
      .lean<MonitorRecord>()
      .exec();
  }

  /**
   * Removes every monitor and result for a website.
   *
   * Not organization-scoped: the caller resolved this website inside a
   * tenant-scoped query before deleting it, and adding the filter here would
   * only be a redundant condition on a delete that cannot widen anyone's reach.
   */
  async deleteForWebsite(websiteId: Types.ObjectId): Promise<number> {
    const [monitors] = await Promise.all([
      WebsiteMonitorModel.deleteMany({ websiteId }).exec(),
      MonitorResultModel.deleteMany({ websiteId }).exec(),
    ]);
    return monitors.deletedCount;
  }

  /** The most recent result for each monitor of a website, keyed by monitor id. */
  async latestResultsFor(
    websiteId: Types.ObjectId,
  ): Promise<ReadonlyMap<string, MonitorResultRecord>> {
    const rows = await MonitorResultModel.aggregate<MonitorResultRecord>([
      { $match: { websiteId } },
      { $sort: { checkedAt: -1 } },
      { $group: { _id: '$monitorId', latest: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$latest' } },
    ]).exec();

    return new Map(rows.map((row) => [row.monitorId.toHexString(), row]));
  }

  /** One monitor's result history, newest first, cursor-paged. */
  async listResults(filter: {
    readonly organizationId: Types.ObjectId;
    readonly monitorId: Types.ObjectId;
    readonly pageSize: number;
    readonly status?: MonitorStatus | undefined;
    readonly cursor?: DecodedCursor | undefined;
  }): Promise<readonly MonitorResultRecord[]> {
    const query: Record<string, unknown> = {
      organizationId: filter.organizationId,
      monitorId: filter.monitorId,
    };
    if (filter.status) query.status = filter.status;
    if (filter.cursor) Object.assign(query, cursorFilter('checkedAt', filter.cursor));

    // One extra document decides `hasNextPage` without a second query.
    return MonitorResultModel.find(query)
      .sort({ checkedAt: -1, _id: -1 })
      .limit(filter.pageSize + 1)
      .lean<MonitorResultRecord[]>()
      .exec();
  }

  /**
   * Monitor counts by type and status, for the organization overview.
   *
   * One grouped aggregation rather than a count per cell: numbers on a summary
   * card must come from a single read, or they can disagree with each other
   * when a monitor completes between two queries.
   */
  async countByTypeAndStatus(
    organizationId: Types.ObjectId,
  ): Promise<readonly MonitorStatusCount[]> {
    const rows = await WebsiteMonitorModel.aggregate<{
      _id: { type: MonitorType; status: MonitorStatus };
      count: number;
    }>([
      { $match: { organizationId, enabled: true } },
      { $group: { _id: { type: '$type', status: '$status' }, count: { $sum: 1 } } },
    ]).exec();

    return rows.map((row) => ({ type: row._id.type, status: row._id.status, count: row.count }));
  }

  /**
   * Results for a whole organization over a period, for report generation.
   *
   * Returns the latest result per website per type rather than every run: a
   * monthly report wants "where does each site stand", not thirty certificate
   * checks that all said the same thing.
   */
  async latestResultsInPeriod(
    organizationId: Types.ObjectId,
    from: Date,
    to: Date,
    websiteIds?: readonly Types.ObjectId[],
  ): Promise<readonly MonitorResultRecord[]> {
    const match: Record<string, unknown> = {
      organizationId,
      checkedAt: { $gte: from, $lte: to },
    };
    if (websiteIds && websiteIds.length > 0) match.websiteId = { $in: websiteIds };

    return MonitorResultModel.aggregate<MonitorResultRecord>([
      { $match: match },
      { $sort: { checkedAt: -1 } },
      {
        $group: {
          _id: { websiteId: '$websiteId', type: '$type' },
          latest: { $first: '$$ROOT' },
        },
      },
      { $replaceRoot: { newRoot: '$latest' } },
    ]).exec();
  }

  async countEnabledForOrganization(organizationId: Types.ObjectId): Promise<number> {
    return WebsiteMonitorModel.countDocuments({ organizationId, enabled: true }).exec();
  }

  /** Resolves a monitor id within a tenant, for the results route. */
  async findById(organizationId: Types.ObjectId, monitorId: string): Promise<MonitorRecord | null> {
    const monitorObjectId = toObjectId(monitorId);
    if (!monitorObjectId) return null;

    return WebsiteMonitorModel.findOne({ _id: monitorObjectId, organizationId })
      .lean<MonitorRecord>()
      .exec();
  }
}
