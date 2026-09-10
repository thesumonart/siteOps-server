import { z } from 'zod';

import { API_KEY_SCOPES, MAX_API_KEY_EXPIRY_DAYS } from '../domain/api-key.js';
import { humanNameSchema } from './common.js';

/** At least one scope, each once. A key that may do nothing is a key nobody needs. */
export const apiKeyScopesSchema = z
  .array(z.enum(API_KEY_SCOPES))
  .min(1, 'Choose at least one scope.')
  .max(API_KEY_SCOPES.length, 'Each scope can be chosen once.')
  .transform((scopes) => [...new Set(scopes)]);

export const createApiKeySchema = z.object({
  /** What the key is for — "Terraform", "Status board" — shown in the list and the audit log. */
  name: humanNameSchema,
  scopes: apiKeyScopesSchema,
  /** Days until the key stops working. Omitted or null: it works until it is revoked. */
  expiresInDays: z
    .number()
    .int()
    .min(1, 'A key must last at least a day.')
    .max(MAX_API_KEY_EXPIRY_DAYS, `A key can last at most ${String(MAX_API_KEY_EXPIRY_DAYS)} days.`)
    .nullable()
    .optional(),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type CreateApiKeyFormValues = z.input<typeof createApiKeySchema>;
