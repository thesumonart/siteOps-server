import { z } from 'zod';

import { AUDIT_ACTIONS, AUDIT_AREAS } from '../domain/audit.js';
import { cursorPaginationQuerySchema, isoDateStringSchema, objectIdSchema } from './common.js';

/**
 * Filters for the organization activity feed.
 *
 * Every filter narrows an already tenant-scoped query — none of them can widen
 * it. `area` and `action` overlap on purpose: the dropdown offers areas, and a
 * link from a specific event offers the exact action behind it.
 *
 * The date bounds are validated as a pair so an inverted range fails at the
 * edge with a field error, rather than quietly returning nothing.
 */
export const listAuditLogsQuerySchema = cursorPaginationQuerySchema
  .extend({
    area: z.enum(AUDIT_AREAS).optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    actorUserId: objectIdSchema.optional(),
    targetType: z.string().trim().min(1).max(40).optional(),
    targetId: objectIdSchema.optional(),
    /** Free-text match against the actor and target names recorded on the entry. */
    search: z.string().trim().min(1).max(120).optional(),
    from: isoDateStringSchema.optional(),
    to: isoDateStringSchema.optional(),
  })
  .refine((value) => !(value.from && value.to) || Date.parse(value.from) <= Date.parse(value.to), {
    message: 'The start of the range must not be after its end.',
    path: ['from'],
  });

export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
