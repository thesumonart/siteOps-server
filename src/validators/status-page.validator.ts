import { z } from 'zod';

import {
  createStatusPageSchema,
  customDomainSchema,
  objectIdSchema,
  publicStatusPageQuerySchema,
  statusPageSlugSchema,
  updateStatusPageSchema,
} from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';

const statusPageParamsSchema = z.object({ statusPageId: objectIdSchema });

export const statusPageValidators = {
  get: { params: statusPageParamsSchema } satisfies ValidationSchemas,
  create: { body: createStatusPageSchema } satisfies ValidationSchemas,
  update: {
    params: statusPageParamsSchema,
    body: updateStatusPageSchema,
  } satisfies ValidationSchemas,
  delete: { params: statusPageParamsSchema } satisfies ValidationSchemas,
  setCustomDomain: {
    params: statusPageParamsSchema,
    body: customDomainSchema,
  } satisfies ValidationSchemas,
  customDomain: { params: statusPageParamsSchema } satisfies ValidationSchemas,
} as const;

export const publicStatusValidators = {
  bySlug: {
    params: z.object({ slug: statusPageSlugSchema }),
    query: publicStatusPageQuerySchema,
  } satisfies ValidationSchemas,
  forHost: { query: publicStatusPageQuerySchema } satisfies ValidationSchemas,
} as const;
