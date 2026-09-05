import { z } from 'zod';

import { CHECK_STATUSES, STATS_RANGES } from '../domain/check.js';
import { cursorPaginationQuerySchema } from './common.js';

/**
 * Query shapes for reading monitoring history.
 *
 * The range is a closed enum rather than a pair of dates: an open-ended window
 * lets a caller ask the API to scan an organization's entire check history,
 * which is the largest collection in the product.
 */
export const websiteStatsQuerySchema = z.object({
  range: z.enum(STATS_RANGES).default('24h'),
});

export type WebsiteStatsQuery = z.infer<typeof websiteStatsQuerySchema>;

export const listWebsiteChecksQuerySchema = cursorPaginationQuerySchema.extend({
  status: z.enum(CHECK_STATUSES).optional(),
});

export type ListWebsiteChecksQuery = z.infer<typeof listWebsiteChecksQuerySchema>;
