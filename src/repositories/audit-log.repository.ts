import type { Types } from 'mongoose';

import type { AuditAction, AuditArea } from '../contracts/index.js';
import { auditActionsInArea } from '../contracts/index.js';
import { AuditLogModel } from '../models/index.js';
import { toObjectId } from '../utils/object-id.js';
import { cursorFilter, type DecodedCursor } from '../utils/pagination.js';

export interface AuditLogRecord {
  readonly _id: Types.ObjectId;
  readonly organizationId: Types.ObjectId;
  readonly actorUserId: Types.ObjectId | null;
  readonly actorName: string;
  readonly action: AuditAction;
  readonly targetType: string | null;
  readonly targetId: Types.ObjectId | null;
  readonly targetLabel: string | null;
  readonly createdAt: Date;
}

export interface AuditLogEntry {
  readonly organizationId: Types.ObjectId;
  readonly action: AuditAction;
  readonly actorUserId: Types.ObjectId | null;
  /** Snapshot of the actor's name, so the feed still reads correctly after a rename. */
  readonly actorName: string;
  readonly targetType?: string;
  readonly targetId?: Types.ObjectId;
  readonly targetLabel?: string;
}

export interface ListAuditLogsFilter {
  readonly organizationId: Types.ObjectId;
  readonly pageSize: number;
  readonly area?: AuditArea | undefined;
  readonly action?: AuditAction | undefined;
  readonly actorUserId?: string | undefined;
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  readonly search?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: DecodedCursor | undefined;
}

/** An actor as it appears in the filter dropdown. */
export interface AuditActorRecord {
  readonly id: Types.ObjectId | null;
  readonly name: string;
}

/** Escapes a user string so it cannot smuggle regex syntax into a query. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Append-only record of who changed what inside an organization.
 *
 * Nothing here updates or deletes an entry. Retention is the TTL index on the
 * model, so even an owner cannot rewrite the history of their own organization
 * — which is the only property that makes an audit log worth keeping.
 */
export class AuditLogRepository {
  async record(entry: AuditLogEntry): Promise<void> {
    await AuditLogModel.create({
      organizationId: entry.organizationId,
      action: entry.action,
      actorUserId: entry.actorUserId,
      actorName: entry.actorName,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      targetLabel: entry.targetLabel ?? null,
      createdAt: new Date(),
    });
  }

  /**
   * One organization's activity, newest first.
   *
   * The unfiltered and area-filtered forms are served by
   * `audit_org_created_at`; the narrower filters (actor, target, text) are
   * applied on top of that same range and are bounded by the page size, so
   * none of them can turn into a collection scan.
   */
  async list(filter: ListAuditLogsFilter): Promise<readonly AuditLogRecord[]> {
    const query = this.buildQuery(filter);
    if (query === null) return [];

    if (filter.cursor) Object.assign(query, cursorFilter('createdAt', filter.cursor));

    // One extra document decides `hasNextPage` without a second query.
    return AuditLogModel.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(filter.pageSize + 1)
      .lean<AuditLogRecord[]>()
      .exec();
  }

  /**
   * The distinct people who appear in an organization's log, newest first.
   *
   * Capped rather than exhaustive: this populates a filter dropdown, and an
   * organization with thousands of distinct actors is better served by the
   * free-text search than by a list nobody can scroll.
   */
  async distinctActors(
    organizationId: Types.ObjectId,
    limit = 50,
  ): Promise<readonly AuditActorRecord[]> {
    const rows = await AuditLogModel.aggregate<{
      _id: Types.ObjectId | null;
      name: string;
      lastSeenAt: Date;
    }>([
      { $match: { organizationId } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$actorUserId',
          name: { $first: '$actorName' },
          lastSeenAt: { $first: '$createdAt' },
        },
      },
      { $sort: { lastSeenAt: -1 } },
      { $limit: limit },
    ]).exec();

    return rows.map((row) => ({ id: row._id, name: row.name }));
  }

  /**
   * Translates a filter into a query, or null when it can match nothing.
   *
   * Returning null rather than an impossible query keeps an unparseable id from
   * reaching the database at all — the same treatment an id belonging to
   * another tenant gets, so the two are indistinguishable from outside.
   */
  private buildQuery(filter: ListAuditLogsFilter): Record<string, unknown> | null {
    const query: Record<string, unknown> = { organizationId: filter.organizationId };

    // An explicit action is narrower than its area, so it wins outright rather
    // than being intersected with a redundant `$in`.
    if (filter.action) {
      query.action = filter.action;
    } else if (filter.area) {
      query.action = { $in: auditActionsInArea(filter.area) };
    }

    if (filter.actorUserId) {
      const actorObjectId = toObjectId(filter.actorUserId);
      if (!actorObjectId) return null;
      query.actorUserId = actorObjectId;
    }

    if (filter.targetType) query.targetType = filter.targetType;

    if (filter.targetId) {
      const targetObjectId = toObjectId(filter.targetId);
      if (!targetObjectId) return null;
      query.targetId = targetObjectId;
    }

    if (filter.search) {
      const pattern = new RegExp(escapeRegex(filter.search), 'i');
      query.$or = [{ actorName: pattern }, { targetLabel: pattern }];
    }

    if (filter.from || filter.to) {
      const range: Record<string, Date> = {};
      if (filter.from) range.$gte = new Date(filter.from);
      // Inclusive of the whole final instant the caller named; the validator
      // already rejected an inverted range.
      if (filter.to) range.$lte = new Date(filter.to);
      query.createdAt = range;
    }

    return query;
  }
}
