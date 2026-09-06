import { MongoServerError } from 'mongodb';

import { BillingEventModel } from '../models/index.js';

/** Duplicate key. The one driver error code this repository treats as a result. */
const DUPLICATE_KEY = 11_000;

/**
 * Records which provider events have been applied.
 *
 * The only interesting method is {@link claim}, and its contract is narrow on
 * purpose: it answers "am I the one who gets to process this event?" and
 * nothing else.
 */
export class BillingEventRepository {
  /**
   * Claims an event id for processing.
   *
   * Returns `true` for the first caller and `false` for every retry of the same
   * event. The decision is the unique index on `eventId`: the insert either
   * succeeds or raises a duplicate key, and there is no window between the two
   * for a concurrent delivery to slip through — which a `findOne` followed by
   * an `insert` would have.
   *
   * Any other driver error is rethrown. Swallowing it would silently answer
   * "not a duplicate" for a database that is actually down, and the event would
   * be applied twice once it recovers.
   */
  async claim(eventId: string, type: string): Promise<boolean> {
    try {
      await BillingEventModel.create({ eventId, type, receivedAt: new Date() });
      return true;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) return false;
      throw error;
    }
  }

  /**
   * Releases a claim.
   *
   * Called when processing threw *after* the claim was taken. Without this the
   * provider's retry would be treated as a duplicate and dropped, so a
   * transient database failure would become a permanently missed subscription
   * change — the one outcome idempotency must not cause.
   */
  async release(eventId: string): Promise<void> {
    await BillingEventModel.deleteOne({ eventId }).exec();
  }
}
