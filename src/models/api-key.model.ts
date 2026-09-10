import mongoose, { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';

import { API_KEY_SCOPES } from '../contracts/index.js';
import type { ApiKeyScope } from '../contracts/index.js';

/**
 * A key for the public API.
 *
 * Only the SHA-256 of the key is stored, for the reason invitation tokens are
 * stored that way: a key is a bearer credential, and a leaked database must not
 * yield working ones. There is no salt and no stretching because the input is
 * 256 bits of randomness, not a password — there is nothing for a rainbow
 * table to shorten — and the hash is what makes lookup one indexed read.
 *
 * A revoked key keeps its document. The audit log refers to it, and "which key
 * was that, and who made it" must stay answerable after it stops working.
 */
export interface ApiKeyAttributes {
  organizationId: Types.ObjectId;
  name: string;
  /** `so_live_` and the next eight characters, for recognising a key in a list. */
  prefix: string;
  tokenHash: string;
  scopes: ApiKeyScope[];
  createdByUserId: Types.ObjectId;
  /** Snapshotted, so the list still reads correctly after the person leaves. */
  createdByName: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ApiKeyDocument = HydratedDocument<ApiKeyAttributes>;

const apiKeySchema = new Schema<ApiKeyAttributes>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    prefix: { type: String, required: true, maxlength: 32 },
    tokenHash: { type: String, required: true, maxlength: 128 },
    scopes: {
      type: [{ type: String, enum: API_KEY_SCOPES }],
      required: true,
      validate: {
        validator: (scopes: readonly string[]) => scopes.length > 0,
        message: 'A key must carry at least one scope.',
      },
    },
    createdByUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    createdByName: { type: String, required: true, maxlength: 120 },
    lastUsedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'api_keys' },
);

/*
 * Authentication's only query, on every public API request. Unique, because two
 * keys hashing alike would be two organizations answering to one credential —
 * astronomically unlikely from random input, and the index makes it impossible
 * rather than unlikely.
 */
apiKeySchema.index({ tokenHash: 1 }, { unique: true, name: 'api_key_token_hash_unique' });

// The settings list, newest first.
apiKeySchema.index({ organizationId: 1, createdAt: -1 }, { name: 'api_key_org_created_at' });

export const ApiKeyModel: Model<ApiKeyAttributes> =
  (mongoose.models.ApiKey as Model<ApiKeyAttributes> | undefined) ??
  model<ApiKeyAttributes>('ApiKey', apiKeySchema);
