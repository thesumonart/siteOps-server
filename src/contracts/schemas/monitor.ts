import { z } from 'zod';

import {
  CHANGE_SENSITIVITIES,
  MAX_MONITOR_INTERVAL_SECONDS,
  MIN_MONITOR_INTERVAL_SECONDS,
  MONITOR_STATUSES,
  MONITOR_TYPES,
} from '../domain/monitor.js';
import { cursorPaginationQuerySchema } from './common.js';

/**
 * Request shapes for configuring and reading the auxiliary monitors.
 *
 * The per-type configuration is a discriminated union so a caller cannot send
 * SSL thresholds to a crawler, and every numeric bound is stated here rather
 * than only in the UI — these are the values that decide how hard SiteOps hits
 * someone else's website.
 */

const expiryThresholdSchema = z.coerce.number().int().min(1).max(365);

const expiryConfigShape = {
  warningDays: expiryThresholdSchema,
  criticalDays: expiryThresholdSchema,
};

/**
 * Warning must not be tighter than critical, or the monitor would escalate to
 * critical before it ever warned — an alert that arrives only at its loudest.
 *
 * Applied as a `superRefine` on the union rather than as a `refine` on each
 * member, because `z.discriminatedUnion` has to read a plain object shape to
 * find the discriminator and a wrapped schema hides it.
 */
function checkExpiryOrder(
  value: { readonly warningDays: number; readonly criticalDays: number },
  ctx: z.RefinementCtx,
): void {
  if (value.warningDays < value.criticalDays) {
    ctx.addIssue({
      code: 'custom',
      path: ['warningDays'],
      message: 'The warning threshold must be at least as far out as the critical one.',
    });
  }
}

export const sslMonitorConfigSchema = z.object(expiryConfigShape).superRefine(checkExpiryOrder);
export const domainMonitorConfigSchema = z.object(expiryConfigShape).superRefine(checkExpiryOrder);

export const performanceMonitorConfigSchema = z.object({
  minPerformanceScore: z.coerce.number().int().min(0).max(100),
  maxLargestContentfulPaintMs: z.coerce.number().int().min(500).max(60_000),
  strategy: z.enum(['mobile', 'desktop']),
});

export const contentMonitorConfigSchema = z.object({
  sensitivity: z.enum(CHANGE_SENSITIVITIES),
  /**
   * Bounded in both length and count: these are applied to every fetched
   * document, and an unbounded list of selectors is an unbounded amount of work
   * per run on a page the customer controls.
   */
  // `.readonly()` so the inferred type matches `ContentMonitorConfig` in the
  // domain module; without it the schema infers a mutable array and the two
  // descriptions of the same value stop being assignable to each other.
  ignoreSelectors: z.array(z.string().trim().min(1).max(120)).max(30).default([]).readonly(),
  watchSelector: z.string().trim().min(1).max(120).nullable().default(null),
});

export const seoMonitorConfigSchema = z.object({
  minScore: z.coerce.number().int().min(0).max(100),
});

/**
 * Crawl limits.
 *
 * `maxPages` is capped here at the largest any plan allows; the plan's own
 * ceiling is applied on top, server-side, because this schema is shared with
 * the browser and a plan is not something the browser may decide.
 */
export const linksMonitorConfigSchema = z.object({
  maxPages: z.coerce.number().int().min(1).max(500),
  maxDepth: z.coerce.number().int().min(1).max(5),
  checkExternal: z.boolean(),
  respectRobotsTxt: z.boolean(),
});

export const monitorConfigSchema = z
  .discriminatedUnion('type', [
    z.object({ ...expiryConfigShape, type: z.literal('ssl') }),
    z.object({ ...expiryConfigShape, type: z.literal('domain') }),
    performanceMonitorConfigSchema.extend({ type: z.literal('performance') }),
    contentMonitorConfigSchema.extend({ type: z.literal('content') }),
    seoMonitorConfigSchema.extend({ type: z.literal('seo') }),
    linksMonitorConfigSchema.extend({ type: z.literal('links') }),
  ])
  .superRefine((value, ctx) => {
    if (value.type === 'ssl' || value.type === 'domain') checkExpiryOrder(value, ctx);
  });

export type MonitorConfigInput = z.infer<typeof monitorConfigSchema>;

export const monitorIntervalSchema = z.coerce
  .number()
  .int()
  .min(MIN_MONITOR_INTERVAL_SECONDS, 'Checks may run at most once an hour.')
  .max(MAX_MONITOR_INTERVAL_SECONDS, 'Choose an interval of 30 days or less.');

/**
 * Everything about one monitor that a person may change.
 *
 * A partial patch: omitting `config` leaves the existing configuration alone
 * rather than resetting it to defaults, which is what a settings form that only
 * renders the enabled toggle would otherwise do.
 */
export const updateMonitorSchema = z.object({
  enabled: z.boolean().optional(),
  intervalSeconds: monitorIntervalSchema.optional(),
  config: monitorConfigSchema.optional(),
});

export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;

export const monitorTypeParamSchema = z.object({
  type: z.enum(MONITOR_TYPES),
});

export const listMonitorResultsQuerySchema = cursorPaginationQuerySchema.extend({
  status: z.enum(MONITOR_STATUSES).optional(),
});

export type ListMonitorResultsQuery = z.infer<typeof listMonitorResultsQuerySchema>;
