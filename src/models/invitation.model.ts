import { ORGANIZATION_ROLES } from '../contracts/index.js';
import type { OrganizationRole } from '../contracts/index.js';
import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * A pending invitation to join an organization.
 *
 * The invited address may not have an account yet, so the invitation is keyed
 * by email rather than by user id and is only converted into a membership when
 * it is accepted.
 */
export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;

export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export interface InvitationAttributes {
  organizationId: Types.ObjectId;
  /** Lowercased at write time so lookups and the unique index agree. */
  email: string;
  role: OrganizationRole;
  status: InvitationStatus;
  /**
   * SHA-256 of the token that was emailed. The token itself is never stored:
   * a leaked database must not yield working invitation links.
   */
  tokenHash: string;
  invitedByUserId: Types.ObjectId;
  invitedByName: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InvitationDocument = HydratedDocument<InvitationAttributes>;

export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

const invitationSchema = new Schema<InvitationAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    role: { type: String, required: true, enum: ORGANIZATION_ROLES, default: 'member' },
    status: { type: String, required: true, enum: INVITATION_STATUSES, default: 'pending' },
    tokenHash: { type: String, required: true, maxlength: 64 },
    invitedByUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    invitedByName: { type: String, required: true, maxlength: 120 },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    acceptedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'invitations' },
);

/**
 * One outstanding invitation per address per organization. Re-inviting replaces
 * the pending one rather than stacking duplicates, and the partial filter keeps
 * accepted and revoked history out of the constraint.
 */
invitationSchema.index(
  { organizationId: 1, email: 1 },
  {
    unique: true,
    name: 'invitation_one_pending_per_email',
    partialFilterExpression: { status: 'pending' },
  },
);

// Token lookup when an invitation link is opened.
invitationSchema.index({ tokenHash: 1 }, { name: 'invitation_by_token' });

// The members screen lists outstanding invitations alongside members.
invitationSchema.index(
  { organizationId: 1, status: 1, createdAt: -1 },
  { name: 'invitation_org_status_created_at' },
);

export const InvitationModel: Model<InvitationAttributes> =
  (mongoose.models.Invitation as Model<InvitationAttributes> | undefined) ??
  model<InvitationAttributes>('Invitation', invitationSchema);
