import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { env } from '../config/env.js';
import { FINDING_SEVERITIES, MONITOR_STATUSES, MONITOR_TYPES } from '../contracts/index.js';
import type {
  FindingSeverity,
  MonitorCheckData,
  MonitorStatus,
  MonitorType,
} from '../contracts/index.js';

/**
 * One run of one auxiliary monitor, and what it found.
 *
 * Append-only, never updated after insert, and expired by a TTL index — the
 * same discipline as `website_checks`, for the same reason. The volume is far
 * lower (a daily certificate check writes 365 documents a year, not 525,600),
 * but a link crawl's result carries a list of broken URLs, so the documents are
 * much larger. Both halves of that are bounded: the list is capped when it is
 * built, and the whole document expires.
 */
export interface MonitorFindingAttributes {
  code: string;
  severity: FindingSeverity;
  message: string;
  detail: string | null;
}

export interface MonitorResultAttributes {
  organizationId: Types.ObjectId;
  websiteId: Types.ObjectId;
  monitorId: Types.ObjectId;
  type: MonitorType;
  status: MonitorStatus;
  checkedAt: Date;
  /** Wall-clock time the run took, for spotting a monitor that is getting slower. */
  durationMs: number;
  summary: string;
  /**
   * The type-specific payload, discriminated by `type`.
   *
   * Stored untyped for the same reason as the monitor's config: the only writer
   * is this codebase, and a typed sub-schema per monitor would be six schemas
   * to maintain for validation of data MongoDB never has to interpret.
   */
  data: MonitorCheckData;
  findings: MonitorFindingAttributes[];
  /** Set when `status` is `error`: why the monitor could not produce an answer. */
  errorMessage: string | null;
}

export type MonitorResultDocument = HydratedDocument<MonitorResultAttributes>;

/**
 * How long a monitor result survives.
 *
 * Deliberately the same window as raw uptime checks, so one environment
 * variable governs "how far back can I see" for every kind of monitoring data.
 * Baked into the index, so a change takes effect only after `pnpm indexes:sync`.
 */
export const MONITOR_RESULT_RETENTION_SECONDS = env.CHECK_RETENTION_DAYS * 24 * 60 * 60;

const findingSchema = new Schema<MonitorFindingAttributes>(
  {
    code: { type: String, required: true, maxlength: 60 },
    severity: { type: String, required: true, enum: FINDING_SEVERITIES },
    message: { type: String, required: true, maxlength: 300 },
    detail: { type: String, default: null, maxlength: 500 },
  },
  { _id: false },
);

const monitorResultSchema = new Schema<MonitorResultAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    websiteId: { type: Schema.Types.ObjectId, required: true, ref: 'Website' },
    monitorId: { type: Schema.Types.ObjectId, required: true, ref: 'WebsiteMonitor' },
    type: { type: String, required: true, enum: MONITOR_TYPES },
    status: { type: String, required: true, enum: MONITOR_STATUSES },
    checkedAt: { type: Date, required: true },
    durationMs: { type: Number, required: true, min: 0 },
    summary: { type: String, required: true, maxlength: 300 },
    data: { type: Schema.Types.Mixed, required: true },
    findings: { type: [findingSchema], default: [] },
    errorMessage: { type: String, default: null, maxlength: 500 },
  },
  // `createdAt` would duplicate `checkedAt`.
  { timestamps: false, collection: 'monitor_results' },
);

/*
 * The history panel for one monitor, newest first.
 *
 * Ends in `_id` because the history is paged by a keyset cursor sorted on
 * `(checkedAt, _id)`; without the tiebreak in the index the sort becomes a
 * blocking one.
 */
monitorResultSchema.index(
  { monitorId: 1, checkedAt: -1, _id: -1 },
  { name: 'result_monitor_checked_at' },
);

// Every monitor result for one website, for the website detail page and for a
// report that has to assemble one website's full picture in one pass.
monitorResultSchema.index(
  { websiteId: 1, type: 1, checkedAt: -1 },
  { name: 'result_website_type_checked_at' },
);

// Organization-wide rollups, which is how a report gathers a period's data.
monitorResultSchema.index({ organizationId: 1, checkedAt: -1 }, { name: 'result_org_checked_at' });

monitorResultSchema.index(
  { checkedAt: 1 },
  { name: 'result_ttl', expireAfterSeconds: MONITOR_RESULT_RETENTION_SECONDS },
);

export const MonitorResultModel: Model<MonitorResultAttributes> =
  (mongoose.models.MonitorResult as Model<MonitorResultAttributes> | undefined) ??
  model<MonitorResultAttributes>('MonitorResult', monitorResultSchema);
