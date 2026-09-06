import { z } from 'zod';

import { CLIENT_STATUSES } from '../domain/client.js';
import { emailSchema } from './auth.js';
import { humanNameSchema } from './common.js';

/** Managing agency clients and their portal access. */

const optionalName = z
  .string()
  .trim()
  .max(120, 'Use 120 characters or fewer.')
  .nullable()
  .optional();

export const createClientSchema = z.object({
  name: humanNameSchema,
  companyName: optionalName,
  contactName: optionalName,
  contactEmail: emailSchema.nullable().optional(),
  /** Internal notes. Never rendered in the client portal. */
  notes: z.string().trim().max(2000, 'Use 2000 characters or fewer.').nullable().optional(),
});

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type CreateClientFormValues = z.input<typeof createClientSchema>;

export const updateClientSchema = createClientSchema.partial().extend({
  status: z.enum(CLIENT_STATUSES).optional(),
});

export type UpdateClientInput = z.infer<typeof updateClientSchema>;

export const listClientsQuerySchema = z.object({
  status: z.enum(CLIENT_STATUSES).optional(),
  search: z.string().trim().max(120).optional(),
});

export type ListClientsQuery = z.infer<typeof listClientsQuerySchema>;

/**
 * Granting portal access to a person.
 *
 * Only an address. The invitation flow the product already has creates the
 * account, verifies the address and sets a password — this adds nothing to
 * that, because a second way to create a user is a second way to get identity
 * wrong.
 */
export const inviteClientContactSchema = z.object({
  email: emailSchema,
});

export type InviteClientContactInput = z.infer<typeof inviteClientContactSchema>;
