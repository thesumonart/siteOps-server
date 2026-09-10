import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { CHANNEL_DELIVERY_STATUSES, CHANNEL_EVENTS } from '../contracts/index.js';
import type {
  ChannelDeliveryStatus,
  ChannelEvent,
  ChannelEventPayload,
} from '../contracts/index.js';

/**
 * One event, owed to one channel.
 *
 * This collection is both the delivery log and the retry queue, the same way
 * `websites` is both the website list and the uptime queue: `nextAttemptAt` is
 * the ready time, `leaseExpiresAt` the visibility timeout, and one atomic
 * `findOneAndUpdate` claims a delivery. That buys asynchronous dispatch and
 * retry with backoff without a broker — see docs/ARCHITECTURE.md for why there
 * is none.
 *
 * `payload` holds the facts at the moment of the transition, not a reference
 * to them. A retry an hour later must describe the outage as it was when it
 * started, not as the incident reads by then.
 */
export interface ChannelDeliveryAttributes {
  organizationId: Types.ObjectId;
  channelId: Types.ObjectId;
  event: ChannelEvent;
  /**
   * `<scope>:<event>:<channelId>`, where the scope is the incident. The unique
   * index on it is what makes "one message per channel per transition" a
   * database guarantee rather than a hope, exactly as `notification_dedupe_unique`
   * is for email.
   */
  dedupeKey: string;
  payload: ChannelEventPayload;
  status: ChannelDeliveryStatus;
  /** Incremented when a delivery is claimed, so a crash mid-send still counts. */
  attemptCount: number;
  /** When the next attempt is due. Null once the delivery has settled. */
  nextAttemptAt: Date | null;
  leaseExpiresAt: Date | null;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  responseStatus: number | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ChannelDeliveryDocument = HydratedDocument<ChannelDeliveryAttributes>;

/**
 * How long the delivery log is kept.
 *
 * Long enough to answer "did the Slack message for last week's outage go out",
 * and far longer than any retry schedule, so the TTL can never remove a
 * delivery that is still due.
 */
export const CHANNEL_DELIVERY_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const channelDeliverySchema = new Schema<ChannelDeliveryAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    channelId: { type: Schema.Types.ObjectId, required: true, ref: 'NotificationChannel' },
    event: { type: String, required: true, enum: CHANNEL_EVENTS },
    dedupeKey: { type: String, required: true, maxlength: 200 },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, required: true, enum: CHANNEL_DELIVERY_STATUSES, default: 'pending' },
    attemptCount: { type: Number, required: true, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: null },
    leaseExpiresAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    responseStatus: { type: Number, default: null },
    failureReason: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true, collection: 'channel_deliveries' },
);

// The deduplication guarantee. See `dedupeKey`.
channelDeliverySchema.index({ dedupeKey: 1 }, { unique: true, name: 'delivery_dedupe_unique' });

/*
 * The delivery loop's claim query. The partial filter keeps settled deliveries —
 * nearly all of them — out of the index, so it stays the size of the backlog
 * rather than of the history.
 */
channelDeliverySchema.index(
  { nextAttemptAt: 1 },
  { name: 'delivery_due', partialFilterExpression: { status: 'pending' } },
);

/*
 * One channel's delivery log, newest first, keyset-paged on `(createdAt, _id)`.
 * `organizationId` leads because every read is tenant-scoped first.
 */
channelDeliverySchema.index(
  { organizationId: 1, channelId: 1, createdAt: -1, _id: -1 },
  { name: 'delivery_org_channel_created_at' },
);

channelDeliverySchema.index(
  { createdAt: 1 },
  { name: 'delivery_ttl', expireAfterSeconds: CHANNEL_DELIVERY_RETENTION_SECONDS },
);

export const ChannelDeliveryModel: Model<ChannelDeliveryAttributes> =
  (mongoose.models.ChannelDelivery as Model<ChannelDeliveryAttributes> | undefined) ??
  model<ChannelDeliveryAttributes>('ChannelDelivery', channelDeliverySchema);
