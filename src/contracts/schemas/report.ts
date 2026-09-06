import { z } from 'zod';

import {
  MAX_REPORT_RANGE_DAYS,
  MAX_SCHEDULE_RECIPIENTS,
  REPORT_FORMATS,
  REPORT_PERIODS,
  REPORT_STATUSES,
  REPORT_TYPES,
  SCHEDULE_FREQUENCIES,
} from '../domain/report.js';
import { emailSchema } from './auth.js';
import {
  cursorPaginationQuerySchema,
  humanNameSchema,
  isoDateStringSchema,
  objectIdSchema,
} from './common.js';

/**
 * Requesting and scheduling reports.
 *
 * The period is the field worth being strict about. An unbounded range would
 * let one request aggregate an organization's entire check history — the
 * largest collection in the product — so `custom` requires both ends and is
 * capped at a year.
 */

const websiteSelectionSchema = z
  .array(objectIdSchema)
  .max(200, 'Choose 200 websites or fewer.')
  .optional();

/**
 * A period, validated as a whole.
 *
 * `custom` needs `from` and `to`; every other period must not carry them, so a
 * request cannot quietly mean two different things depending on which fields
 * the server happens to read.
 */
const periodShape = {
  period: z.enum(REPORT_PERIODS),
  from: isoDateStringSchema.optional(),
  to: isoDateStringSchema.optional(),
};

function checkPeriod(
  value: { period: string; from?: string | undefined; to?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.period !== 'custom') {
    if (value.from !== undefined || value.to !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['period'],
        message: 'A named period does not take a date range.',
      });
    }
    return;
  }

  if (value.from === undefined || value.to === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message: 'A custom period needs both a start and an end.',
    });
    return;
  }

  const from = Date.parse(value.from);
  const to = Date.parse(value.to);

  if (from > to) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message: 'The start of the range must not be after its end.',
    });
    return;
  }

  if (to - from > MAX_REPORT_RANGE_DAYS * 86_400_000) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: `A report may cover at most ${String(MAX_REPORT_RANGE_DAYS)} days.`,
    });
  }
}

export const createReportSchema = z
  .object({
    type: z.enum(REPORT_TYPES),
    title: humanNameSchema.optional(),
    /** Required for a `website` report; the selection for an `organization` one. */
    websiteIds: websiteSelectionSchema,
    ...periodShape,
  })
  .superRefine((value, ctx) => {
    checkPeriod(value, ctx);

    if (value.type === 'website' && (value.websiteIds ?? []).length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['websiteIds'],
        message: 'A single-website report needs exactly one website.',
      });
    }
  });

export type CreateReportInput = z.infer<typeof createReportSchema>;

export const listReportsQuerySchema = cursorPaginationQuerySchema.extend({
  status: z.enum(REPORT_STATUSES).optional(),
  type: z.enum(REPORT_TYPES).optional(),
});

export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;

export const downloadReportQuerySchema = z.object({
  format: z.enum(REPORT_FORMATS).default('pdf'),
});

export type DownloadReportQuery = z.infer<typeof downloadReportQuerySchema>;

/**
 * A recurring report.
 *
 * The hour is UTC and the schema says so, because a scheduler that silently
 * interprets "9" in the server's local zone produces a report that arrives at a
 * different time depending on where it is deployed.
 */
export const reportScheduleSchema = z
  .object({
    name: humanNameSchema,
    frequency: z.enum(SCHEDULE_FREQUENCIES),
    /** 0 = Sunday. Ignored for a monthly schedule, which always runs on the 1st. */
    dayOfWeek: z.coerce.number().int().min(0).max(6).default(1),
    hourUtc: z.coerce.number().int().min(0).max(23).default(8),
    type: z.enum(REPORT_TYPES),
    websiteIds: websiteSelectionSchema,
    format: z.enum(REPORT_FORMATS).default('pdf'),
    recipients: z
      .array(emailSchema)
      .min(1, 'Add at least one recipient.')
      .max(
        MAX_SCHEDULE_RECIPIENTS,
        `A schedule may have at most ${String(MAX_SCHEDULE_RECIPIENTS)} recipients.`,
      ),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'website' && (value.websiteIds ?? []).length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['websiteIds'],
        message: 'A single-website report needs exactly one website.',
      });
    }
  });

export type ReportScheduleInput = z.infer<typeof reportScheduleSchema>;
export type ReportScheduleFormValues = z.input<typeof reportScheduleSchema>;

/**
 * Partial update.
 *
 * `partial()` on the wrapped schema would drop the refinement, so the base
 * object is rebuilt loosely and the same rule is reapplied — omitting a field
 * must mean "leave it alone", not "skip the check".
 */
export const updateReportScheduleSchema = z
  .object({
    name: humanNameSchema.optional(),
    frequency: z.enum(SCHEDULE_FREQUENCIES).optional(),
    dayOfWeek: z.coerce.number().int().min(0).max(6).optional(),
    hourUtc: z.coerce.number().int().min(0).max(23).optional(),
    websiteIds: websiteSelectionSchema,
    format: z.enum(REPORT_FORMATS).optional(),
    recipients: z.array(emailSchema).min(1).max(MAX_SCHEDULE_RECIPIENTS).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Nothing to change.',
  });

export type UpdateReportScheduleInput = z.infer<typeof updateReportScheduleSchema>;
