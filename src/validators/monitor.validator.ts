import { z } from 'zod';

import {
  listMonitorResultsQuerySchema,
  MONITOR_TYPES,
  objectIdSchema,
  updateMonitorSchema,
} from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';
import { websiteParamsSchema } from './common.validator.js';

/**
 * The monitor type travels in the path, so it is validated as a route parameter
 * rather than in the contract: a browser form picks it from a fixed list and
 * has nothing to check about it.
 */
const monitorTypeParamsSchema = websiteParamsSchema.extend({
  type: z.enum(MONITOR_TYPES),
});

const monitorResultParamsSchema = z.object({
  monitorId: objectIdSchema,
});

export const monitorValidators = {
  list: { params: websiteParamsSchema } satisfies ValidationSchemas,
  update: {
    params: monitorTypeParamsSchema,
    body: updateMonitorSchema,
  } satisfies ValidationSchemas,
  runNow: { params: monitorTypeParamsSchema } satisfies ValidationSchemas,
  results: {
    params: monitorResultParamsSchema,
    query: listMonitorResultsQuerySchema,
  } satisfies ValidationSchemas,
} as const;
