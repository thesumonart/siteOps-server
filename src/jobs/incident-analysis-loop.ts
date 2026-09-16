import {
  claimAnalysisBatch,
  type AnalysisQueueOptions,
} from '../queues/incident-analysis.queue.js';
import { createLogger } from '../utils/logger.js';
import {
  runIncidentAnalysis,
  type IncidentAnalysisJobDependencies,
  type IncidentAnalysisJobOptions,
} from './incident-analysis.job.js';

const logger = createLogger('incident-analysis-loop');

export interface IncidentAnalysisLoopOptions {
  readonly pollIntervalMs: number;
  readonly queue: AnalysisQueueOptions;
  readonly job: IncidentAnalysisJobOptions;
}

/**
 * Writes queued incident analyses.
 *
 * A loop of its own, and only on a deployment with a model configured. A
 * generation takes tens of seconds on somebody else's servers; sharing a loop
 * with channel deliveries would let a slow model delay an outage alert, and
 * sharing one with checks would let it delay the check that confirms the next
 * outage.
 *
 * No `wake`: an analysis is due minutes after an incident resolves, so the
 * poll interval is not the delay anybody experiences.
 */
export class IncidentAnalysisLoop {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private inFlightTick: Promise<void> | null = null;
  private lastTickCompletedAt: number | null = null;

  constructor(
    private readonly options: IncidentAnalysisLoopOptions,
    private readonly dependencies: IncidentAnalysisJobDependencies,
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
          this.scheduleNext(fullBatch ? 0 : this.options.pollIntervalMs);
        });
    }, delayMs);
    // A pending tick must never be the reason the process cannot exit.
    this.timer.unref();
  }

  /** Returns how many analyses were claimed. */
  private async runTick(): Promise<number> {
    try {
      const claimed = await claimAnalysisBatch(this.options.queue);
      if (claimed.length > 0) {
        await Promise.all(
          claimed.map((analysis) =>
            runIncidentAnalysis(analysis, this.options.job, this.dependencies),
          ),
        );
      }
      return claimed.length;
    } catch (error) {
      // A failure to claim is not fatal; the next tick tries again.
      logger.error({ err: error }, 'incident_analysis.tick_failed');
      return 0;
    } finally {
      this.lastTickCompletedAt = Date.now();
    }
  }
}
