import { z } from 'zod';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../api/pagination.js';

/** A 24-character hexadecimal MongoDB ObjectId, as it appears in the API. */
export const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid identifier.');

export const offsetPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type OffsetPaginationQuery = z.infer<typeof offsetPaginationQuerySchema>;

export const cursorPaginationQuerySchema = z.object({
  /** Opaque to the client: an encoded position, never a raw database value. */
  cursor: z.string().min(1).max(256).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type CursorPaginationQuery = z.infer<typeof cursorPaginationQuerySchema>;

export const isoDateStringSchema = z.iso.datetime({ offset: true });

/**
 * Trims and collapses internal whitespace before validation so that a name of
 * only spaces fails `min(1)` rather than being stored blank.
 */
export const humanNameSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Required.').max(120, 'Must be 120 characters or fewer.'));
