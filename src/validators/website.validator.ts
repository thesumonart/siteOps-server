import {
  createWebsiteSchema,
  listWebsitesQuerySchema,
  updateWebsiteSchema,
} from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';
import { websiteParamsSchema } from './common.validator.js';

export const websiteValidators = {
  list: { query: listWebsitesQuerySchema } satisfies ValidationSchemas,
  create: { body: createWebsiteSchema } satisfies ValidationSchemas,
  getById: { params: websiteParamsSchema } satisfies ValidationSchemas,
  update: {
    params: websiteParamsSchema,
    body: updateWebsiteSchema,
  } satisfies ValidationSchemas,
  remove: { params: websiteParamsSchema } satisfies ValidationSchemas,
  toggleMonitoring: { params: websiteParamsSchema } satisfies ValidationSchemas,
} as const;
