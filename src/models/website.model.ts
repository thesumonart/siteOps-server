import {
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_MONITORING_INTERVAL_SECONDS,
  DEFAULT_RECOVERY_THRESHOLD,
  DEFAULT_REQUEST_TIMEOUT_MS,
  WEBSITE_STATUSES,
} from '../contracts/index.js';
import type { WebsiteStatus } from '../contracts/index.js';
import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

export interface WebsiteAttributes {
  organizationId: Types.ObjectId;
  name: string;
  /** Canonical absolute URL produced by `normalizeWebsiteUrl`. */
  url: string;
  /**
   * Scheme/`www`/trailing-slash-insensitive form of `url`, used to stop the
   * same site being added twice within one organization.
   */
  canonicalKey: string;
  status: WebsiteStatus;
  monitoringEnabled: boolean;
  monitoringIntervalSeconds: number;
  requestTimeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;

  /**
   * Consecutive outcome counters driving incident confirmation. They live on
   * the website document so the worker can read state and claim work in one
   * atomic `findOneAndUpdate`, with no separate coordination store.
   */
  consecutiveFailures: number;
  consecutiveSuccesses: number;

  /** When this website is next eligible for a check. Drives the scheduler query. */
  nextCheckAt: Date;
  /**
   * Lease held by the worker currently checking this website. An expired lease
   * is reclaimable, so a crashed worker cannot strand a website permanently.
   */
  leaseExpiresAt: Date | null;

  lastCheckedAt: Date | null;
  lastSuccessfulCheckAt: Date | null;
  lastFailedAt: Date | null;
  lastResponseTimeMs: number | null;
  lastStatusCode: number | null;

  /** Open incident, if any. Mirrors the incident collection for fast reads. */
  currentIncidentId: Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

export type WebsiteDocument = HydratedDocument<WebsiteAttributes>;

const websiteSchema = new Schema<WebsiteAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    url: { type: String, required: true, trim: true, maxlength: 2048 },
    canonicalKey: { type: String, required: true, trim: true, maxlength: 2048 },
    status: { type: String, required: true, enum: WEBSITE_STATUSES, default: 'unknown' },
    monitoringEnabled: { type: Boolean, required: true, default: true },
    monitoringIntervalSeconds: {
      type: Number,
      required: true,
      default: DEFAULT_MONITORING_INTERVAL_SECONDS,
      min: 60,
      max: 86_400,
    },
    requestTimeoutMs: {
      type: Number,
      required: true,
      default: DEFAULT_REQUEST_TIMEOUT_MS,
      min: 1_000,
      max: 60_000,
    },
    failureThreshold: {
      type: Number,
      required: true,
      default: DEFAULT_FAILURE_THRESHOLD,
      min: 1,
      max: 10,
    },
    recoveryThreshold: {
      type: Number,
      required: true,
      default: DEFAULT_RECOVERY_THRESHOLD,
      min: 1,
      max: 10,
    },
    consecutiveFailures: { type: Number, required: true, default: 0, min: 0 },
    consecutiveSuccesses: { type: Number, required: true, default: 0, min: 0 },
    nextCheckAt: { type: Date, required: true, default: () => new Date() },
    leaseExpiresAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    lastSuccessfulCheckAt: { type: Date, default: null },
    lastFailedAt: { type: Date, default: null },
    lastResponseTimeMs: { type: Number, default: null },
    lastStatusCode: { type: Number, default: null },
    currentIncidentId: { type: Schema.Types.ObjectId, ref: 'Incident', default: null },
  },
  { timestamps: true, collection: 'websites' },
);

// Every tenant-scoped list query starts from organizationId; the createdAt
// suffix lets the websites table paginate without an in-memory sort.
websiteSchema.index({ organizationId: 1, createdAt: -1 }, { name: 'website_org_created_at' });

// Enforces "one website per URL per organization" at the storage layer, so a
// double-submitted form cannot create two monitors for the same target.
websiteSchema.index(
  { organizationId: 1, canonicalKey: 1 },
  { unique: true, name: 'website_org_canonical_unique' },
);

// The scheduler's hot query: enabled websites that are due and unleased. The
// partial filter keeps paused websites out of the index entirely.
websiteSchema.index(
  { nextCheckAt: 1 },
  {
    name: 'website_due_for_check',
    partialFilterExpression: { monitoringEnabled: true },
  },
);

// Backs the dashboard status counters.
websiteSchema.index({ organizationId: 1, status: 1 }, { name: 'website_org_status' });

export const WebsiteModel: Model<WebsiteAttributes> =
  (mongoose.models.Website as Model<WebsiteAttributes> | undefined) ??
  model<WebsiteAttributes>('Website', websiteSchema);
