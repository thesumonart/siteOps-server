import type { Types } from 'mongoose';

import type {
  NotificationEvent,
  NotificationPreferences,
  PreferenceField,
} from '../contracts/index.js';
import { DEFAULT_NOTIFICATION_PREFERENCES, PREFERENCE_FIELDS } from '../contracts/index.js';
import {
  NotificationModel,
  NotificationSettingsModel,
  type NotificationAttributes,
} from '../models/index.js';

/**
 * Delivery records and the per-user rules that gate them.
 *
 * Two collections, one repository, because they are only ever used together:
 * the worker reads the rules to decide who to notify and writes a delivery
 * record for each recipient it accepts.
 */

export interface NotificationRecord extends NotificationAttributes {
  readonly _id: Types.ObjectId;
}

export type StoredPreferences = NotificationPreferences & {
  readonly userId: Types.ObjectId;
};

/**
 * Projection covering every preference field.
 *
 * Built from the contract's list rather than written out, so a new preference
 * cannot be added to the schema and silently left out of every read — which
 * would make it read as `undefined` and fall back to the default forever.
 */
const PREFERENCE_PROJECTION: Record<string, 1> = Object.fromEntries(
  PREFERENCE_FIELDS.map((field) => [field, 1]),
);

/** Picks the preference fields out of a stored document, filling any gaps. */
function toPreferences(stored: Partial<NotificationPreferences>): NotificationPreferences {
  const preferences: Record<string, boolean> = {};
  for (const field of PREFERENCE_FIELDS) {
    // A document written before this preference existed has no value for it,
    // and the default is the honest answer for "never asked".
    preferences[field] = stored[field] ?? DEFAULT_NOTIFICATION_PREFERENCES[field];
  }
  return preferences as unknown as NotificationPreferences;
}

/** MongoDB's duplicate-key error number. */
const DUPLICATE_KEY = 11000;

export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

export class NotificationRepository {
  /**
   * Creates a pending delivery record, or reports that one already exists.
   *
   * Returns null on a duplicate rather than throwing: the unique index on
   * `dedupeKey` is the deduplication guarantee, and hitting it means another
   * dispatch already claimed this recipient. That is the expected outcome of a
   * replayed job, not a fault.
   */
  async createPending(input: {
    readonly organizationId: Types.ObjectId;
    readonly userId: Types.ObjectId;
    readonly event: NotificationEvent;
    // Nullable because not every notification is about a website or an
    // incident: a scheduled report is about neither.
    readonly websiteId: Types.ObjectId | null;
    readonly incidentId: Types.ObjectId | null;
    readonly title: string;
    readonly body: string;
    readonly dedupeKey: string;
  }): Promise<NotificationRecord | null> {
    try {
      const created = await NotificationModel.create({
        organizationId: input.organizationId,
        userId: input.userId,
        event: input.event,
        channel: 'email',
        status: 'pending',
        websiteId: input.websiteId,
        incidentId: input.incidentId,
        title: input.title,
        body: input.body,
        dedupeKey: input.dedupeKey,
      });
      return created.toObject<NotificationRecord>();
    } catch (error) {
      if (isDuplicateKeyError(error)) return null;
      throw error;
    }
  }

  async markSent(notificationId: Types.ObjectId, attemptCount: number): Promise<void> {
    const now = new Date();
    await NotificationModel.updateOne(
      { _id: notificationId },
      { $set: { status: 'sent', sentAt: now, lastAttemptAt: now, attemptCount } },
    ).exec();
  }

  async markFailed(
    notificationId: Types.ObjectId,
    attemptCount: number,
    reason: string,
  ): Promise<void> {
    await NotificationModel.updateOne(
      { _id: notificationId },
      {
        $set: {
          status: 'failed',
          lastAttemptAt: new Date(),
          attemptCount,
          // Truncated: a provider message can be long and is not worth a large
          // document on a collection this size.
          failureReason: reason.slice(0, 500),
        },
      },
    ).exec();
  }

  /**
   * Stored preferences for a set of users in one organization.
   *
   * Absence is meaningful and is resolved by the caller, not here: a user with
   * no row has never been asked, and defaulting that to silence would mean an
   * outage nobody hears about.
   */
  async preferencesFor(
    organizationId: Types.ObjectId,
    userIds: readonly Types.ObjectId[],
  ): Promise<ReadonlyMap<string, StoredPreferences>> {
    if (userIds.length === 0) return new Map();

    const rows = await NotificationSettingsModel.find({
      organizationId,
      userId: { $in: userIds },
    })
      .select({ userId: 1, ...PREFERENCE_PROJECTION })
      .lean<(Partial<NotificationPreferences> & { userId: Types.ObjectId })[]>()
      .exec();

    return new Map(
      rows.map((row) => [
        row.userId.toHexString(),
        { userId: row.userId, ...toPreferences(row) } satisfies StoredPreferences,
      ]),
    );
  }

  async findPreferences(
    organizationId: Types.ObjectId,
    userId: Types.ObjectId,
  ): Promise<NotificationPreferences | null> {
    const stored = await NotificationSettingsModel.findOne({ organizationId, userId })
      .select(PREFERENCE_PROJECTION)
      .lean<Partial<NotificationPreferences>>()
      .exec();

    return stored ? toPreferences(stored) : null;
  }

  /**
   * Applies a partial change, creating the row on first write.
   *
   * A field may not appear in both `$set` and `$setOnInsert` — MongoDB rejects
   * the update outright — so the insert defaults cover only the fields this
   * request is not setting. That is also what stops turning one event off from
   * silently rewriting the other to whatever the browser last had in memory.
   */
  async upsertPreferences(
    organizationId: Types.ObjectId,
    userId: Types.ObjectId,
    changes: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    const defaults: Partial<Record<PreferenceField, boolean>> = {};
    for (const field of PREFERENCE_FIELDS) {
      if (changes[field] === undefined) defaults[field] = DEFAULT_NOTIFICATION_PREFERENCES[field];
    }

    const updated = await NotificationSettingsModel.findOneAndUpdate(
      { organizationId, userId },
      { $set: changes, $setOnInsert: defaults },
      { upsert: true, returnDocument: 'after' },
    )
      .select(PREFERENCE_PROJECTION)
      .lean<Partial<NotificationPreferences>>()
      .exec();

    return updated ? toPreferences(updated) : DEFAULT_NOTIFICATION_PREFERENCES;
  }
}
