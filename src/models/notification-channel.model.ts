import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { CHANNEL_EVENTS, CHANNEL_TYPES } from '../contracts/index.js';
import type { ChannelEvent, ChannelType } from '../contracts/index.js';

/**
 * A Slack, Discord or webhook destination for one organization's alerts.
 *
 * The destination URL and the signing secret are stored sealed (see
 * `utils/secret-box.ts`), bound to the organization. A Slack or Discord webhook
 * URL is a bearer credential — whoever holds it can post into that channel — so
 * nothing that reads this document for display ever needs to open it:
 * `targetPreview` is written alongside, once, for that.
 */
export interface NotificationChannelAttributes {
  organizationId: Types.ObjectId;
  name: string;
  type: ChannelType;
  enabled: boolean;
  events: ChannelEvent[];
  urlCiphertext: string;
  /** The URL with its secret part elided, computed when the URL is written. */
  targetPreview: string;
  /** Null for Slack and Discord, which verify nothing a sender could sign. */
  secretCiphertext: string | null;
  /** Echoed in every webhook payload. Always empty for Slack and Discord. */
  metadata: Record<string, string>;
  createdByUserId: Types.ObjectId;
  /*
   * Delivery health, written by the worker when a delivery settles. Read by
   * the settings screen so a channel that has been failing for a week says so
   * next to its name, rather than being discovered during an outage.
   */
  lastDeliveryAt: Date | null;
  lastDeliveryStatus: 'delivered' | 'failed' | null;
  lastFailureReason: string | null;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationChannelDocument = HydratedDocument<NotificationChannelAttributes>;

const notificationChannelSchema = new Schema<NotificationChannelAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, required: true, enum: CHANNEL_TYPES },
    enabled: { type: Boolean, required: true, default: true },
    events: {
      type: [{ type: String, enum: CHANNEL_EVENTS }],
      required: true,
      validate: {
        validator: (events: readonly string[]) => events.length > 0,
        message: 'A channel must subscribe to at least one event.',
      },
    },
    urlCiphertext: { type: String, required: true, maxlength: 4096 },
    targetPreview: { type: String, required: true, maxlength: 200 },
    secretCiphertext: { type: String, default: null, maxlength: 512 },
    metadata: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
    createdByUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    lastDeliveryAt: { type: Date, default: null },
    lastDeliveryStatus: { type: String, enum: ['delivered', 'failed', null], default: null },
    lastFailureReason: { type: String, default: null, maxlength: 500 },
    consecutiveFailures: { type: Number, required: true, default: 0, min: 0 },
  },
  // `minimize: false` keeps an empty `metadata` as `{}` on disk rather than
  // dropping the key, so a read never has to tell "none" from "absent".
  { timestamps: true, collection: 'notification_channels', minimize: false },
);

/*
 * Two channels in one organization may not share a name: the settings list and
 * the audit log both identify a channel by it, and "Slack" twice is ambiguous in
 * both. Scoped to the organization, so every agency may call theirs "Slack".
 */
notificationChannelSchema.index(
  { organizationId: 1, name: 1 },
  { unique: true, name: 'channel_org_name_unique' },
);

// The settings list, newest first.
notificationChannelSchema.index(
  { organizationId: 1, createdAt: -1 },
  { name: 'channel_org_created_at' },
);

/*
 * The dispatcher's only query: the enabled channels of one organization that
 * subscribe to one event. `events` is an array, so this is a multikey index,
 * and the partial filter keeps disabled channels out of it entirely.
 */
notificationChannelSchema.index(
  { organizationId: 1, events: 1 },
  { name: 'channel_dispatch', partialFilterExpression: { enabled: true } },
);

export const NotificationChannelModel: Model<NotificationChannelAttributes> =
  (mongoose.models.NotificationChannel as Model<NotificationChannelAttributes> | undefined) ??
  model<NotificationChannelAttributes>('NotificationChannel', notificationChannelSchema);
