import { z } from 'zod';

import {
  createClientSchema,
  inviteClientContactSchema,
  listClientsQuerySchema,
  objectIdSchema,
  updateClientSchema,
} from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';

const clientParamsSchema = z.object({ clientId: objectIdSchema });
const contactParamsSchema = z.object({
  clientId: objectIdSchema,
  contactId: objectIdSchema,
});

export const clientValidators = {
  list: { query: listClientsQuerySchema } satisfies ValidationSchemas,
  create: { body: createClientSchema } satisfies ValidationSchemas,
  getById: { params: clientParamsSchema } satisfies ValidationSchemas,
  update: {
    params: clientParamsSchema,
    body: updateClientSchema,
  } satisfies ValidationSchemas,
  remove: { params: clientParamsSchema } satisfies ValidationSchemas,
  listContacts: { params: clientParamsSchema } satisfies ValidationSchemas,
  inviteContact: {
    params: clientParamsSchema,
    body: inviteClientContactSchema,
  } satisfies ValidationSchemas,
  revokeContact: { params: contactParamsSchema } satisfies ValidationSchemas,
} as const;
