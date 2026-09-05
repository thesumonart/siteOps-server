import { ORGANIZATION_ROLES } from '../contracts/index.js';
import type { OrganizationRole } from '../contracts/index.js';
import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * A user's standing in one organization.
 *
 * This collection is the authority on "may this person act here". Every
 * authorization decision in the API starts by reading a row from it for the
 * *authenticated* user — never from an id the client supplied.
 */
export interface OrganizationMemberAttributes {
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  role: OrganizationRole;
  invitedByUserId: Types.ObjectId | null;
  joinedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type OrganizationMemberDocument = HydratedDocument<OrganizationMemberAttributes>;

const organizationMemberSchema = new Schema<OrganizationMemberAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    role: { type: String, required: true, enum: ORGANIZATION_ROLES, default: 'member' },
    invitedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    joinedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, collection: 'organization_members' },
);

// A user holds exactly one role per organization. The unique index is the
// authority — it makes a duplicate invite a database error rather than a race.
organizationMemberSchema.index(
  { organizationId: 1, userId: 1 },
  { unique: true, name: 'member_org_user_unique' },
);
// Backs "which organizations does this user belong to", run on every request
// that resolves the active organization.
organizationMemberSchema.index({ userId: 1 }, { name: 'member_by_user' });
// Backs the members table, sorted by seniority then join order.
organizationMemberSchema.index(
  { organizationId: 1, joinedAt: 1 },
  { name: 'member_org_joined_at' },
);

export const OrganizationMemberModel: Model<OrganizationMemberAttributes> =
  (mongoose.models.OrganizationMember as Model<OrganizationMemberAttributes> | undefined) ??
  model<OrganizationMemberAttributes>('OrganizationMember', organizationMemberSchema);
