import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { REPORT_FORMATS, REPORT_TYPES, SCHEDULE_FREQUENCIES } from '../contracts/index.js';
import type { ReportFormat, ReportType, ScheduleFrequency } from '../contracts/index.js';

/**
 * A recurring report.
 *
 * The third lease queue in the product, and the same shape as the other two:
 * `nextRunAt` is the ready time, `leaseExpiresAt` is the visibility timeout, and
 * one atomic `findOneAndUpdate` claims a schedule. Consistency matters more
 * here than elsewhere — a duplicate claim means a client receives the same
 * report twice.
 *
 * `hourUtc` is UTC and named so. A scheduler that quietly interprets "9" in the
 * server's local zone sends a report at a different time depending on where it
 * is deployed, which is the kind of bug nobody finds until they move region.
 */
export interface ReportScheduleAttributes {
  organizationId: Types.ObjectId;
  name: string;
  frequency: ScheduleFrequency;
  /** 0 = Sunday. Ignored for a monthly schedule, which runs on the 1st. */
  dayOfWeek: number;
  hourUtc: number;
  type: ReportType;
  websiteIds: Types.ObjectId[];
  format: ReportFormat;
  recipients: string[];
  enabled: boolean;

  nextRunAt: Date;
  leaseExpiresAt: Date | null;
  lastRunAt: Date | null;
  /** The report the last run produced, for the "last sent" link in the UI. */
  lastReportId: Types.ObjectId | null;
  lastError: string | null;

  createdByUserId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type ReportScheduleDocument = HydratedDocument<ReportScheduleAttributes>;

const reportScheduleSchema = new Schema<ReportScheduleAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    name: { type: String, required: true, maxlength: 120 },
    frequency: { type: String, required: true, enum: SCHEDULE_FREQUENCIES },
    dayOfWeek: { type: Number, required: true, default: 1, min: 0, max: 6 },
    hourUtc: { type: Number, required: true, default: 8, min: 0, max: 23 },
    type: { type: String, required: true, enum: REPORT_TYPES },
    websiteIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Website' },
    format: { type: String, required: true, enum: REPORT_FORMATS, default: 'pdf' },
    // Addresses rather than user ids: a client contact who receives the monthly
    // report is not necessarily anyone with an account.
    recipients: { type: [String], default: [] },
    enabled: { type: Boolean, required: true, default: true },
    nextRunAt: { type: Date, required: true },
    leaseExpiresAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    lastReportId: { type: Schema.Types.ObjectId, ref: 'Report', default: null },
    lastError: { type: String, default: null, maxlength: 500 },
    createdByUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  },
  { timestamps: true, collection: 'report_schedules' },
);

// The schedules list for one organization.
reportScheduleSchema.index(
  { organizationId: 1, createdAt: -1 },
  { name: 'schedule_org_created_at' },
);

// The claim query: enabled schedules that are due. The partial filter keeps
// disabled ones out of the index.
reportScheduleSchema.index(
  { nextRunAt: 1 },
  { name: 'schedule_due', partialFilterExpression: { enabled: true } },
);

export const ReportScheduleModel: Model<ReportScheduleAttributes> =
  (mongoose.models.ReportSchedule as Model<ReportScheduleAttributes> | undefined) ??
  model<ReportScheduleAttributes>('ReportSchedule', reportScheduleSchema);
