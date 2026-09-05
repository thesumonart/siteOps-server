import { z } from 'zod';

import { CHECK_STATUSES } from '../domain/check.js';
import {
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_RECOVERY_THRESHOLD,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
} from '../domain/incident.js';
import {
  DEFAULT_MONITORING_INTERVAL_SECONDS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
  MONITORING_INTERVALS_SECONDS,
} from '../domain/website.js';
import { normalizeWebsiteUrl } from '../url/normalize.js';
import { cursorPaginationQuerySchema, humanNameSchema } from './common.js';

/**
 * Validates and normalizes a monitored URL in one step, so every layer that
 * parses this schema receives the canonical form rather than raw user input.
 */
export const websiteUrlSchema = z
  .string()
  .trim()
  .min(1, 'Enter a website URL.')
  .superRefine((value, ctx) => {
    const result = normalizeWebsiteUrl(value);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.detail });
    }
  })
  .transform((value) => {
    const result = normalizeWebsiteUrl(value);
    // Unreachable: superRefine above aborts the pipeline on failure.
    return result.ok ? result.value.href : value;
  });

export const monitoringIntervalSchema = z.coerce
  .number()
  .int()
  .refine(
    (value): value is (typeof MONITORING_INTERVALS_SECONDS)[number] =>
      MONITORING_INTERVALS_SECONDS.includes(value as (typeof MONITORING_INTERVALS_SECONDS)[number]),
    { message: 'Choose one of the supported monitoring intervals.' },
  );

export const requestTimeoutSchema = z.coerce
  .number()
  .int()
  .min(MIN_REQUEST_TIMEOUT_MS, `Timeout must be at least ${MIN_REQUEST_TIMEOUT_MS} ms.`)
  .max(MAX_REQUEST_TIMEOUT_MS, `Timeout must be ${MAX_REQUEST_TIMEOUT_MS} ms or less.`);

const thresholdSchema = z.coerce.number().int().min(MIN_THRESHOLD).max(MAX_THRESHOLD);

export const createWebsiteSchema = z.object({
  name: humanNameSchema,
  url: websiteUrlSchema,
  monitoringIntervalSeconds: monitoringIntervalSchema.default(DEFAULT_MONITORING_INTERVAL_SECONDS),
  requestTimeoutMs: requestTimeoutSchema.default(DEFAULT_REQUEST_TIMEOUT_MS),
  failureThreshold: thresholdSchema.default(DEFAULT_FAILURE_THRESHOLD),
  recoveryThreshold: thresholdSchema.default(DEFAULT_RECOVERY_THRESHOLD),
});

export type CreateWebsiteInput = z.infer<typeof createWebsiteSchema>;

export const updateWebsiteSchema = createWebsiteSchema.partial().extend({
  monitoringEnabled: z.boolean().optional(),
});

export type UpdateWebsiteInput = z.infer<typeof updateWebsiteSchema>;

export const listWebsitesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['operational', 'degraded', 'down', 'paused', 'unknown']).optional(),
});

export type ListWebsitesQuery = z.infer<typeof listWebsitesQuerySchema>;

export const listChecksQuerySchema = cursorPaginationQuerySchema.extend({
  status: z.enum(CHECK_STATUSES).optional(),
  /** Restricts results to checks recorded within the last N hours. */
  windowHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .optional(),
});

export type ListChecksQuery = z.infer<typeof listChecksQuerySchema>;

export const uptimeRangeSchema = z.enum(['24h', '7d', '30d']);

export type UptimeRange = z.infer<typeof uptimeRangeSchema>;

export const UPTIME_RANGE_HOURS: Record<UptimeRange, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

export const uptimeQuerySchema = z.object({
  range: uptimeRangeSchema.default('24h'),
});

export type UptimeQuery = z.infer<typeof uptimeQuerySchema>;
