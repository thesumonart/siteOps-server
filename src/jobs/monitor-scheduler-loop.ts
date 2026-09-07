import type { MonitorType } from '../contracts/index.js';
import { MONITOR_TYPES } from '../contracts/index.js';
import { claimMonitorBatch } from '../queues/monitor.queue.js';
import { createLogger } from '../utils/logger.js';
import {
  runMonitorJob,
  type MonitorJobDependencies,
  type MonitorJobOptions,
} from './monitor.job.js';

const logger = createLogger('monitor-scheduler');

/**
 * Per-type run limits.
 *
 * These are not tuning knobs so much as statements about cost. A TLS handshake
 * is two round trips and finishes in well under a second; a link crawl fetches
 * up to five hundred pages from a customer's origin and can take minutes. Giving
 * them one shared budget would mean either throttling certificate checks to a
 * crawl's pace or letting crawls run unbounded, and both are wrong.
 *
 * The timeout is the whole run, not one request — a crawler manages its own
 * per-request deadlines within it.
 */
export interface MonitorTypeBudget {
  readonly concurrency: number;
  readonly timeoutMs: number;
}

export const MONITOR_BUDGETS: Record<MonitorType, MonitorTypeBudget> = {
  ssl: { concurrency: 10, timeoutMs: 15_000 },
  // Registries rate-limit aggressively and a WHOIS referral is two sequential
  // TCP round trips, so this stays deliberately low.
  domain: { concurrency: 3, timeoutMs: 20_000 },
  performance: { concurrency: 2, timeoutMs: 90_000 },
  content: { concurrency: 5, timeoutMs: 30_000 },
  seo: { concurrency: 4, timeoutMs: 45_000 },
  links: { concurrency: 1, timeoutMs: 300_000 },
};

export interface MonitorSchedulerOptions {
  readonly pollIntervalMs: number;
  readonly job: Omit<MonitorJobOptions, 'timeoutMs'>;
  /** Multiplies every budget's concurrency, for a deployment with headroom. */
  readonly concurrencyFactor?: number;
}

/**
 * Claims due auxiliary monitors and runs them, one type at a time.
 *
 * A recursive `setTimeout` rather than `setInterval`, for the same reason as
 * the uptime loop: the next tick is scheduled only once the current one has
 * fully finished, so a tick that runs long cannot overlap with the next and
 * issue a second claim while the first is still in flight.
 *
 * Within a tick the types are processed **sequentially**, and that is the
 * important decision. Running them concurrently would let a batch of crawls and
 * a batch of Lighthouse runs start together and put the worker's memory and
 * outbound bandwidth well past what either budget allowed on its own. Within
 * one type, the batch runs concurrently up to that type's limit.
 *
 * The cost is that a full tick takes as long as the slowest type. That is
 * acceptable because these monitors run hourly at the fastest — a tick that
 * takes two minutes is invisible against a daily certificate check, and the
 * lease means nothing is lost if the process dies mid-tick.
 */
export class MonitorSchedulerLoop {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private inFlightTick: Promise<void> | null = null;
  private lastTickCompletedAt: number | null = null;

  constructor(
    private readonly options: MonitorSchedulerOptions,
    private readonly dependencies: MonitorJobDependencies,
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
    // A pending tick must never be the reason the process cannot exit;
    // `stop()` always clears the timer explicitly first.
    this.timer.unref();
  }

  private async runTick(): Promise<void> {
    try {
      for (const type of MONITOR_TYPES) {
        // A stop requested mid-tick takes effect at the next type boundary
        // rather than only at the end of the whole sweep.
        if (this.stopping) break;
        await this.runType(type);
      }
    } finally {
      this.lastTickCompletedAt = Date.now();
    }
  }

  private async runType(type: MonitorType): Promise<void> {
    const budget = MONITOR_BUDGETS[type];
    const factor = this.options.concurrencyFactor ?? 1;
    const batchSize = Math.max(1, Math.round(budget.concurrency * factor));

    try {
      const claimed = await claimMonitorBatch({
        type,
        batchSize,
        // The lease must outlast the slowest run of this type, or a worker
        // still legitimately crawling would have its own lease stolen. Doubled
        // and padded, since the timeout bounds the run but not the database
        // writes and email dispatch that follow it.
        leaseDurationMs: budget.timeoutMs * 2 + 60_000,
      });

      if (claimed.length === 0) return;

      logger.info({ monitorType: type, count: claimed.length }, 'monitor_scheduler.tick_claimed');

      await Promise.all(
        claimed.map((monitor) =>
          runMonitorJob(
            monitor,
            { ...this.options.job, timeoutMs: budget.timeoutMs },
            this.dependencies,
          ),
        ),
      );
    } catch (error) {
      // A failure claiming one type must not abandon the others; the next tick
      // tries again on its own schedule.
      logger.error({ err: error, monitorType: type }, 'monitor_scheduler.type_failed');
    }
  }
}
