import { z } from 'zod';

import { createApiKeySchema, objectIdSchema } from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';

const apiKeyParamsSchema = z.object({ apiKeyId: objectIdSchema });

export const apiKeyValidators = {
  create: { body: createApiKeySchema } satisfies ValidationSchemas,
  rotate: { params: apiKeyParamsSchema } satisfies ValidationSchemas,
  revoke: { params: apiKeyParamsSchema } satisfies ValidationSchemas,
} as const;
