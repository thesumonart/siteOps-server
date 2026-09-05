import type { Response } from 'express';

import type {
  ApiErrorBody,
  ApiErrorResponse,
  ApiSuccessResponse,
  CursorPaginatedResult,
  OffsetPaginatedResult,
} from '../contracts/index.js';
import { buildOffsetMeta } from '../contracts/index.js';

/**
 * The single place a response body is shaped.
 *
 * Every success is `{ success: true, data }` and every failure is
 * `{ success: false, error: { code, message, fields? } }`. That envelope is not
 * a preference — `siteOps-client/src/lib/api-client.ts` unwraps exactly this
 * shape and turns `error.code` into the typed `ApiError` the whole dashboard
 * branches on. Adding a field at the top level, or moving pagination out of
 * `data`, breaks every screen at once.
 *
 * Pagination therefore travels *inside* `data`, as `{ items, pagination }` —
 * the {@link OffsetPaginatedResult} and {@link CursorPaginatedResult} shapes
 * the client already has types for.
 */
export const ApiResponse = {
  /** 200 with a payload. */
  ok<TData>(response: Response, data: TData): Response {
    return response.status(200).json({ success: true, data } satisfies ApiSuccessResponse<TData>);
  },

  /** 201 for a resource that was just created. */
  created<TData>(response: Response, data: TData): Response {
    return response.status(201).json({ success: true, data } satisfies ApiSuccessResponse<TData>);
  },

  /**
   * 204 with no body at all.
   *
   * The client short-circuits on this status before it tries to parse JSON, so
   * a body here would be silently discarded — better to not send one.
   */
  noContent(response: Response): Response {
    return response.status(204).end();
  },

  /** 200 with an offset-paginated page and its metadata. */
  paginated<TItem>(
    response: Response,
    items: readonly TItem[],
    page: number,
    pageSize: number,
    totalItems: number,
  ): Response {
    const body: OffsetPaginatedResult<TItem> = {
      items,
      pagination: buildOffsetMeta(page, pageSize, totalItems),
    };
    return ApiResponse.ok(response, body);
  },

  /** 200 with a cursor-paginated page and its metadata. */
  cursorPaginated<TItem>(
    response: Response,
    items: readonly TItem[],
    nextCursor: string | null,
    pageSize: number,
  ): Response {
    const body: CursorPaginatedResult<TItem> = {
      items,
      pagination: { nextCursor, hasNextPage: nextCursor !== null, pageSize },
    };
    return ApiResponse.ok(response, body);
  },

  /**
   * A failure, in the documented envelope.
   *
   * Reached only from the global error handler; application code throws an
   * `ApiError` instead of calling this, so there is one place that decides what
   * a failure looks like on the wire.
   */
  error(response: Response, statusCode: number, error: ApiErrorBody): Response {
    return response.status(statusCode).json({ success: false, error } satisfies ApiErrorResponse);
  },
} as const;
