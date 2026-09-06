import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';

/**
 * One provider webhook event that has already been applied.
 *
 * This collection exists for exactly one reason: **idempotency**. Every payment
 * provider retries a webhook it did not get a 2xx for, and several deliver at
 * least once by design, so the same `subscription.updated` will arrive twice.
 * Applying it twice is usually harmless and occasionally is not — a retried
 * `deleted` racing a re-subscribe would downgrade a paying customer.
 *
 * The guarantee comes from the unique index below, not from a read-then-write:
 * two workers processing the same retry concurrently both attempt the insert
 * and exactly one wins, because uniqueness is enforced by the database rather
 * than by a check that another process can interleave with. This is the same
 * pattern incidents and notifications already use.
 *
 * Records expire after 30 days. A provider stops retrying long before that —
 * Stripe gives up after 3 days — so anything older can no longer be a duplicate,
 * and keeping it forever would be an unbounded collection storing nothing but
 * identifiers.
 */
const BILLING_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export interface BillingEventAttributes {
  /** The provider's own event id, e.g. Stripe's `evt_...`. */
  eventId: string;
  /** Event name as the provider sent it, kept for support questions. */
  type: string;
  receivedAt: Date;
}

export type BillingEventDocument = HydratedDocument<BillingEventAttributes>;

const billingEventSchema = new Schema<BillingEventAttributes>(
  {
    eventId: { type: String, required: true, maxlength: 255 },
    type: { type: String, required: true, maxlength: 120 },
    receivedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false, collection: 'billing_events' },
);

// The whole point of the collection. Uniqueness is what makes a retry a no-op.
billingEventSchema.index({ eventId: 1 }, { unique: true, name: 'billing_event_id_unique' });

billingEventSchema.index(
  { receivedAt: 1 },
  { name: 'billing_event_ttl', expireAfterSeconds: BILLING_EVENT_RETENTION_SECONDS },
);

export const BillingEventModel: Model<BillingEventAttributes> =
  (mongoose.models.BillingEvent as Model<BillingEventAttributes> | undefined) ??
  model<BillingEventAttributes>('BillingEvent', billingEventSchema);
