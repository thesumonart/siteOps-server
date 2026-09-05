import type { Types } from 'mongoose';

import { WebsiteModel, type WebsiteAttributes } from '../models/index.js';

/**
 * The monitoring work queue.
 *
 * There is no Redis and no broker. The queue *is* the `websites` collection:
 * `nextCheckAt` is the ready time and `leaseExpiresAt` is the visibility
 * timeout, and both are manipulated by a single atomic `findOneAndUpdate`. That
 * buys the two properties a broker would have provided — at-most-one worker per
 * website, and recovery from a worker that dies mid-check — without a second
 * service to run, monitor and pay for.
 *
 * It also avoids a second source of truth. Incident and notification
 * idempotency are already enforced by unique partial indexes in MongoDB; a
 * broker's own delivery semantics would be a *different* guarantee layered on
 * top of those, and reconciling the two is where duplicate-alert bugs live.
 *
 * The cost is honest and worth stating: claiming is one round trip per website
 * rather than a batched pop, and the poll interval bounds how promptly a due
 * check starts. Neither matters at the scale this product runs at, and if it
 * ever does, this module is the only one that has to change.
 *
 * "Due" and "claimed" are the same atomic operation: `findOneAndUpdate` finds a
 * website whose `nextCheckAt` has passed and whose lease is free, and in the
 * same round trip sets a fresh lease. Two worker processes racing on the same
 * document can therefore never both win it — MongoDB serializes the update,
 * so the second `findOneAndUpdate` simply finds nothing left to claim.
 *
 * The lease *expires* rather than being held indefinitely, so a worker that
 * crashes mid-check does not strand a website. The next scheduler tick — on
 * this process or another — reclaims it once `leaseExpiresAt` has passed.
 */

export interface ClaimedWebsite {
  readonly id: Types.ObjectId;
  readonly organizationId: Types.ObjectId;
  readonly name: string;
  readonly url: string;
  readonly monitoringIntervalSeconds: number;
  readonly requestTimeoutMs: number;
  readonly failureThreshold: number;
  readonly recoveryThreshold: number;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
  readonly currentIncidentId: Types.ObjectId | null;
}

export interface MonitoringQueueOptions {
  /** Upper bound on websites claimed in one call to {@link claimBatch}. */
  readonly batchSize: number;
  /**
   * How long a claim is held before it is considered abandoned. Must comfortably
   * exceed the slowest realistic check (`requestTimeoutMs` × `MONITOR_MAX_ATTEMPTS`,
   * plus redirect hops), or a worker still legitimately checking a slow site
   * would have its own lease stolen out from under it.
   */
  readonly leaseDurationMs: number;
}

function toClaimedWebsite(doc: WebsiteAttributes & { _id: Types.ObjectId }): ClaimedWebsite {
  return {
    id: doc._id,
    organizationId: doc.organizationId,
    name: doc.name,
    url: doc.url,
    monitoringIntervalSeconds: doc.monitoringIntervalSeconds,
    requestTimeoutMs: doc.requestTimeoutMs,
    failureThreshold: doc.failureThreshold,
    recoveryThreshold: doc.recoveryThreshold,
    consecutiveFailures: doc.consecutiveFailures,
    consecutiveSuccesses: doc.consecutiveSuccesses,
    currentIncidentId: doc.currentIncidentId,
  };
}

/** Claims one due-and-unleased website, or null if there is nothing to do. */
async function claimOne(leaseDurationMs: number): Promise<ClaimedWebsite | null> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  const claimed = await WebsiteModel.findOneAndUpdate(
    {
      monitoringEnabled: true,
      nextCheckAt: { $lte: now },
      $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
    },
    { $set: { leaseExpiresAt } },
    {
      returnDocument: 'after',
      // Oldest-due first, so one perpetually-overdue site cannot starve the
      // rest of the queue behind it.
      sort: { nextCheckAt: 1 },
    },
  )
    .lean<WebsiteAttributes & { _id: Types.ObjectId }>()
    .exec();

  return claimed ? toClaimedWebsite(claimed) : null;
}

/**
 * Claims up to `batchSize` due websites in one scheduler tick.
 *
 * Claims happen sequentially — each is its own atomic `findOneAndUpdate` — so
 * the batch naturally shrinks to whatever is actually due; it never blocks
 * waiting for more work to appear.
 */
export async function claimBatch(
  options: MonitoringQueueOptions,
): Promise<readonly ClaimedWebsite[]> {
  const claimed: ClaimedWebsite[] = [];

  for (let i = 0; i < options.batchSize; i += 1) {
    const website = await claimOne(options.leaseDurationMs);
    if (!website) break;
    claimed.push(website);
  }

  return claimed;
}

/** Releases a lease and schedules the next check, whether or not this one succeeded. */
export async function releaseAndReschedule(
  websiteId: Types.ObjectId,
  intervalSeconds: number,
): Promise<void> {
  await WebsiteModel.updateOne(
    { _id: websiteId },
    {
      $set: {
        leaseExpiresAt: null,
        nextCheckAt: new Date(Date.now() + intervalSeconds * 1000),
      },
    },
  ).exec();
}
