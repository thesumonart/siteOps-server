import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { env } from '../config/env.js';
import { CHECK_ERROR_TYPES, CHECK_STATUSES } from '../contracts/index.js';
import type { CheckErrorType, CheckStatus } from '../contracts/index.js';

/**
 * One monitoring request and its outcome.
 *
 * This is by far the highest-volume collection: a single website on a
 * one-minute interval writes 525,600 documents a year. Documents are therefore
 * kept small, are never updated after insert, and expire automatically.
 */
export interface WebsiteCheckAttributes {
  websiteId: Types.ObjectId;
  /** Denormalized so tenant-scoped analytics never need a join. */
  organizationId: Types.ObjectId;
  status: CheckStatus;
  statusCode: number | null;
  responseTimeMs: number | null;
  checkedAt: Date;
  errorType: CheckErrorType | null;
  errorMessage: string | null;
  redirectCount: number;
}

export type WebsiteCheckDocument = HydratedDocument<WebsiteCheckAttributes>;

/**
 * How long a raw check document survives, from `CHECK_RETENTION_DAYS`.
 *
 * Retention is enforced by MongoDB's TTL monitor, not by anything this process
 * runs — which is the point: a scheduled cleanup job that quietly stops working
 * grows the collection forever, and this is by far the largest one. A single
 * website on a one-minute interval writes 525,600 documents a year.
 *
 * Because the value is baked into the index, changing it takes effect only
 * after `pnpm indexes:sync` drops and recreates `check_ttl`.
 */
export const CHECK_RETENTION_SECONDS = env.CHECK_RETENTION_DAYS * 24 * 60 * 60;

const websiteCheckSchema = new Schema<WebsiteCheckAttributes>(
  {
    websiteId: { type: Schema.Types.ObjectId, required: true, ref: 'Website' },
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    status: { type: String, required: true, enum: CHECK_STATUSES },
    statusCode: { type: Number, default: null },
    responseTimeMs: { type: Number, default: null },
    checkedAt: { type: Date, required: true },
    errorType: { type: String, enum: [...CHECK_ERROR_TYPES, null], default: null },
    // Truncated on write; an upstream error page must never become a large document.
    errorMessage: { type: String, default: null, maxlength: 500 },
    redirectCount: { type: Number, required: true, default: 0, min: 0 },
  },
  {
    // `createdAt` would duplicate `checkedAt` on a collection this size.
    timestamps: false,
    collection: 'website_checks',
  },
);

/*
 * The check-history table and every uptime aggregation read one website's most
 * recent checks, which is exactly these indexes.
 *
 * They end in `_id` because the history is paged by a keyset cursor sorted on
 * `(checkedAt, _id)`. Without `_id` in the index the database can satisfy the
 * range but not the sort, and every page would scan a website's entire history
 * to top-K sort 20 rows out of it.
 */
websiteCheckSchema.index(
  { websiteId: 1, checkedAt: -1, _id: -1 },
  { name: 'check_website_checked_at' },
);

// Backs the "errors only" filter on the check history view.
websiteCheckSchema.index(
  { websiteId: 1, status: 1, checkedAt: -1, _id: -1 },
  { name: 'check_website_status_checked_at' },
);

// Organization-wide rollups for the dashboard summary cards.
websiteCheckSchema.index({ organizationId: 1, checkedAt: -1 }, { name: 'check_org_checked_at' });

// Automatic expiry; see CHECK_RETENTION_SECONDS.
websiteCheckSchema.index(
  { checkedAt: 1 },
  { name: 'check_ttl', expireAfterSeconds: CHECK_RETENTION_SECONDS },
);

export const WebsiteCheckModel: Model<WebsiteCheckAttributes> =
  (mongoose.models.WebsiteCheck as Model<WebsiteCheckAttributes> | undefined) ??
  model<WebsiteCheckAttributes>('WebsiteCheck', websiteCheckSchema);
