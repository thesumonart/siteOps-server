import { claimBatch, type MonitoringQueueOptions } from '../queues/monitoring.queue.js';
import { createLogger } from '../utils/logger.js';
import {
  runMonitoringJob,
  type MonitoringJobDependencies,
  type MonitoringJobOptions,
} from './monitoring.job.js';

const logger = createLogger('scheduler-loop');

export interface SchedulerLoopOptions {
  readonly pollIntervalMs: number;
  readonly queue: MonitoringQueueOptions;
  readonly job: MonitoringJobOptions;
}

/**
 * Repeatedly claims due websites and checks them, on a fixed poll interval.
 *
 * A recursive `setTimeout` rather than `setInterval`: the next tick is only
 * scheduled once the current one has fully finished, so a tick that runs long
 * (many slow sites at once) cannot overlap with the next and issue a second,
 * mostly-empty claim while the first is still in flight. Every website within
 * one tick is checked concurrently — the queue's own `batchSize` is the
 * concurrency bound, so no separate limiter is needed here.
 */
export class SchedulerLoop {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private inFlightTick: Promise<void> | null = null;
  private lastTickCompletedAt: number | null = null;

  constructor(
    private readonly options: SchedulerLoopOptions,
    private readonly dependencies: MonitoringJobDependencies,
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

  lastTickAt(): number | null {
    return this.lastTickCompletedAt;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.inFlightTick = this.runTick().finally(() => {
        this.inFlightTick = null;
        this.scheduleNext(this.options.pollIntervalMs);
      });
    }, delayMs);
    // A pending tick must never be the reason the process cannot exit —
    // `stop()` always clears the timer explicitly first.
    this.timer.unref();
  }

  private async runTick(): Promise<void> {
    try {
      const claimed = await claimBatch(this.options.queue);

      if (claimed.length > 0) {
        logger.info({ count: claimed.length }, 'scheduler.tick_claimed');
        await Promise.all(
          claimed.map((website) => runMonitoringJob(website, this.options.job, this.dependencies)),
        );
      }
    } catch (error) {
      // A failure to claim work is not fatal to the process — the next tick
      // tries again on its own schedule.
      logger.error({ err: error }, 'scheduler.tick_failed');
    } finally {
      this.lastTickCompletedAt = Date.now();
    }
  }
}
