import { deliverToChannel, openChannel } from '../integrations/channel-delivery.js';
import {
  markDelivered,
  markFailed,
  scheduleRetry,
  type ClaimedDelivery,
} from '../queues/channel-delivery.queue.js';
import type { ChannelRepository } from '../repositories/channel.repository.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('channel-delivery');

export interface ChannelDeliveryJobOptions {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryBaseSeconds: number;
  /** Test-only: see AddressGuardOptions. Refused in production at startup. */
  readonly allowLoopback: boolean;
}

export interface ChannelDeliveryJobDependencies {
  readonly channels: ChannelRepository;
}

/**
 * The ceiling on any single wait between attempts.
 *
 * Applies to a receiver's own `Retry-After` too, so a hostile or mistaken value
 * cannot park a delivery until after anyone cares about the outage it describes.
 */
const MAX_RETRY_DELAY_SECONDS = 6 * 60 * 60;

/**
 * Seconds to wait before the next attempt, after attempt number `attempt`.
 *
 * Exponential, base four: with the default thirty seconds that is 30s, 2m, 8m,
 * 32m — a receiver mid-deploy is retried quickly, one that is down for the
 * evening is not hammered. A receiver that asked for longer with `Retry-After`
 * gets what it asked for, up to the ceiling; it knows its own rate limit.
 */
export function retryDelaySeconds(
  attempt: number,
  baseSeconds: number,
  retryAfterSeconds: number | null,
): number {
  const backoff = baseSeconds * 4 ** Math.max(0, attempt - 1);
  return Math.min(Math.max(backoff, retryAfterSeconds ?? 0), MAX_RETRY_DELAY_SECONDS);
}

/**
 * One attempt at one delivery, and the bookkeeping for how it went.
 *
 * Nothing here throws to the caller. A delivery that cannot be sent is recorded
 * as failed with a reason a person can act on — "the channel was deleted",
 * "HTTP 404: no_service" — rather than left for the lease to expire, so the
 * delivery log is always an honest account of what happened to an alert.
 */
export async function runChannelDelivery(
  delivery: ClaimedDelivery,
  options: ChannelDeliveryJobOptions,
  dependencies: ChannelDeliveryJobDependencies,
): Promise<void> {
  const context = {
    deliveryId: delivery.id.toHexString(),
    channelId: delivery.channelId.toHexString(),
    event: delivery.event,
    attempt: delivery.attemptCount,
  };

  try {
    const channel = await dependencies.channels.findByObjectId(
      delivery.organizationId,
      delivery.channelId,
    );

    // Neither of these is the channel failing, so neither touches its health.
    if (!channel) {
      await markFailed(delivery.id, {
        at: new Date(),
        statusCode: null,
        failureReason: 'The channel was deleted before this could be sent.',
      });
      return;
    }
    if (!channel.enabled) {
      await markFailed(delivery.id, {
        at: new Date(),
        statusCode: null,
        failureReason: 'The channel was turned off before this could be sent.',
      });
      return;
    }

    const deliverable = openChannel(channel);
    if (!deliverable) {
      const failureReason =
        "The channel's stored URL could not be read. Enter it again to resume delivery.";
      const at = new Date();
      await markFailed(delivery.id, { at, statusCode: null, failureReason });
      await dependencies.channels.recordOutcome(channel._id, {
        delivered: false,
        at,
        failureReason,
      });
      logger.error(context, 'channel.credentials_unreadable');
      return;
    }

    const outcome = await deliverToChannel(deliverable, delivery.payload, {
      deliveryId: context.deliveryId,
      timeoutMs: options.timeoutMs,
      allowLoopback: options.allowLoopback,
    });
    const at = new Date();

    if (outcome.delivered) {
      await markDelivered(delivery.id, { at, statusCode: outcome.statusCode });
      await dependencies.channels.recordOutcome(channel._id, {
        delivered: true,
        at,
        failureReason: null,
      });
      logger.info({ ...context, durationMs: outcome.durationMs }, 'channel.delivered');
      return;
    }

    const failureReason = outcome.failureReason ?? 'The delivery failed.';

    if (outcome.retryable && delivery.attemptCount < options.maxAttempts) {
      const delay = retryDelaySeconds(
        delivery.attemptCount,
        options.retryBaseSeconds,
        outcome.retryAfterSeconds,
      );
      await scheduleRetry(delivery.id, {
        at,
        nextAttemptAt: new Date(at.getTime() + delay * 1000),
        statusCode: outcome.statusCode,
        failureReason,
      });
      logger.warn(
        { ...context, statusCode: outcome.statusCode, retryInSeconds: delay },
        'channel.delivery_retrying',
      );
      return;
    }

    await markFailed(delivery.id, { at, statusCode: outcome.statusCode, failureReason });
    await dependencies.channels.recordOutcome(channel._id, { delivered: false, at, failureReason });
    logger.error(
      { ...context, statusCode: outcome.statusCode, reason: failureReason },
      'channel.delivery_failed',
    );
  } catch (error) {
    // A fault in this process — the database, most likely — not the receiver.
    // The attempt was counted at claim time, so the lease expiring is enough to
    // retry it, and a delivery that faults every time still runs out.
    logger.error({ ...context, err: error }, 'channel.delivery_job_failed');
  }
}
