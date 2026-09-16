import { z } from 'zod';

import {
  DEFAULT_STATUS_PAGE_HISTORY_DAYS,
  MAX_STATUS_PAGE_COMPONENTS,
  STATUS_PAGE_HISTORY_DAYS,
  STATUS_PAGE_THEMES,
  type StatusPageHistoryDays,
} from '../domain/status-page.js';
import { isBlockedHostname } from '../url/normalize.js';
import { humanNameSchema, objectIdSchema } from './common.js';

/**
 * The page's public address: `/api/public/status-pages/<slug>`. Globally
 * unique, since it is a public URL rather than something scoped to an
 * organization.
 */
export const statusPageSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Use at least 3 characters.')
  .max(48, 'Use 48 characters or fewer.')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase letters, numbers and single hyphens between them.',
  );

/**
 * One monitored website on the page, under the name visitors see.
 *
 * The display name is required rather than defaulting to the website's name:
 * an agency's internal name for a site ("Acme – prod – old host") is often
 * not what it wants a client's customers to read.
 */
export const statusPageComponentSchema = z.object({
  websiteId: objectIdSchema,
  displayName: humanNameSchema,
});

const componentsSchema = z
  .array(statusPageComponentSchema)
  .max(
    MAX_STATUS_PAGE_COMPONENTS,
    `A page can show at most ${String(MAX_STATUS_PAGE_COMPONENTS)} components.`,
  )
  .refine(
    (components) =>
      new Set(components.map((component) => component.websiteId)).size === components.length,
    { message: 'Each website can appear on a page once.' },
  );

export const statusPageThemeSchema = z.object({
  mode: z.enum(STATUS_PAGE_THEMES).default('auto'),
  /** Six hex digits only: this value reaches a style attribute on a public page. */
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour, for example #2563EB.')
    .nullable()
    .default(null),
});

const descriptionSchema = z.string().trim().max(500, 'Use 500 characters or fewer.').nullable();

export const createStatusPageSchema = z.object({
  title: humanNameSchema,
  slug: statusPageSlugSchema,
  description: descriptionSchema.optional(),
  components: componentsSchema.default([]),
  theme: statusPageThemeSchema.default({ mode: 'auto', accentColor: null }),
  /** Unpublished by default: a page goes public when somebody decides it is ready. */
  published: z.boolean().default(false),
});

export type CreateStatusPageInput = z.infer<typeof createStatusPageSchema>;
export type CreateStatusPageFormValues = z.input<typeof createStatusPageSchema>;

export const updateStatusPageSchema = z.object({
  title: humanNameSchema.optional(),
  slug: statusPageSlugSchema.optional(),
  description: descriptionSchema.optional(),
  components: componentsSchema.optional(),
  theme: statusPageThemeSchema.optional(),
  published: z.boolean().optional(),
});

export type UpdateStatusPageInput = z.infer<typeof updateStatusPageSchema>;

const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * A hostname the page may be served on — `status.acme.com`, never a URL.
 *
 * A letter-only final label rules out an IP address, and the blocked-name list
 * the website URL screen uses rules out `localhost`, `.internal` and the rest.
 * Ownership is proved separately, by DNS; this only decides whether the name
 * is one worth trying to prove.
 */
export const customDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => value.replace(/\.$/, ''))
    .pipe(
      z
        .string()
        .regex(
          HOSTNAME,
          'Enter a domain name such as status.example.com, without https:// or a path.',
        )
        .refine((value) => !isBlockedHostname(value), {
          message: 'That domain refers to an internal address.',
        }),
    ),
});

export type CustomDomainInput = z.infer<typeof customDomainSchema>;

export const publicStatusPageQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine(
      (value): value is StatusPageHistoryDays =>
        (STATUS_PAGE_HISTORY_DAYS as readonly number[]).includes(value),
      { message: 'Choose 30, 60 or 90 days of history.' },
    )
    .default(DEFAULT_STATUS_PAGE_HISTORY_DAYS),
});

export type PublicStatusPageQuery = z.infer<typeof publicStatusPageQuerySchema>;
