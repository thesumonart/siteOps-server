import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { STATUS_PAGE_THEMES } from '../contracts/index.js';
import type { StatusPageTheme } from '../contracts/index.js';

/**
 * A public status page.
 *
 * Components reference websites by id and carry their own display name, so an
 * agency's internal name for a site never reaches the public page unless they
 * type it there. Deleting a website removes it from every page — see
 * `WebsiteRepository.detachFromStatusPages`.
 */
export interface StatusPageComponent {
  websiteId: Types.ObjectId;
  displayName: string;
}

/**
 * A custom domain claimed for the page.
 *
 * `verificationToken` is not a secret — it is published in DNS by design — so
 * it is stored as it is. What matters is that it is per claim: whoever adds the
 * matching TXT record under the domain has proved they control it.
 */
export interface StatusPageCustomDomain {
  domain: string;
  verificationToken: string;
  verifiedAt: Date | null;
}

export interface StatusPageThemeSettings {
  mode: StatusPageTheme;
  accentColor: string | null;
}

export interface StatusPageAttributes {
  organizationId: Types.ObjectId;
  slug: string;
  title: string;
  description: string | null;
  published: boolean;
  theme: StatusPageThemeSettings;
  components: StatusPageComponent[];
  customDomain: StatusPageCustomDomain | null;
  createdByUserId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type StatusPageDocument = HydratedDocument<StatusPageAttributes>;

const componentSchema = new Schema<StatusPageComponent>(
  {
    websiteId: { type: Schema.Types.ObjectId, required: true, ref: 'Website' },
    displayName: { type: String, required: true, trim: true, maxlength: 120 },
  },
  { _id: false },
);

const customDomainSchema = new Schema<StatusPageCustomDomain>(
  {
    domain: { type: String, required: true, lowercase: true, trim: true, maxlength: 253 },
    verificationToken: { type: String, required: true, maxlength: 128 },
    verifiedAt: { type: Date, default: null },
  },
  { _id: false },
);

const themeSchema = new Schema<StatusPageThemeSettings>(
  {
    mode: { type: String, required: true, enum: STATUS_PAGE_THEMES, default: 'auto' },
    // Six hex digits at the storage layer too: this value reaches a style
    // attribute on a page anyone can load.
    accentColor: { type: String, default: null, match: /^#[0-9a-fA-F]{6}$/ },
  },
  { _id: false },
);

const statusPageSchema = new Schema<StatusPageAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 48 },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: null, maxlength: 500 },
    published: { type: Boolean, required: true, default: false },
    theme: {
      type: themeSchema,
      required: true,
      default: () => ({ mode: 'auto', accentColor: null }),
    },
    components: { type: [componentSchema], default: [] },
    customDomain: { type: customDomainSchema, default: null },
    createdByUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  },
  { timestamps: true, collection: 'status_pages' },
);

// The public URL. Global, because it is not scoped to an organization.
statusPageSchema.index({ slug: 1 }, { unique: true, name: 'status_page_slug_unique' });

// The settings list, newest first.
statusPageSchema.index(
  { organizationId: 1, createdAt: -1 },
  { name: 'status_page_org_created_at' },
);

/*
 * The custom-domain router's lookup, and who owns a domain.
 *
 * Unique only once verified. A plain unique index would let anyone *claim*
 * `status.acme.com` first and block Acme from ever adding it; here any number
 * of organizations can hold a pending claim, and the first to prove it in DNS
 * takes it. The partial filter also keeps unverified domains out of the index
 * the router reads, so an unproven name can never route anywhere.
 */
statusPageSchema.index(
  { 'customDomain.domain': 1 },
  {
    unique: true,
    name: 'status_page_verified_domain_unique',
    partialFilterExpression: { 'customDomain.verifiedAt': { $type: 'date' } },
  },
);

export const StatusPageModel: Model<StatusPageAttributes> =
  (mongoose.models.StatusPage as Model<StatusPageAttributes> | undefined) ??
  model<StatusPageAttributes>('StatusPage', statusPageSchema);
