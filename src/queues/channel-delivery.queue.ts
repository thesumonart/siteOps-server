import type { Types } from 'mongoose';

import type { ChannelEvent, ChannelEventPayload } from '../contracts/index.js';
import { ChannelDeliveryModel, type ChannelDeliveryAttributes } from '../models/index.js';

/**
 * The channel delivery queue.
 *
 * The fourth lease queue in the product and deliberately the same mechanism as
 * the other three: `nextAttemptAt` is the ready time, `leaseExpiresAt` the
 * visibility timeout, one atomic `findOneAndUpdate` claims a delivery. A worker
 * that dies mid-send strands nothing; the lease expires and the next tick, on
 * any process, takes it again.
 *
 * What differs is that a delivery is retried. The attempt is counted *at claim
 * time*, in the same update that takes the lease, so a delivery whose send
 * crashes the process still uses up an attempt — without that, one payload
 * that reliably crashed the sender would be claimed forever.
 *
 * At-least-once, not exactly-once. A receiver that accepted a request and then
 * failed to answer before the timeout will see it again. Every webhook carries
 * `X-SiteOps-Delivery`, stable across retries, so a receiver can drop the
 * repeat; that is the contract every serious webhook sender offers, because the
 * alternative — never retrying an ambiguous failure — loses alerts.
 */

export interface ClaimedDelivery {
  readonly id: Types.ObjectId;
  readonly organizationId: Types.ObjectId;
  readonly channelId: Types.ObjectId;
  readonly event: ChannelEvent;
  readonly payload: ChannelEventPayload;
  /** This attempt's number, counted at claim time. */
  readonly attemptCount: number;
}

export interface DeliveryQueueOptions {
  readonly batchSize: number;
  /** Must comfortably exceed one attempt's timeout, or a slow send is claimed twice. */
  readonly leaseDurationMs: number;
}

interface ClaimedRow extends ChannelDeliveryAttributes {
  readonly _id: Types.ObjectId;
}

async function claimOne(leaseDurationMs: number): Promise<ClaimedDelivery | null> {
  const now = new Date();

  const row = await ChannelDeliveryModel.findOneAndUpdate(
    {
      status: 'pending',
      nextAttemptAt: { $lte: now },
      $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
    },
    {
      $set: { leaseExpiresAt: new Date(now.getTime() + leaseDurationMs) },
      $inc: { attemptCount: 1 },
    },
    // Oldest-due first, so a backlog drains in the order it arrived.
    { returnDocument: 'after', sort: { nextAttemptAt: 1 } },
  )
    .lean<ClaimedRow>()
    .exec();

  if (!row) return null;

  return {
    id: row._id,
    organizationId: row.organizationId,
    channelId: row.channelId,
    event: row.event,
    payload: row.payload,
    attemptCount: row.attemptCount,
  };
}

/** Claims up to `batchSize` due deliveries; the batch shrinks to whatever is actually due. */
export async function claimDeliveryBatch(
  options: DeliveryQueueOptions,
): Promise<readonly ClaimedDelivery[]> {
  const claimed: ClaimedDelivery[] = [];

  for (let index = 0; index < options.batchSize; index += 1) {
    const delivery = await claimOne(options.leaseDurationMs);
    if (!delivery) break;
    claimed.push(delivery);
  }

  return claimed;
}

/*
 * The three ways an attempt can end. Each is conditioned on `status: 'pending'`,
 * so a delivery settled by one process cannot be reopened by another that held
 * an expired lease on it.
 */

export async function markDelivered(
  deliveryId: Types.ObjectId,
  outcome: { readonly at: Date; readonly statusCode: number | null },
): Promise<void> {
  await ChannelDeliveryModel.updateOne(
    { _id: deliveryId, status: 'pending' },
    {
      $set: {
        status: 'delivered',
        deliveredAt: outcome.at,
        lastAttemptAt: outcome.at,
        responseStatus: outcome.statusCode,
        failureReason: null,
        nextAttemptAt: null,
        leaseExpiresAt: null,
      },
    },
  ).exec();
}

export async function scheduleRetry(
  deliveryId: Types.ObjectId,
  outcome: {
    readonly at: Date;
    readonly nextAttemptAt: Date;
    readonly statusCode: number | null;
    readonly failureReason: string;
  },
): Promise<void> {
  await ChannelDeliveryModel.updateOne(
    { _id: deliveryId, status: 'pending' },
    {
      $set: {
        lastAttemptAt: outcome.at,
        nextAttemptAt: outcome.nextAttemptAt,
        responseStatus: outcome.statusCode,
        failureReason: outcome.failureReason.slice(0, 500),
        leaseExpiresAt: null,
      },
    },
  ).exec();
}

export async function markFailed(
  deliveryId: Types.ObjectId,
  outcome: {
    readonly at: Date;
    readonly statusCode: number | null;
    readonly failureReason: string;
  },
): Promise<void> {
  await ChannelDeliveryModel.updateOne(
    { _id: deliveryId, status: 'pending' },
    {
      $set: {
        status: 'failed',
        lastAttemptAt: outcome.at,
        responseStatus: outcome.statusCode,
        failureReason: outcome.failureReason.slice(0, 500),
        nextAttemptAt: null,
        leaseExpiresAt: null,
      },
    },
  ).exec();
}
