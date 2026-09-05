import { listIncidentsQuerySchema } from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';
import { incidentParamsSchema } from './common.validator.js';

export const incidentValidators = {
  list: { query: listIncidentsQuerySchema } satisfies ValidationSchemas,
  getById: { params: incidentParamsSchema } satisfies ValidationSchemas,
  resolve: { params: incidentParamsSchema } satisfies ValidationSchemas,
} as const;
