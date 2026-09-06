import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { MONITOR_STATUSES, MONITOR_TYPES } from '../contracts/index.js';
import type { MonitorConfig, MonitorStatus, MonitorType } from '../contracts/index.js';

/**
 * One auxiliary monitor attached to one website.
 *
 * This collection *is* the auxiliary work queue, exactly as `websites` is the
 * uptime queue: `nextRunAt` is the ready time, `leaseExpiresAt` is the
 * visibility timeout, and a single atomic `findOneAndUpdate` claims a document.
 * The pattern is deliberately identical, because a second scheduling mechanism
 * would be a second set of duplicate-run bugs to find.
 *
 * A separate document per `(website, type)` rather than a subdocument on the
 * website, for three reasons that all bite in practice: each type runs on its
 * own cadence, each is leased independently so a seven-minute crawl does not
 * hold up a two-second certificate check, and the claim query is a plain index
 * scan rather than a scan of an array inside every website in the database.
 */
export interface WebsiteMonitorAttributes {
  organizationId: Types.ObjectId;
  websiteId: Types.ObjectId;
  type: MonitorType;
  enabled: boolean;
  intervalSeconds: number;

  /** When this monitor is next eligible to run. Drives the claim query. */
  nextRunAt: Date;
  /** Lease held by the worker currently running it; expired leases are reclaimable. */
  leaseExpiresAt: Date | null;

  lastRunAt: Date | null;
  status: MonitorStatus;
  /** One line describing the last outcome, shown beside the monitor in the UI. */
  lastSummary: string | null;
  /**
   * Consecutive runs that could not produce an answer.
   *
   * Counted separately from a failing *result*: a registry that times out three
   * times is a monitoring problem, not a domain about to expire, and the two
   * must not be reported the same way.
   */
  consecutiveErrors: number;

  /**
   * Per-type settings, discriminated by `type`.
   *
   * Stored untyped. Six typed sub-schemas would buy validation MongoDB does not
   * need — the only writer is this codebase, and every write passes through
   * `monitorConfigSchema` first.
   */
  config: MonitorConfig;

  /** The open incident this monitor raised, if any. */
  currentIncidentId: Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

export type WebsiteMonitorDocument = HydratedDocument<WebsiteMonitorAttributes>;

const websiteMonitorSchema = new Schema<WebsiteMonitorAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    websiteId: { type: Schema.Types.ObjectId, required: true, ref: 'Website' },
    type: { type: String, required: true, enum: MONITOR_TYPES },
    enabled: { type: Boolean, required: true, default: false },
    intervalSeconds: { type: Number, required: true, min: 3_600, max: 2_592_000 },
    nextRunAt: { type: Date, required: true, default: () => new Date() },
    leaseExpiresAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    status: { type: String, required: true, enum: MONITOR_STATUSES, default: 'unknown' },
    lastSummary: { type: String, default: null, maxlength: 300 },
    consecutiveErrors: { type: Number, required: true, default: 0, min: 0 },
    config: { type: Schema.Types.Mixed, required: true },
    currentIncidentId: { type: Schema.Types.ObjectId, ref: 'Incident', default: null },
  },
  { timestamps: true, collection: 'website_monitors' },
);

// One monitor of each type per website, enforced by the database so a
// double-submitted form cannot create two crawlers for one site.
websiteMonitorSchema.index(
  { websiteId: 1, type: 1 },
  { unique: true, name: 'monitor_website_type_unique' },
);

/*
 * The scheduler's hot query: enabled monitors that are due, oldest first.
 *
 * `type` leads the key because the worker claims one type at a time — each has
 * its own concurrency budget, since a crawl and a TLS handshake cost nothing
 * like the same amount. The partial filter keeps disabled monitors out of the
 * index entirely, which matters because most websites will have most types off.
 */
websiteMonitorSchema.index(
  { type: 1, nextRunAt: 1 },
  { name: 'monitor_due_for_run', partialFilterExpression: { enabled: true } },
);

// Backs the monitor panel on a website's page: every monitor for one website.
websiteMonitorSchema.index({ organizationId: 1, websiteId: 1 }, { name: 'monitor_org_website' });

// Backs the organization-wide rollups — "which certificates are expiring".
websiteMonitorSchema.index(
  { organizationId: 1, type: 1, status: 1 },
  { name: 'monitor_org_type_status' },
);

export const WebsiteMonitorModel: Model<WebsiteMonitorAttributes> =
  (mongoose.models.WebsiteMonitor as Model<WebsiteMonitorAttributes> | undefined) ??
  model<WebsiteMonitorAttributes>('WebsiteMonitor', websiteMonitorSchema);
