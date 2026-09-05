import type { Types } from 'mongoose';

import type { AuditAction } from '../contracts/index.js';
import { AuditLogModel } from '../models/index.js';
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

/** Append-only record of who changed what inside an organization. */
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

  /** One organization's activity, newest first. Served by `audit_org_created_at`. */
  async list(filter: {
    readonly organizationId: Types.ObjectId;
    readonly pageSize: number;
    readonly cursor?: DecodedCursor | undefined;
  }): Promise<readonly AuditLogRecord[]> {
    const query: Record<string, unknown> = { organizationId: filter.organizationId };
    if (filter.cursor) Object.assign(query, cursorFilter('createdAt', filter.cursor));

    // One extra document decides `hasNextPage` without a second query.
    return AuditLogModel.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(filter.pageSize + 1)
      .lean<AuditLogRecord[]>()
      .exec();
  }
}
