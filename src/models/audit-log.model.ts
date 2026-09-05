import { AUDIT_ACTIONS } from '../contracts/index.js';
import type { AuditAction } from '../contracts/index.js';
import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Append-only record of who changed what inside an organization.
 *
 * `actorName` and `targetLabel` are denormalized snapshots taken at write time
 * so the activity feed still reads correctly after the user is renamed or the
 * website is deleted.
 */
export interface AuditLogAttributes {
  organizationId: Types.ObjectId;
  actorUserId: Types.ObjectId | null;
  actorName: string;
  action: AuditAction;
  targetType: string | null;
  targetId: Types.ObjectId | null;
  targetLabel: string | null;
  createdAt: Date;
}

export type AuditLogDocument = HydratedDocument<AuditLogAttributes>;

export const AUDIT_LOG_RETENTION_SECONDS = 365 * 24 * 60 * 60;

const auditLogSchema = new Schema<AuditLogAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    // Null when the actor is the system rather than a person, such as an
    // incident resolved automatically by the monitoring worker.
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, required: true, maxlength: 120 },
    action: { type: String, required: true, enum: AUDIT_ACTIONS },
    targetType: { type: String, default: null, maxlength: 40 },
    targetId: { type: Schema.Types.ObjectId, default: null },
    targetLabel: { type: String, default: null, maxlength: 200 },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false, collection: 'audit_logs' },
);

// The activity feed: one organization, newest first.
auditLogSchema.index({ organizationId: 1, createdAt: -1 }, { name: 'audit_org_created_at' });

auditLogSchema.index(
  { createdAt: 1 },
  { name: 'audit_ttl', expireAfterSeconds: AUDIT_LOG_RETENTION_SECONDS },
);

export const AuditLogModel: Model<AuditLogAttributes> =
  (mongoose.models.AuditLog as Model<AuditLogAttributes> | undefined) ??
  model<AuditLogAttributes>('AuditLog', auditLogSchema);
