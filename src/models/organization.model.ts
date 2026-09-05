import { DEFAULT_PLAN, PLANS } from '../contracts/index.js';
import type { Plan } from '../contracts/index.js';
import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

export interface OrganizationAttributes {
  name: string;
  slug: string;
  plan: Plan;
  /** IANA zone used to render timestamps for everyone in the organization. */
  timezone: string;
  createdByUserId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type OrganizationDocument = HydratedDocument<OrganizationAttributes>;

const organizationSchema = new Schema<OrganizationAttributes>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 48,
      // Uniqueness is enforced by the index declared below rather than by
      // `unique: true`, so index intent stays in one place.
    },
    plan: { type: String, required: true, enum: PLANS, default: DEFAULT_PLAN },
    timezone: { type: String, required: true, default: 'UTC', maxlength: 64 },
    createdByUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  },
  { timestamps: true, collection: 'organizations' },
);

// Slugs appear in URLs and must be globally unique.
organizationSchema.index({ slug: 1 }, { unique: true, name: 'organization_slug_unique' });

export const OrganizationModel: Model<OrganizationAttributes> =
  (mongoose.models.Organization as Model<OrganizationAttributes> | undefined) ??
  model<OrganizationAttributes>('Organization', organizationSchema);
