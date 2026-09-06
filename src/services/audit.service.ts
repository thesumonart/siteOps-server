import type {
  AuditActorDto,
  AuditLogDto,
  CursorPaginatedResult,
  ListAuditLogsQuery,
} from '../contracts/index.js';
import { areaOfAuditAction } from '../contracts/index.js';
import type {
  AuditLogEntry,
  AuditLogRecord,
  AuditLogRepository,
} from '../repositories/audit-log.repository.js';
import type { OrganizationContext } from '../types/common.types.js';
import { createLogger } from '../utils/logger.js';
import { decodeOptionalCursor, encodeCursor } from '../utils/pagination.js';

const logger = createLogger('audit');

/**
 * Records — and reads back — who changed what inside an organization.
 *
 * Recording is best-effort by design: a failure to write the activity feed must
 * never roll back the action the user actually asked for. Failures are logged
 * so the gap is visible rather than silent.
 *
 * Reading is not best-effort. The feed is a security surface, so a failed read
 * propagates rather than rendering an empty list that looks like "nothing
 * happened".
 */
export class AuditService {
  constructor(private readonly repository: AuditLogRepository) {}

  async record(entry: AuditLogEntry): Promise<void> {
    try {
      await this.repository.record(entry);
    } catch (error) {
      logger.error(
        {
          err: error,
          action: entry.action,
          organizationId: entry.organizationId.toHexString(),
        },
        'audit.write_failed',
      );
    }
  }

  /**
   * One page of the organization's activity, newest first.
   *
   * Cursor-paged like every other append-only feed in the product: entries
   * arrive while someone is reading, and an offset would shift every row down
   * as they do.
   */
  async list(
    organization: OrganizationContext,
    query: ListAuditLogsQuery,
  ): Promise<CursorPaginatedResult<AuditLogDto>> {
    const rows = await this.repository.list({
      organizationId: organization.objectId,
      pageSize: query.pageSize,
      area: query.area,
      action: query.action,
      actorUserId: query.actorUserId,
      targetType: query.targetType,
      targetId: query.targetId,
      search: query.search,
      from: query.from,
      to: query.to,
      cursor: decodeOptionalCursor(query.cursor),
    });

    const hasNextPage = rows.length > query.pageSize;
    const items = hasNextPage ? rows.slice(0, query.pageSize) : rows;
    const last = items.at(-1);

    return {
      items: items.map(toAuditLogDto),
      pagination: {
        nextCursor: hasNextPage && last ? encodeCursor(last.createdAt, last._id) : null,
        hasNextPage,
        pageSize: query.pageSize,
      },
    };
  }

  /** Distinct actors, for the filter dropdown. */
  async actors(organization: OrganizationContext): Promise<readonly AuditActorDto[]> {
    const rows = await this.repository.distinctActors(organization.objectId);
    return rows.map((row) => ({ id: row.id?.toHexString() ?? null, name: row.name }));
  }
}

export function toAuditLogDto(entry: AuditLogRecord): AuditLogDto {
  return {
    id: entry._id.toHexString(),
    action: entry.action,
    area: areaOfAuditAction(entry.action),
    actorId: entry.actorUserId?.toHexString() ?? null,
    actorName: entry.actorName,
    targetType: entry.targetType,
    targetId: entry.targetId?.toHexString() ?? null,
    targetLabel: entry.targetLabel,
    createdAt: entry.createdAt.toISOString(),
  };
}
