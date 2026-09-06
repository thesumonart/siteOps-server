import {
  CHECK_ERROR_TYPES,
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
} from '../contracts/index.js';
import type {
  CheckErrorType,
  IncidentCategory,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
} from '../contracts/index.js';
import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

export interface IncidentAttributes {
  organizationId: Types.ObjectId;
  websiteId: Types.ObjectId;
  status: IncidentStatus;
  type: IncidentType;
  /**
   * Deduplication bucket. One open incident per website per category; see the
   * index below and `categoryForIncidentType`.
   */
  category: IncidentCategory;
  severity: IncidentSeverity;
  /**
   * One line of context from whichever monitor raised this, such as "expires in
   * 6 days". Null for uptime failures, which are described by the error fields.
   */
  detail: string | null;
  startedAt: Date;
  resolvedAt: Date | null;
  durationSeconds: number | null;
  failedCheckCount: number;
  lastStatusCode: number | null;
  lastErrorType: CheckErrorType | null;
  lastErrorMessage: string | null;
  /**
   * Set once, when the outage notification is dispatched. Its presence is what
   * makes alerting idempotent: a replayed job finds it already set and sends
   * nothing.
   */
  downNotifiedAt: Date | null;
  recoveryNotifiedAt: Date | null;
  resolvedByUserId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type IncidentDocument = HydratedDocument<IncidentAttributes>;

const incidentSchema = new Schema<IncidentAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    websiteId: { type: Schema.Types.ObjectId, required: true, ref: 'Website' },
    status: { type: String, required: true, enum: INCIDENT_STATUSES, default: 'open' },
    type: { type: String, required: true, enum: INCIDENT_TYPES, default: 'downtime' },
    category: {
      type: String,
      required: true,
      enum: INCIDENT_CATEGORIES,
      default: 'availability',
    },
    severity: { type: String, required: true, enum: INCIDENT_SEVERITIES, default: 'critical' },
    detail: { type: String, default: null, maxlength: 300 },
    startedAt: { type: Date, required: true },
    resolvedAt: { type: Date, default: null },
    durationSeconds: { type: Number, default: null, min: 0 },
    failedCheckCount: { type: Number, required: true, default: 0, min: 0 },
    lastStatusCode: { type: Number, default: null },
    lastErrorType: { type: String, enum: [...CHECK_ERROR_TYPES, null], default: null },
    lastErrorMessage: { type: String, default: null, maxlength: 500 },
    downNotifiedAt: { type: Date, default: null },
    recoveryNotifiedAt: { type: Date, default: null },
    resolvedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'incidents' },
);

/**
 * At most one open incident per website *per category*, enforced by the
 * database rather than by application logic.
 *
 * This is the guarantee behind incident deduplication: even if two workers
 * process the same failing check concurrently, the second insert fails with a
 * duplicate-key error instead of opening a second incident for one outage.
 *
 * The key is `(websiteId, category)` rather than `websiteId` alone so that an
 * expiring certificate and an outage can be open at the same time — they are
 * unrelated problems, and suppressing one because the other exists would lose
 * the alert that mattered. Two *availability* incidents still cannot coexist,
 * because every uptime failure maps to the same category.
 *
 * Widening this index is a schema change: documents written before the
 * category existed carry none, and `scripts/migrate.ts` backfills them with
 * `availability` before the new index is built.
 */
incidentSchema.index(
  { websiteId: 1, category: 1 },
  {
    unique: true,
    name: 'incident_one_open_per_website_category',
    partialFilterExpression: { status: 'open' },
  },
);

// Backs the category filter on the incident list.
incidentSchema.index(
  { organizationId: 1, category: 1, startedAt: -1, _id: -1 },
  { name: 'incident_org_category_started_at' },
);

/*
 * Backs the organization incident list, newest first.
 *
 * `_id` is the last key because the list is paged by a keyset cursor sorted on
 * `(startedAt, _id)` — two websites failing in the same millisecond would
 * otherwise make the page boundary ambiguous, and the tiebreak has to be part
 * of the index or the sort becomes a blocking one.
 */
incidentSchema.index(
  { organizationId: 1, startedAt: -1, _id: -1 },
  { name: 'incident_org_started_at' },
);

// Backs the "open incidents" counter and the status filter on that same list.
incidentSchema.index(
  { organizationId: 1, status: 1, startedAt: -1, _id: -1 },
  { name: 'incident_org_status_started_at' },
);

// Backs the incident history shown on a website's detail page.
incidentSchema.index(
  { websiteId: 1, startedAt: -1, _id: -1 },
  { name: 'incident_website_started_at' },
);

export const IncidentModel: Model<IncidentAttributes> =
  (mongoose.models.Incident as Model<IncidentAttributes> | undefined) ??
  model<IncidentAttributes>('Incident', incidentSchema);
