import { listWebsiteChecksQuerySchema, websiteStatsQuerySchema } from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';
import { websiteParamsSchema } from './common.validator.js';

export const reportValidators = {
  websiteStats: {
    params: websiteParamsSchema,
    query: websiteStatsQuerySchema,
  } satisfies ValidationSchemas,
  websiteUptime: {
    params: websiteParamsSchema,
    query: websiteStatsQuerySchema,
  } satisfies ValidationSchemas,
  websiteChecks: {
    params: websiteParamsSchema,
    query: listWebsiteChecksQuerySchema,
  } satisfies ValidationSchemas,
} as const;
