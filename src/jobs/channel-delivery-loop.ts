import { claimDeliveryBatch, type DeliveryQueueOptions } from '../queues/channel-delivery.queue.js';
import { createLogger } from '../utils/logger.js';
import {
  runChannelDelivery,
  type ChannelDeliveryJobDependencies,
  type ChannelDeliveryJobOptions,
} from './channel-delivery.job.js';

const logger = createLogger('channel-delivery-loop');

export interface ChannelDeliveryLoopOptions {
  readonly pollIntervalMs: number;
  readonly queue: DeliveryQueueOptions;
  readonly job: ChannelDeliveryJobOptions;
}

/**
 * Sends queued Slack, Discord and webhook messages.
 *
 * The fourth loop in the monitoring runtime, and separate from the other three
 * for the reason channels are queued at all: its work is waiting on somebody
 * else's server. A receiver that takes the whole timeout to answer must slow
 * down nothing but other channel messages.
 *
 * The poll interval is the worst-case delay before an alert leaves, so the
 * publisher also calls {@link wake} when it queues something — in the common
 * case a message goes out as soon as the check that caused it has finished,
 * and polling is only the backstop for retries and for another process's work.
 */
export class ChannelDeliveryLoop {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private inFlightTick: Promise<void> | null = null;
  private lastTickCompletedAt: number | null = null;

  constructor(
    private readonly options: ChannelDeliveryLoopOptions,
    private readonly dependencies: ChannelDeliveryJobDependencies,
  ) {}

  start(): void {
    this.scheduleNext(0);
  }

  /** Stops scheduling new ticks and waits for any in-progress one to finish. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlightTick;
  }

  /**
   * Brings the next tick forward to now, if the loop is idle.
   *
   * A tick already running will pick up new work on its next claim, and one
   * scheduled is simply rescheduled — so calling this in a burst costs nothing
   * and can never start two ticks at once.
   */
  wake(): void {
    if (this.stopping || this.inFlightTick || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.scheduleNext(0);
  }

  /** Runs one tick immediately. See `SchedulerLoop.tickNow` for why this exists. */
  async tickNow(): Promise<void> {
    if (this.stopping) return;

    const inFlight = this.inFlightTick;
    if (inFlight) {
      await inFlight;
      return;
    }

    this.inFlightTick = this.runTick()
      .then(() => undefined)
      .finally(() => {
        this.inFlightTick = null;
      });
    await this.inFlightTick;
  }

  lastTickAt(): number | null {
    return this.lastTickCompletedAt;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      let fullBatch = false;
      this.inFlightTick = this.runTick()
        .then((claimed) => {
          fullBatch = claimed >= this.options.queue.batchSize;
        })
        .finally(() => {
          this.inFlightTick = null;
          // A full batch means there is probably more waiting: go straight
          // back for it rather than leaving a backlog of alerts to the timer.
          this.scheduleNext(fullBatch ? 0 : this.options.pollIntervalMs);
        });
    }, delayMs);
    // A pending tick must never be the reason the process cannot exit.
    this.timer.unref();
  }

  /** Returns how many deliveries were claimed. */
  private async runTick(): Promise<number> {
    try {
      const claimed = await claimDeliveryBatch(this.options.queue);
      if (claimed.length > 0) {
        await Promise.all(
          claimed.map((delivery) =>
            runChannelDelivery(delivery, this.options.job, this.dependencies),
          ),
        );
      }
      return claimed.length;
    } catch (error) {
      // A failure to claim is not fatal; the next tick tries again.
      logger.error({ err: error }, 'channel_delivery.tick_failed');
      return 0;
    } finally {
      this.lastTickCompletedAt = Date.now();
    }
  }
}
