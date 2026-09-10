import { z } from 'zod';

import {
  CHANNEL_DELIVERY_STATUSES,
  CHANNEL_EVENTS,
  MAX_CHANNEL_METADATA_ENTRIES,
  type ChannelType,
} from '../domain/channel.js';
import { MAX_URL_LENGTH, normalizeWebsiteUrl } from '../url/normalize.js';
import { cursorPaginationQuerySchema, humanNameSchema } from './common.js';

/**
 * Where a Slack or Discord channel may point.
 *
 * An allowlist, not a "is this public" check. Choosing Slack is a promise that
 * the message goes to Slack — the body is shaped for Slack's API and nothing
 * else — so anything that is not Slack's own webhook host is refused rather
 * than sent a Block Kit payload it cannot read. Every other destination is a
 * generic webhook, validated and signed as one.
 */
const SLACK_HOSTS: readonly string[] = ['hooks.slack.com'];
const SLACK_PATH = /^\/services\/[A-Za-z0-9_/-]+$/;

const DISCORD_HOSTS: readonly string[] = [
  'discord.com',
  'discordapp.com',
  'ptb.discord.com',
  'canary.discord.com',
];
const DISCORD_PATH = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/;

export type ChannelUrlValidation =
  { readonly ok: true; readonly href: string } | { readonly ok: false; readonly message: string };

/**
 * Validates a destination URL for one channel type and returns its canonical form.
 *
 * Exported as a function as well as through {@link channelUrlSchema} because an
 * edit changes the URL of a channel whose type is already stored: the API
 * validates the new URL against that stored type, and the dashboard's edit
 * form knows the type it is editing. Both call this, so there is one rule.
 *
 * A generic webhook goes through `normalizeWebsiteUrl`, the same string-level
 * SSRF screen a monitored website passes — the worker will POST to it, which is
 * the same threat as fetching it. The connect-time address guard still runs on
 * every delivery; this is the first layer, not the only one.
 */
export function validateChannelUrl(type: ChannelType, input: string): ChannelUrlValidation {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, message: 'Enter the URL.' };
  if (trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, message: `URLs must be ${String(MAX_URL_LENGTH)} characters or fewer.` };
  }

  if (type === 'webhook') {
    const normalized = normalizeWebsiteUrl(trimmed);
    if (!normalized.ok) return { ok: false, message: normalized.detail };
    // Alerts describe an agency's clients' websites and their failures. That
    // does not cross the internet in plaintext, signed or not.
    if (normalized.value.protocol !== 'https:') {
      return { ok: false, message: 'Webhook URLs must use https.' };
    }
    return { ok: true, href: normalized.value.href };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: 'Enter a valid URL.' };
  }

  const host = parsed.hostname.toLowerCase();
  const wellFormed =
    parsed.protocol === 'https:' &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.port.length === 0;

  if (type === 'slack') {
    if (!wellFormed || !SLACK_HOSTS.includes(host) || !SLACK_PATH.test(parsed.pathname)) {
      return {
        ok: false,
        message:
          'Paste the incoming webhook URL Slack gave you. It starts with https://hooks.slack.com/services/.',
      };
    }
  } else if (!wellFormed || !DISCORD_HOSTS.includes(host) || !DISCORD_PATH.test(parsed.pathname)) {
    return {
      ok: false,
      message:
        'Paste the webhook URL from the Discord channel settings. It starts with https://discord.com/api/webhooks/.',
    };
  }

  parsed.hash = '';
  return { ok: true, href: parsed.toString() };
}

/** Validates and canonicalizes a destination URL for one channel type. */
export function channelUrlSchema(type: ChannelType) {
  return z
    .string()
    .trim()
    .min(1, 'Enter the URL.')
    .superRefine((value, ctx) => {
      const result = validateChannelUrl(type, value);
      if (!result.ok) ctx.addIssue({ code: 'custom', message: result.message });
    })
    .transform((value) => {
      const result = validateChannelUrl(type, value);
      // Unreachable: superRefine above aborts the pipeline on failure.
      return result.ok ? result.href : value;
    });
}

/**
 * The events a channel hears about.
 *
 * Duplicates are collapsed rather than refused; a list naming one event twice
 * means exactly what it means once.
 */
export const channelEventsSchema = z
  .array(z.enum(CHANNEL_EVENTS))
  .min(1, 'Choose at least one event.')
  .max(CHANNEL_EVENTS.length, 'Each event can be chosen once.')
  .transform((events) => [...new Set(events)]);

const METADATA_KEY = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * Static context a webhook receiver wants on every request — an environment
 * name, a routing key, a team — so it does not have to keep its own map from
 * channel to meaning. Bounded, because it is copied into every delivery.
 */
export const channelMetadataSchema = z
  .record(
    z
      .string()
      .regex(
        METADATA_KEY,
        'Use letters, digits, dots, dashes and underscores, up to 40 characters.',
      ),
    z.string().trim().max(200, 'Use 200 characters or fewer.'),
  )
  .refine((value) => Object.keys(value).length <= MAX_CHANNEL_METADATA_ENTRIES, {
    message: `Use at most ${String(MAX_CHANNEL_METADATA_ENTRIES)} entries.`,
  });

/**
 * Defaults to every event. A channel somebody connected and forgot to tick a
 * box on should hear about outages; silence is an explicit choice here as it
 * is for email.
 */
const channelFields = {
  name: humanNameSchema,
  events: channelEventsSchema.default([...CHANNEL_EVENTS]),
  enabled: z.boolean().default(true),
};

/**
 * Creating a channel. The type decides how the URL is validated, and only a
 * webhook carries metadata — Slack and Discord render a message for people and
 * have nowhere to put it.
 */
export const createChannelSchema = z.discriminatedUnion('type', [
  z.object({
    ...channelFields,
    type: z.literal('webhook'),
    url: channelUrlSchema('webhook'),
    metadata: channelMetadataSchema.default({}),
  }),
  z.object({ ...channelFields, type: z.literal('slack'), url: channelUrlSchema('slack') }),
  z.object({ ...channelFields, type: z.literal('discord'), url: channelUrlSchema('discord') }),
]);

export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type CreateChannelFormValues = z.input<typeof createChannelSchema>;

/**
 * Editing a channel. The type is fixed once created — a Slack channel turned
 * into a webhook would need a signing secret nobody has seen — so `url` is
 * checked against the stored type with {@link validateChannelUrl}, which is the
 * same rule the dashboard's edit form applies for the type it is showing.
 */
export const updateChannelSchema = z.object({
  name: humanNameSchema.optional(),
  url: z.string().trim().min(1, 'Enter the URL.').max(MAX_URL_LENGTH).optional(),
  events: channelEventsSchema.optional(),
  enabled: z.boolean().optional(),
  metadata: channelMetadataSchema.optional(),
});

export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

export const listChannelDeliveriesQuerySchema = cursorPaginationQuerySchema.extend({
  status: z.enum(CHANNEL_DELIVERY_STATUSES).optional(),
});

export type ListChannelDeliveriesQuery = z.infer<typeof listChannelDeliveriesQuerySchema>;
