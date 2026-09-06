import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { REPORT_STATUSES, REPORT_TYPES } from '../contracts/index.js';
import type { ReportData, ReportStatus, ReportType } from '../contracts/index.js';

/**
 * One generated report.
 *
 * Holds the *facts*, not a file. The PDF, CSV or JSON is rendered from `data`
 * on download, which is why there is no bucket to provision and why a branding
 * change applies retroactively to every past report. See
 * `contracts/domain/report.ts` for the reasoning.
 *
 * `data` is null until the worker finishes: generation runs there rather than
 * in the request, because a month of checks across fifty websites is not
 * something to aggregate while an HTTP connection waits.
 */
export interface ReportAttributes {
  organizationId: Types.ObjectId;
  type: ReportType;
  title: string;
  status: ReportStatus;
  periodStart: Date;
  periodEnd: Date;
  /** Empty for an organization-wide report covering everything. */
  websiteIds: Types.ObjectId[];
  /** Null for a scheduled report, which nobody pressed a button for. */
  requestedByUserId: Types.ObjectId | null;
  /** Set when this report came from a schedule rather than a person. */
  scheduleId: Types.ObjectId | null;
  data: ReportData | null;
  generatedAt: Date | null;
  /** Set when `status` is `failed`. Shown to the user, so it stays readable. */
  errorMessage: string | null;

  /** Claim fields, mirroring every other queue in the product. */
  nextAttemptAt: Date | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;

  createdAt: Date;
  updatedAt: Date;
}

export type ReportDocument = HydratedDocument<ReportAttributes>;

/**
 * How long a generated report is kept.
 *
 * A year, matching the audit log rather than the 90-day check retention: a
 * report is a summary somebody may need for a client review long after the raw
 * checks behind it have expired. That is exactly why the facts are stored
 * rather than recomputed — after 90 days there is nothing left to recompute
 * from.
 */
export const REPORT_RETENTION_SECONDS = 365 * 24 * 60 * 60;

const reportSchema = new Schema<ReportAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    type: { type: String, required: true, enum: REPORT_TYPES },
    title: { type: String, required: true, maxlength: 200 },
    status: { type: String, required: true, enum: REPORT_STATUSES, default: 'pending' },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    websiteIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Website' },
    requestedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    scheduleId: { type: Schema.Types.ObjectId, ref: 'ReportSchedule', default: null },
    data: { type: Schema.Types.Mixed, default: null },
    generatedAt: { type: Date, default: null },
    errorMessage: { type: String, default: null, maxlength: 500 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    leaseExpiresAt: { type: Date, default: null },
    attemptCount: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, collection: 'reports' },
);

// The reports list, newest first, keyset-paged.
reportSchema.index(
  { organizationId: 1, createdAt: -1, _id: -1 },
  { name: 'report_org_created_at' },
);

/*
 * The generation queue's claim query: pending reports that are due and
 * unleased. The partial filter keeps finished reports out of the index
 * entirely, which is almost all of them.
 */
reportSchema.index(
  { nextAttemptAt: 1 },
  {
    name: 'report_pending',
    partialFilterExpression: { status: { $in: ['pending', 'generating'] } },
  },
);

reportSchema.index(
  { createdAt: 1 },
  { name: 'report_ttl', expireAfterSeconds: REPORT_RETENTION_SECONDS },
);

export const ReportModel: Model<ReportAttributes> =
  (mongoose.models.Report as Model<ReportAttributes> | undefined) ??
  model<ReportAttributes>('Report', reportSchema);
