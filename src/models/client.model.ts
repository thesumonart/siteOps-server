import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { CLIENT_STATUSES } from '../contracts/index.js';
import type { ClientStatus } from '../contracts/index.js';

/**
 * An agency's client.
 *
 * Holds the relationship — who they are, how to reach them, whether they are
 * still active — and nothing about which websites belong to them. That lives on
 * the website (`website.clientId`), because a website has at most one client and
 * putting the list here would mean two documents to keep in step every time one
 * is reassigned.
 *
 * Portal access is not here either: it is an organization membership carrying
 * the `client` role and this client's id. See `contracts/domain/client.ts` for
 * why that is one auth system rather than two.
 */
export interface ClientAttributes {
  organizationId: Types.ObjectId;
  name: string;
  /** Trading name, when it differs from what the agency calls them. */
  companyName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  status: ClientStatus;
  /** Free text the agency keeps about the relationship. Never shown in the portal. */
  notes: string | null;
  createdByUserId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type ClientDocument = HydratedDocument<ClientAttributes>;

const clientSchema = new Schema<ClientAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    companyName: { type: String, default: null, trim: true, maxlength: 120 },
    contactName: { type: String, default: null, trim: true, maxlength: 120 },
    contactEmail: { type: String, default: null, trim: true, lowercase: true, maxlength: 254 },
    status: { type: String, required: true, enum: CLIENT_STATUSES, default: 'active' },
    notes: { type: String, default: null, maxlength: 2000 },
    createdByUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  },
  { timestamps: true, collection: 'clients' },
);

/*
 * Two clients in one organization may not share a name, and this index serves
 * the alphabetical list as well.
 *
 * Uniqueness is not a storage nicety here: an agency picking a client from a
 * dropdown to assign a website to needs the names to be distinguishable, and a
 * duplicate makes every such choice ambiguous. Scoped to the organization, so
 * two agencies may both have a client called "Acme".
 */
clientSchema.index(
  { organizationId: 1, name: 1 },
  { unique: true, name: 'client_org_name_unique' },
);

// Backs the default list, which separates active clients from archived ones.
clientSchema.index({ organizationId: 1, status: 1, name: 1 }, { name: 'client_org_status_name' });

export const ClientModel: Model<ClientAttributes> =
  (mongoose.models.Client as Model<ClientAttributes> | undefined) ??
  model<ClientAttributes>('Client', clientSchema);
