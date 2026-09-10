import type { Types } from 'mongoose';

import type { ApiKeyScope } from '../contracts/index.js';
import { ApiKeyModel, ApiUsageModel, type ApiKeyAttributes } from '../models/index.js';
import { toObjectId } from '../utils/object-id.js';
import { isDuplicateKeyError } from './notification.repository.js';

export interface ApiKeyRecord extends ApiKeyAttributes {
  readonly _id: Types.ObjectId;
}

/**
 * How many keys the settings list shows.
 *
 * Revoked keys are kept for the audit trail, so the collection grows past the
 * plan's active-key limit over time. The list is bounded here rather than
 * paginated: nobody pages through years of revoked keys, and the newest are
 * the ones that matter.
 */
const MAX_LISTED_KEYS = 100;

/**
 * `lastUsedAt` is refreshed at most this often per key.
 *
 * Writing it on every request would turn every read of the public API into a
 * write. A minute's resolution answers the question the field exists for —
 * "is anything still using this key before I revoke it" — at a sixtieth of
 * the cost.
 */
const LAST_USED_RESOLUTION_MS = 60_000;

/** The organization's live keys: not revoked, and not past their expiry. */
function activeFilter(now: Date): Record<string, unknown> {
  return { revokedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
}

/** `YYYY-MM-DD` and midnight, both UTC, for the day `now` falls in. */
function utcDay(now: Date): { readonly day: string; readonly dayStart: Date } {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { day: dayStart.toISOString().slice(0, 10), dayStart };
}

/**
 * API keys and the daily request count they share.
 *
 * Every method an API route can reach takes the organization id. The one that
 * does not — `findActiveByTokenHash` — is authentication itself: a request
 * arrives with nothing but a key, and the key is what names the organization.
 */
export class ApiKeyRepository {
  async list(organizationId: Types.ObjectId): Promise<readonly ApiKeyRecord[]> {
    return ApiKeyModel.find({ organizationId })
      .sort({ createdAt: -1 })
      .limit(MAX_LISTED_KEYS)
      .select({ tokenHash: 0 })
      .lean<ApiKeyRecord[]>()
      .exec();
  }

  async findById(organizationId: Types.ObjectId, keyId: string): Promise<ApiKeyRecord | null> {
    const keyObjectId = toObjectId(keyId);
    if (!keyObjectId) return null;

    return ApiKeyModel.findOne({ _id: keyObjectId, organizationId })
      .select({ tokenHash: 0 })
      .lean<ApiKeyRecord>()
      .exec();
  }

  async create(input: {
    readonly organizationId: Types.ObjectId;
    readonly name: string;
    readonly prefix: string;
    readonly tokenHash: string;
    readonly scopes: readonly ApiKeyScope[];
    readonly createdByUserId: Types.ObjectId;
    readonly createdByName: string;
    readonly expiresAt: Date | null;
  }): Promise<ApiKeyRecord> {
    const created = await ApiKeyModel.create({ ...input, scopes: [...input.scopes] });
    return created.toObject<ApiKeyRecord>();
  }

  /** The live key a token hashes to, or null. Authentication's one read. */
  async findActiveByTokenHash(tokenHash: string, now: Date): Promise<ApiKeyRecord | null> {
    return ApiKeyModel.findOne({ tokenHash, ...activeFilter(now) })
      .lean<ApiKeyRecord>()
      .exec();
  }

  /**
   * Revokes a key, once.
   *
   * Conditioned on `revokedAt: null`, so revoking twice is a not-found rather
   * than a second audit entry for a key that stopped working the first time.
   */
  async revoke(
    organizationId: Types.ObjectId,
    keyId: Types.ObjectId,
    at: Date,
  ): Promise<ApiKeyRecord | null> {
    return ApiKeyModel.findOneAndUpdate(
      { _id: keyId, organizationId, revokedAt: null },
      { $set: { revokedAt: at } },
      { returnDocument: 'after' },
    )
      .select({ tokenHash: 0 })
      .lean<ApiKeyRecord>()
      .exec();
  }

  /**
   * Replaces a live key's secret. The old one stops working in the same write.
   *
   * Refused for a revoked or expired key: rotating is how a leaked key is
   * replaced without reconfiguring its scopes, not a way to bring a dead one
   * back.
   */
  async rotate(
    organizationId: Types.ObjectId,
    keyId: Types.ObjectId,
    replacement: { readonly tokenHash: string; readonly prefix: string },
    now: Date,
  ): Promise<ApiKeyRecord | null> {
    return ApiKeyModel.findOneAndUpdate(
      { _id: keyId, organizationId, ...activeFilter(now) },
      { $set: { tokenHash: replacement.tokenHash, prefix: replacement.prefix, lastUsedAt: null } },
      { returnDocument: 'after' },
    )
      .select({ tokenHash: 0 })
      .lean<ApiKeyRecord>()
      .exec();
  }

  /** Live keys, for the plan's `maxApiKeys`. Revoked and expired ones do not occupy a slot. */
  async countActive(organizationId: Types.ObjectId, now: Date = new Date()): Promise<number> {
    return ApiKeyModel.countDocuments({ organizationId, ...activeFilter(now) }).exec();
  }

  /** Records that a key was used, at most once per `LAST_USED_RESOLUTION_MS`. */
  async touch(keyId: Types.ObjectId, now: Date): Promise<void> {
    await ApiKeyModel.updateOne(
      {
        _id: keyId,
        $or: [
          { lastUsedAt: null },
          { lastUsedAt: { $lt: new Date(now.getTime() - LAST_USED_RESOLUTION_MS) } },
        ],
      },
      { $set: { lastUsedAt: now } },
    ).exec();
  }

  /**
   * Counts one request against today's quota and returns the new total.
   *
   * One atomic upsert. The filter is exactly the unique index, so two
   * processes making the day's first request land on one document; the retry
   * covers the rare server that reports the collision instead of resolving it.
   */
  async recordRequest(organizationId: Types.ObjectId, now: Date): Promise<number> {
    const { day, dayStart } = utcDay(now);

    const increment = async (): Promise<number> => {
      const row = await ApiUsageModel.findOneAndUpdate(
        { organizationId, day },
        { $inc: { requests: 1 }, $setOnInsert: { dayStart } },
        { upsert: true, returnDocument: 'after' },
      )
        .lean<{ requests: number }>()
        .exec();
      return row?.requests ?? 1;
    };

    try {
      return await increment();
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      return increment();
    }
  }

  async requestsToday(organizationId: Types.ObjectId, now: Date = new Date()): Promise<number> {
    const row = await ApiUsageModel.findOne({ organizationId, day: utcDay(now).day })
      .select({ requests: 1 })
      .lean<{ requests: number }>()
      .exec();
    return row?.requests ?? 0;
  }
}
