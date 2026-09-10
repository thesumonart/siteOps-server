import type { CheckErrorType } from './check.js';
import {
  type IncidentCategory,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentType,
} from './incident.js';
import type { MonitorStatus, MonitorType } from './monitor.js';
import type { NotificationChannel, NotificationEvent } from './notification.js';
import type { PlanFeature } from './plan.js';

/**
 * Notification channels: somewhere other than an inbox that an organization
 * wants to hear about its websites.
 *
 * Email alerting is per person — every verified member, filtered by their own
 * preferences. A channel belongs to the organization: the Slack channel the
 * on-call rotation watches, a Discord server, an endpoint in the agency's own
 * tooling. So a channel carries its own subscription list rather than reading
 * anybody's preferences, and a member turning off outage emails does not
 * silence the team's Slack.
 */
export const CHANNEL_TYPES = [
  'webhook',
  'slack',
  'discord',
] as const satisfies readonly NotificationChannel[];

export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  webhook: 'Webhook',
  slack: 'Slack',
  discord: 'Discord',
};

/**
 * The plan feature that unlocks each channel type.
 *
 * One entry per type rather than one feature for all of them, because the
 * plans were priced that way before any of this was built and the entitlement
 * is the stable part.
 */
export const FEATURE_FOR_CHANNEL_TYPE: Record<ChannelType, PlanFeature> = {
  webhook: 'webhooks',
  slack: 'slack_notifications',
  discord: 'discord_notifications',
};

/**
 * Events a channel can subscribe to.
 *
 * A subset of {@link NotificationEvent}, and the same strings, so a webhook
 * receiver and the in-app feed describe one transition with one name. Every
 * entry is an incident transition, which is what keeps channels to the same
 * rule as email: one message when something changes, never a repeat while it
 * stays that way.
 */
export const CHANNEL_EVENTS = [
  'website.down',
  'website.recovered',
  'website.degraded',
  'website.degradation_resolved',
  'monitor.problem',
  'monitor.recovered',
] as const satisfies readonly NotificationEvent[];

export type ChannelEvent = (typeof CHANNEL_EVENTS)[number];

export const CHANNEL_EVENT_LABELS: Record<ChannelEvent, string> = {
  'website.down': 'A website goes down',
  'website.recovered': 'A website comes back',
  'website.degraded': 'A website is responding unusually slowly',
  'website.degradation_resolved': 'Response times are back to normal',
  'monitor.problem': 'A monitor finds a problem',
  'monitor.recovered': 'A monitor problem is resolved',
};

/**
 * Sent only by the "send a test" action, and deliberately not subscribable: a
 * test is something a person asks for once, not a transition.
 */
export const CHANNEL_TEST_EVENT = 'channel.test';

export type WebhookEventType = ChannelEvent | typeof CHANNEL_TEST_EVENT;

export const CHANNEL_DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;

export type ChannelDeliveryStatus = (typeof CHANNEL_DELIVERY_STATUSES)[number];

/** Upper bound on the static key/value pairs a webhook channel echoes in every payload. */
export const MAX_CHANNEL_METADATA_ENTRIES = 10;

/* ------------------------------------------------------------ webhook contract */

/**
 * The outgoing webhook, as a receiver sees it.
 *
 * These names are a public interface: somebody's deployment verifies the
 * signature header and routes on the event header, and renaming either breaks
 * them silently. They are extended, never renamed.
 *
 * The signature is `t=<unix seconds>,v1=<hex HMAC-SHA256>`, computed over
 * `${t}.${raw body}` with the channel's signing secret — the scheme Stripe uses,
 * for the reason Stripe uses it: without the timestamp inside the signed
 * string, a captured request stays valid forever and can be replayed.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'X-SiteOps-Signature';
export const WEBHOOK_EVENT_HEADER = 'X-SiteOps-Event';
/** Stable across retries of one delivery, so a receiver can drop a duplicate. */
export const WEBHOOK_DELIVERY_HEADER = 'X-SiteOps-Delivery';
/** How old a signed timestamp a receiver should still accept. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

export interface WebhookWebsite {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface WebhookIncident {
  readonly id: string;
  readonly status: IncidentStatus;
  readonly type: IncidentType;
  readonly category: IncidentCategory;
  readonly severity: IncidentSeverity;
  readonly detail: string | null;
  readonly startedAt: string;
  readonly resolvedAt: string | null;
  readonly durationSeconds: number | null;
  readonly failedCheckCount: number;
  readonly lastStatusCode: number | null;
  readonly lastErrorType: CheckErrorType | null;
  readonly lastErrorMessage: string | null;
}

export interface WebhookMonitor {
  readonly type: MonitorType;
  readonly status: MonitorStatus;
  readonly summary: string;
}

/**
 * The numbers behind a `website.degraded` call: the response that tipped it,
 * and the baseline it was judged against. A receiver can re-derive the verdict
 * from these, which is the point — nothing about it is a black box.
 */
export interface WebhookAnomaly {
  readonly responseTimeMs: number;
  readonly baselineMeanMs: number;
  readonly baselineStdDevMs: number;
  readonly sampleCount: number;
  readonly zScore: number;
}

/**
 * The facts of one event, identical for every channel it goes to.
 *
 * `id` is deterministic — the event and the incident it describes — so it is
 * the same on every retry and on every channel, and a receiver subscribed
 * through two channels can tell it heard about one transition twice.
 */
export interface ChannelEventPayload {
  readonly id: string;
  readonly type: WebhookEventType;
  readonly createdAt: string;
  readonly organizationId: string;
  readonly data: {
    /** Null only for a test message, which is about no website. */
    readonly website: WebhookWebsite | null;
    readonly incident: WebhookIncident | null;
    /** Set for `monitor.*` events: which auxiliary monitor raised it. */
    readonly monitor: WebhookMonitor | null;
    /** Set for `website.degraded`: the response time and the baseline it broke. */
    readonly anomaly: WebhookAnomaly | null;
    readonly dashboardUrl: string;
  };
}

/** The JSON body a webhook channel receives: the event, plus its own static metadata. */
export interface WebhookBody extends ChannelEventPayload {
  readonly metadata: Readonly<Record<string, string>>;
}
