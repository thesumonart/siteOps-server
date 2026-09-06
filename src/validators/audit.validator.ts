import { listAuditLogsQuerySchema } from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';

export const auditValidators = {
  list: { query: listAuditLogsQuerySchema } satisfies ValidationSchemas,
} as const;
