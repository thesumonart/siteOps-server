import { z } from 'zod';

import {
  createChannelSchema,
  listChannelDeliveriesQuerySchema,
  objectIdSchema,
  updateChannelSchema,
} from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';

const channelParamsSchema = z.object({ channelId: objectIdSchema });

export const channelValidators = {
  create: { body: createChannelSchema } satisfies ValidationSchemas,
  getById: { params: channelParamsSchema } satisfies ValidationSchemas,
  update: { params: channelParamsSchema, body: updateChannelSchema } satisfies ValidationSchemas,
  remove: { params: channelParamsSchema } satisfies ValidationSchemas,
  test: { params: channelParamsSchema } satisfies ValidationSchemas,
  rotateSecret: { params: channelParamsSchema } satisfies ValidationSchemas,
  deliveries: {
    params: channelParamsSchema,
    query: listChannelDeliveriesQuerySchema,
  } satisfies ValidationSchemas,
} as const;
