import type { Types } from 'mongoose';

import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type ChannelEventPayload,
  type ChannelType,
} from '../contracts/index.js';
import { openSecret } from '../utils/secret-box.js';
import { renderChannelBody } from './channel-formatters.js';
import { postToChannel, type ChannelResponse } from './channel-sender.js';
import { signWebhookBody } from './webhook-signature.js';

/**
 * Sending one event to one channel: render, sign, post.
 *
 * Shared by the delivery job and by "send a test" in the API, so a test message
 * travels exactly the path a real alert does — same formatter, same signature,
 * same SSRF boundary. A test that took a shortcut would pass for a channel that
 * then fails during the outage it was set up for.
 */

/** Identifies SiteOps in a receiver's access log, as the monitor's own agent does. */
export const CHANNEL_USER_AGENT = 'SiteOpsWebhooks/1.0 (+https://siteops.app)';

/** A channel with its credentials opened, ready to send to. Never stored or logged. */
export interface DeliverableChannel {
  readonly type: ChannelType;
  readonly url: string;
  readonly signingSecret: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SealedChannel {
  readonly organizationId: Types.ObjectId;
  readonly type: ChannelType;
  readonly urlCiphertext: string;
  readonly secretCiphertext: string | null;
  readonly metadata?: Readonly<Record<string, string>> | null;
}

/**
 * Opens a stored channel's credentials, or returns null if they cannot be.
 *
 * Null covers every reason the same way — tampering, a rotated `AUTH_SECRET`,
 * a value sealed for another organization — because the only useful response
 * to each is to ask for the URL again.
 */
export function openChannel(channel: SealedChannel): DeliverableChannel | null {
  const context = channel.organizationId.toHexString();

  const url = openSecret(channel.urlCiphertext, context);
  if (url === null) return null;

  let signingSecret: string | null = null;
  if (channel.secretCiphertext !== null) {
    signingSecret = openSecret(channel.secretCiphertext, context);
    if (signingSecret === null) return null;
  }

  return { type: channel.type, url, signingSecret, metadata: channel.metadata ?? {} };
}

export async function deliverToChannel(
  channel: DeliverableChannel,
  payload: ChannelEventPayload,
  options: {
    readonly deliveryId: string;
    readonly timeoutMs: number;
    readonly allowLoopback: boolean;
    readonly now?: Date;
  },
): Promise<ChannelResponse> {
  const body = JSON.stringify(renderChannelBody(channel.type, payload, channel.metadata));
  const headers: Record<string, string> = { 'user-agent': CHANNEL_USER_AGENT };

  if (channel.type === 'webhook') {
    headers[WEBHOOK_EVENT_HEADER] = payload.type;
    headers[WEBHOOK_DELIVERY_HEADER] = options.deliveryId;
    if (channel.signingSecret !== null) {
      // Signed at send time, not at enqueue: the timestamp inside the signature
      // is what a receiver checks for freshness, and a retry an hour later with
      // an hour-old timestamp would be refused as a replay.
      const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1000);
      headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(channel.signingSecret, body, timestamp);
    }
  }

  return postToChannel({
    url: channel.url,
    body,
    headers,
    timeoutMs: options.timeoutMs,
    allowLoopback: options.allowLoopback,
  });
}

/**
 * What the dashboard shows instead of a channel's URL.
 *
 * The origin, so it is recognisably Slack or the agency's own endpoint, and the
 * last four characters, so two channels to the same host can be told apart. The
 * token in the middle — the part that makes a Slack URL a credential — never
 * appears. A short path shows no tail at all, since four of eight characters is
 * most of a secret.
 */
export function previewChannelTarget(url: string): string {
  const parsed = new URL(url);
  const rest = `${parsed.pathname}${parsed.search}`;
  const tail = rest.length > 12 ? rest.slice(-4) : '';
  return `${parsed.origin}/…${tail}`;
}
