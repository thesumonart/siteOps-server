import type { Types } from 'mongoose';

import type { CheckStatus } from '../contracts/index.js';
import { WebsiteCheckModel, type WebsiteCheckAttributes } from '../models/index.js';
import { cursorFilter, type DecodedCursor } from '../utils/pagination.js';

export interface CheckRecord extends WebsiteCheckAttributes {
  readonly _id: Types.ObjectId;
}

export interface ListChecksFilter {
  readonly websiteId: Types.ObjectId;
  readonly pageSize: number;
  readonly status?: CheckStatus | undefined;
  readonly cursor?: DecodedCursor | undefined;
}

/**
 * Raw counts for one window. Response-time figures cover successful checks
 * only — the duration of a failed check measures how long a failure took, not
 * how fast the site is, and averaging it in makes a healthy site look slow.
 */
export interface CheckTotals {
  readonly totalChecks: number;
  readonly successfulChecks: number;
  readonly averageResponseTimeMs: number | null;
  readonly fastestResponseTimeMs: number | null;
  readonly slowestResponseTimeMs: number | null;
}

export interface CheckBucket {
  readonly bucketStart: Date;
  readonly totalChecks: number;
  readonly successfulChecks: number;
  readonly averageResponseTimeMs: number | null;
}

const EMPTY_TOTALS: CheckTotals = {
  totalChecks: 0,
  successfulChecks: 0,
  averageResponseTimeMs: null,
  fastestResponseTimeMs: null,
  slowestResponseTimeMs: null,
};

/**
 * Shared by every aggregation below.
 *
 * `$cond` on `status` rather than a second `$match` keeps successful and total
 * counts in one pass. The response-time accumulators are fed `null` for failed
 * checks, and `$avg`/`$min`/`$max` ignore nulls, which is what excludes them
 * without a separate pipeline.
 */
const COUNT_ACCUMULATORS = {
  totalChecks: { $sum: 1 },
  successfulChecks: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
  averageResponseTimeMs: {
    $avg: { $cond: [{ $eq: ['$status', 'up'] }, '$responseTimeMs', null] },
  },
  fastestResponseTimeMs: {
    $min: { $cond: [{ $eq: ['$status', 'up'] }, '$responseTimeMs', null] },
  },
  slowestResponseTimeMs: {
    $max: { $cond: [{ $eq: ['$status', 'up'] }, '$responseTimeMs', null] },
  },
} as const;

interface AggregatedTotals {
  readonly totalChecks: number;
  readonly successfulChecks: number;
  readonly averageResponseTimeMs: number | null;
  readonly fastestResponseTimeMs: number | null;
  readonly slowestResponseTimeMs: number | null;
}

function roundAverage(value: number | null | undefined): number | null {
  return typeof value === 'number' ? Math.round(value) : null;
}

function toTotals(row: AggregatedTotals | undefined): CheckTotals {
  if (!row) return EMPTY_TOTALS;
  return {
    totalChecks: row.totalChecks,
    successfulChecks: row.successfulChecks,
    averageResponseTimeMs: roundAverage(row.averageResponseTimeMs),
    fastestResponseTimeMs: roundAverage(row.fastestResponseTimeMs),
    slowestResponseTimeMs: roundAverage(row.slowestResponseTimeMs),
  };
}

/**
 * Check history and its rollups.
 *
 * `website_checks` is by far the largest collection in the product — one
 * document per website per interval — so nothing here loads raw documents to
 * count them. Every summary is an aggregation the database answers from an
 * index, and every query is bounded by both a website (or organization) and a
 * time window.
 */
export class CheckResultRepository {
  async list(filter: ListChecksFilter): Promise<readonly CheckRecord[]> {
    const query: Record<string, unknown> = { websiteId: filter.websiteId };

    if (filter.status) query.status = filter.status;
    if (filter.cursor) Object.assign(query, cursorFilter('checkedAt', filter.cursor));

    // One extra document decides `hasNextPage` without a second query.
    return WebsiteCheckModel.find(query)
      .sort({ checkedAt: -1, _id: -1 })
      .limit(filter.pageSize + 1)
      .lean<CheckRecord[]>()
      .exec();
  }

  async totalsForWebsite(websiteId: Types.ObjectId, since: Date): Promise<CheckTotals> {
    const rows = await WebsiteCheckModel.aggregate<AggregatedTotals>([
      { $match: { websiteId, checkedAt: { $gte: since } } },
      { $group: { _id: null, ...COUNT_ACCUMULATORS } },
    ]).exec();

    return toTotals(rows[0]);
  }

  /** One row per website that has at least one check in the window. */
  async totalsByWebsite(
    organizationId: Types.ObjectId,
    since: Date,
  ): Promise<ReadonlyMap<string, CheckTotals>> {
    const rows = await WebsiteCheckModel.aggregate<AggregatedTotals & { _id: Types.ObjectId }>([
      { $match: { organizationId, checkedAt: { $gte: since } } },
      { $group: { _id: '$websiteId', ...COUNT_ACCUMULATORS } },
    ]).exec();

    return new Map(rows.map((row) => [row._id.toHexString(), toTotals(row)]));
  }

  /**
   * Groups checks into fixed-width buckets for the chart.
   *
   * Bucketing happens in the database because the alternative is streaming
   * every check in the window to the API process just to count them. Buckets
   * with no checks are absent from the result rather than zero-filled: a gap
   * means monitoring was paused or the worker was down, and drawing it as 0%
   * uptime would invent an outage that never happened.
   */
  async bucketsForWebsite(
    websiteId: Types.ObjectId,
    since: Date,
    bucketSeconds: number,
  ): Promise<readonly CheckBucket[]> {
    const bucketMs = bucketSeconds * 1000;

    const rows = await WebsiteCheckModel.aggregate<AggregatedTotals & { _id: number }>([
      { $match: { websiteId, checkedAt: { $gte: since } } },
      {
        $group: {
          // Floor each timestamp onto the bucket grid, in milliseconds since
          // the epoch, so buckets line up across websites and page loads.
          _id: {
            $subtract: [{ $toLong: '$checkedAt' }, { $mod: [{ $toLong: '$checkedAt' }, bucketMs] }],
          },
          ...COUNT_ACCUMULATORS,
        },
      },
      { $sort: { _id: 1 } },
    ]).exec();

    return rows.map((row) => {
      const totals = toTotals(row);
      return {
        bucketStart: new Date(row._id),
        totalChecks: totals.totalChecks,
        successfulChecks: totals.successfulChecks,
        averageResponseTimeMs: totals.averageResponseTimeMs,
      };
    });
  }
}
