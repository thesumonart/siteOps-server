export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Offset pagination, used for small bounded collections such as websites and
 * organization members where a total count is genuinely useful.
 */
export interface OffsetPaginationMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
}

export interface OffsetPaginatedResult<TItem> {
  readonly items: readonly TItem[];
  readonly pagination: OffsetPaginationMeta;
}

/**
 * Cursor pagination, used for high-volume append-only monitoring data (checks,
 * incidents, audit logs) where counting rows is wasteful and offsets drift as
 * new documents arrive.
 */
export interface CursorPaginationMeta {
  readonly nextCursor: string | null;
  readonly hasNextPage: boolean;
  readonly pageSize: number;
}

export interface CursorPaginatedResult<TItem> {
  readonly items: readonly TItem[];
  readonly pagination: CursorPaginationMeta;
}

export function buildOffsetMeta(
  page: number,
  pageSize: number,
  totalItems: number,
): OffsetPaginationMeta {
  const totalPages = pageSize > 0 ? Math.ceil(totalItems / pageSize) : 0;
  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
  };
}
