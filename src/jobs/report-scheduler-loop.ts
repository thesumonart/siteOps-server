import { createLogger } from '../utils/logger.js';
import {
  runReportGeneration,
  runScheduledReport,
  type ReportJobDependencies,
} from './report.job.js';

const logger = createLogger('report-scheduler');

/**
 * Builds queued reports and fires due schedules.
 *
 * The third loop in the worker, alongside uptime and the auxiliary monitors.
 * Separate because its work is neither: a report is a burst of aggregation
 * against the database with no outbound network at all, so it competes for
 * different resources and deserves its own concurrency.
 *
 * Both queues are drained on every tick, generation first. A schedule creates a
 * report and builds it inline, so running generation first means a report a
 * person asked for is not stuck behind a monthly batch for fifty clients.
 */
export interface ReportSchedulerOptions {
  readonly pollIntervalMs: number;
  /** Reports built per tick. Each is a set of aggregations, not a network call. */
  readonly generationBatchSize: number;
  /** Schedules fired per tick. Each sends email, so this stays small. */
  readonly scheduleBatchSize: number;
  /**
   * How long a claim is held. Must outlast the slowest realistic report — a
   * year of checks across two hundred websites — or a second worker would
   * reclaim one still being built and generate it twice.
   */
  readonly leaseDurationMs: number;
}

export class ReportSchedulerLoop {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private inFlightTick: Promise<void> | null = null;
  private lastTickCompletedAt: number | null = null;

  constructor(
    private readonly options: ReportSchedulerOptions,
    private readonly dependencies: ReportJobDependencies,
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
    // A pending tick must never be the reason the process cannot exit.
    this.timer.unref();
  }

  private async runTick(): Promise<void> {
    try {
      await this.drainGeneration();
      await this.drainSchedules();
    } catch (error) {
      // A failure in one tick is not fatal; the next tries again.
      logger.error({ err: error }, 'report_scheduler.tick_failed');
    } finally {
      this.lastTickCompletedAt = Date.now();
    }
  }

  /**
   * Builds queued reports, one at a time.
   *
   * Sequential rather than concurrent: each report is a burst of aggregation
   * over the two largest collections in the product, and running several at
   * once would put the database under load that also slows the monitoring
   * writes happening in the same process.
   */
  private async drainGeneration(): Promise<void> {
    for (let built = 0; built < this.options.generationBatchSize; built += 1) {
      if (this.stopping) return;

      const report = await this.dependencies.reports.claimPending(this.options.leaseDurationMs);
      if (!report) return;

      await runReportGeneration(
        {
          _id: report._id,
          organizationId: report.organizationId,
          websiteIds: report.websiteIds,
          periodStart: report.periodStart,
          periodEnd: report.periodEnd,
          attemptCount: report.attemptCount,
          scheduleId: report.scheduleId,
        },
        this.dependencies,
      );
    }
  }

  private async drainSchedules(): Promise<void> {
    for (let fired = 0; fired < this.options.scheduleBatchSize; fired += 1) {
      if (this.stopping) return;

      const schedule = await this.dependencies.reports.claimDueSchedule(
        this.options.leaseDurationMs,
      );
      if (!schedule) return;

      logger.info(
        { scheduleId: schedule._id.toHexString(), name: schedule.name },
        'report_scheduler.schedule_claimed',
      );

      await runScheduledReport(schedule, this.dependencies);
    }
  }
}
