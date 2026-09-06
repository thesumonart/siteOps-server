import { startCheckoutSchema } from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';
import { organizationParamsSchema } from './common.validator.js';

export const billingValidators = {
  subscription: { params: organizationParamsSchema } satisfies ValidationSchemas,
  checkout: {
    params: organizationParamsSchema,
    body: startCheckoutSchema,
  } satisfies ValidationSchemas,
  portal: { params: organizationParamsSchema } satisfies ValidationSchemas,
} as const;
