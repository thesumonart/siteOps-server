import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_STATUSES,
} from '../contracts/index.js';
import type {
  NotificationChannel,
  NotificationEvent,
  NotificationStatus,
} from '../contracts/index.js';
import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

export interface NotificationAttributes {
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  event: NotificationEvent;
  channel: NotificationChannel;
  status: NotificationStatus;
  websiteId: Types.ObjectId | null;
  incidentId: Types.ObjectId | null;
  title: string;
  body: string;
  /**
   * Deterministic identity for "this notification, for this recipient, about
   * this incident". A unique index on it makes duplicate delivery impossible
   * even if the notification job runs twice.
   */
  dedupeKey: string;
  sentAt: Date | null;
  /**
   * Delivery attempts made so far. Bounded by `NOTIFICATION_MAX_ATTEMPTS`; a
   * notification that exhausts them is recorded as `failed` rather than
   * retried forever, so a permanently rejected address cannot keep a worker
   * busy on every incident.
   */
  attemptCount: number;
  lastAttemptAt: Date | null;
  failureReason: string | null;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationDocument = HydratedDocument<NotificationAttributes>;

const notificationSchema = new Schema<NotificationAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    event: { type: String, required: true, enum: NOTIFICATION_EVENTS },
    channel: { type: String, required: true, enum: NOTIFICATION_CHANNELS, default: 'email' },
    status: { type: String, required: true, enum: NOTIFICATION_STATUSES, default: 'pending' },
    websiteId: { type: Schema.Types.ObjectId, ref: 'Website', default: null },
    incidentId: { type: Schema.Types.ObjectId, ref: 'Incident', default: null },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 2000 },
    dedupeKey: { type: String, required: true, maxlength: 200 },
    sentAt: { type: Date, default: null },
    attemptCount: { type: Number, required: true, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    failureReason: { type: String, default: null, maxlength: 500 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'notifications' },
);

// The deduplication guarantee. See `dedupeKey`.
notificationSchema.index({ dedupeKey: 1 }, { unique: true, name: 'notification_dedupe_unique' });

// Backs the in-app notification feed for one user in one organization.
notificationSchema.index(
  { userId: 1, organizationId: 1, createdAt: -1 },
  { name: 'notification_user_org_created_at' },
);

// Backs the unread badge without scanning the feed.
notificationSchema.index(
  { userId: 1, readAt: 1, createdAt: -1 },
  { name: 'notification_user_unread' },
);

// Backs the operational question "what failed to deliver, and when": the only
// query that reads this collection outside one user's own feed.
notificationSchema.index({ status: 1, createdAt: -1 }, { name: 'notification_status_created_at' });

export const NotificationModel: Model<NotificationAttributes> =
  (mongoose.models.Notification as Model<NotificationAttributes> | undefined) ??
  model<NotificationAttributes>('Notification', notificationSchema);
