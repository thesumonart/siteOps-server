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

  /**
   * Runs one tick immediately, without waiting for the poll interval.
   *
   * Exists for the external trigger: a platform that suspends an idle instance
   * never runs the timer at all, so the request that wakes the process has to
   * be able to say "do the work now" rather than return and let it fall asleep
   * again before the next scheduled tick.
   *
   * Concurrency-safe by construction rather than by locking. If a tick is
   * already running, this awaits that one instead of starting a second; and
   * even if two did overlap, every claim is an atomic lease, so the second
   * would simply find nothing left to take.
   */
  async tickNow(): Promise<void> {
    if (this.stopping) return;

    const inFlight = this.inFlightTick;
    if (inFlight) {
      await inFlight;
      return;
    }

    this.inFlightTick = this.runTick().finally(() => {
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
