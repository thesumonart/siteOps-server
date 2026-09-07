import { randomUUID } from 'node:crypto';

import { env } from '../config/env.js';
import { MAX_REQUEST_TIMEOUT_MS, type MonitorType } from '../contracts/index.js';
import { EmailService } from '../email/email.service.js';
import { WorkerHeartbeatModel } from '../models/index.js';
import type { MonitorRunner } from '../monitoring/monitor-runner.js';
import { createPageSpeedProvider } from '../monitoring/performance/pagespeed-provider.js';
import { createSyntheticProvider } from '../monitoring/performance/synthetic-provider.js';
import { createContentRunner } from '../monitoring/runners/content.runner.js';
import { createDomainRunner } from '../monitoring/runners/domain.runner.js';
import { createLinksRunner } from '../monitoring/runners/links.runner.js';
import { createPerformanceRunner } from '../monitoring/runners/performance.runner.js';
import { createSeoRunner } from '../monitoring/runners/seo.runner.js';
import { createSslRunner } from '../monitoring/runners/ssl.runner.js';
import { NotificationRepository } from '../repositories/notification.repository.js';
import { ReportRepository } from '../repositories/report.repository.js';
import { BrandingService } from '../services/branding.service.js';
import { createLogger } from '../utils/logger.js';
import { createEmailMonitorNotifier } from './monitor-notifier.js';
import { MonitorSchedulerLoop } from './monitor-scheduler-loop.js';
import { ReportSchedulerLoop } from './report-scheduler-loop.js';
import { SchedulerLoop } from './scheduler-loop.js';

const log = createLogger('monitoring-runtime');

/**
 * Everything that actually performs monitoring, in one startable unit.
 *
 * This used to be assembled inline in `worker.ts`, which was fine while a
 * dedicated background process was the only way to run it. It is not the only
 * way any more: several hosting plans offer exactly one long-running service,
 * and on those the choice is between running the loops inside the API process
 * and not running them at all. The second is what SiteOps was doing in
 * production — the API was healthy, nothing had crashed, and no website had
 * been checked for eighteen hours.
 *
 * So the composition moved here, and both entry points construct one of these.
 * `worker.ts` always does; `server.ts` does when `MONITORING_RUNTIME=inline`.
 * The loops, the queues, the leases and the jobs are identical either way —
 * the only difference is which process owns the event loop they run on.
 *
 * @see docs/DEPLOYMENT.md for which mode a given platform needs.
 */

/**
 * A lease must comfortably outlast the slowest realistic single check, or a
 * worker still legitimately checking a slow site would have its own lease
 * stolen out from under it. Every attempt within one check can take up to the
 * *maximum any website is allowed to configure* (`MAX_REQUEST_TIMEOUT_MS`, not
 * just a default) times every redirect hop; the 30s on top covers the database
 * writes and email dispatch that follow.
 */
const LEASE_DURATION_MS =
  MAX_REQUEST_TIMEOUT_MS * (env.MONITOR_MAX_REDIRECTS + 1) * env.MONITOR_MAX_ATTEMPTS + 30_000;

/**
 * How long a report generation or schedule claim is held.
 *
 * Must outlast the slowest realistic report — a year of checks across two
 * hundred websites — or a second worker would reclaim one still being built and
 * generate it twice.
 */
const REPORT_LEASE_DURATION_MS = 10 * 60 * 1000;

/** Identifies our requests in a monitored site's own access log. */
export const MONITOR_USER_AGENT = 'SiteOpsMonitor/1.0 (+https://siteops.app)';

/**
 * How often the heartbeat is written while nothing is due.
 *
 * Independent of the poll interval: the point is to distinguish "running with
 * nothing to do" from "not running", and a loop that finds an empty queue for
 * an hour must still be visibly alive throughout.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

export type MonitoringRuntimeHost = 'api' | 'worker';

export interface MonitoringRuntimeSnapshot {
  readonly instanceId: string;
  readonly host: MonitoringRuntimeHost;
  readonly startedAt: string;
  readonly lastUptimeTickAt: string | null;
  readonly lastMonitorTickAt: string | null;
  readonly lastReportTickAt: string | null;
}

/**
 * Every auxiliary monitor the runtime can run.
 *
 * A type with no entry is simply never run — the job logs it and moves on — so
 * a monitor can be shipped as a contract and a UI before its runner exists
 * without the worker crashing on it.
 *
 * Performance is given both providers in order. PageSpeed runs real Lighthouse
 * on Google's infrastructure and is preferred when a key is configured; the
 * synthetic provider measures what a server-side fetch honestly can and always
 * works. A configured PageSpeed that fails falls through rather than failing
 * the run, so a Google outage degrades the monitor instead of silencing it.
 */
function buildRunners(): ReadonlyMap<MonitorType, MonitorRunner> {
  const runners: MonitorRunner[] = [
    createSslRunner(),
    createDomainRunner(),
    createPerformanceRunner({
      providers: [
        createPageSpeedProvider({ apiKey: env.PAGESPEED_API_KEY }),
        createSyntheticProvider(),
      ],
    }),
    createContentRunner(),
    createSeoRunner(),
    createLinksRunner(),
  ];
  return new Map(runners.map((runner) => [runner.type, runner]));
}

export class MonitoringRuntime {
  private readonly instanceId = randomUUID();
  private readonly startedAt = new Date();
  private readonly uptimeLoop: SchedulerLoop;
  private readonly monitorLoop: MonitorSchedulerLoop;
  private readonly reportLoop: ReportSchedulerLoop;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private started = false;
  private stopping = false;

  /** Whether outage alerts can actually be delivered. Logged at startup. */
  readonly emailConfigured: boolean;

  constructor(private readonly host: MonitoringRuntimeHost) {
    const emailService = new EmailService();
    const notifications = new NotificationRepository();

    this.uptimeLoop = new SchedulerLoop(
      {
        pollIntervalMs: env.MONITOR_POLL_INTERVAL_SECONDS * 1000,
        queue: {
          batchSize: env.MONITOR_CONCURRENCY,
          leaseDurationMs: LEASE_DURATION_MS,
        },
        job: {
          maxRedirects: env.MONITOR_MAX_REDIRECTS,
          maxAttempts: env.MONITOR_MAX_ATTEMPTS,
          allowLoopback: env.MONITOR_ALLOW_PRIVATE_ADDRESSES,
          userAgent: MONITOR_USER_AGENT,
        },
      },
      { emailService, notifications },
    );

    /*
     * The auxiliary monitors get their own loop rather than sharing the uptime
     * one. Their cadence is hours where uptime's is minutes, their runs cost
     * orders of magnitude more, and a five-minute crawl must never be able to
     * delay a one-minute uptime check.
     */
    this.monitorLoop = new MonitorSchedulerLoop(
      {
        pollIntervalMs: env.MONITOR_POLL_INTERVAL_SECONDS * 1000,
        job: {
          allowLoopback: env.MONITOR_ALLOW_PRIVATE_ADDRESSES,
          userAgent: MONITOR_USER_AGENT,
        },
      },
      {
        runners: buildRunners(),
        notifier: createEmailMonitorNotifier(emailService, notifications),
      },
    );

    /*
     * Reports get a third loop rather than sharing either of the others. Their
     * work is a burst of aggregation against the database with no outbound
     * network at all, so it competes for different resources — and a monthly
     * batch for fifty clients must never delay a one-minute uptime check.
     */
    this.reportLoop = new ReportSchedulerLoop(
      {
        pollIntervalMs: env.REPORT_POLL_INTERVAL_SECONDS * 1000,
        generationBatchSize: env.REPORT_BATCH_SIZE,
        // Firing several schedules at once means several bursts of email; kept
        // low so a large monthly batch spreads across ticks instead of arriving
        // as one spike the provider may rate-limit.
        scheduleBatchSize: 3,
        leaseDurationMs: REPORT_LEASE_DURATION_MS,
      },
      {
        reports: new ReportRepository(),
        branding: new BrandingService(),
        emailService,
      },
    );

    this.emailConfigured = emailService.isConfigured;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.uptimeLoop.start();
    this.monitorLoop.start();
    this.reportLoop.start();

    this.heartbeatTimer = setInterval(() => {
      void this.writeHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    // The heartbeat must never be the reason the process cannot exit.
    this.heartbeatTimer.unref();

    // Written immediately rather than only after the first interval, so a
    // restart is visible in diagnostics within a second rather than within
    // half a minute.
    void this.writeHeartbeat();

    log.info(
      {
        instanceId: this.instanceId,
        host: this.host,
        pollIntervalSeconds: env.MONITOR_POLL_INTERVAL_SECONDS,
        concurrency: env.MONITOR_CONCURRENCY,
        leaseDurationMs: LEASE_DURATION_MS,
        emailConfigured: this.emailConfigured,
      },
      'monitoring_runtime.started',
    );
  }

  /**
   * Stops scheduling new work and waits for anything in flight to finish.
   *
   * Each loop is stopped independently: a loop that throws on the way down must
   * not prevent the others from draining, because an undrained loop is a check
   * killed mid-flight rather than a check completed.
   */
  async stop(): Promise<void> {
    this.stopping = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    const results = await Promise.allSettled([
      this.uptimeLoop.stop(),
      this.monitorLoop.stop(),
      this.reportLoop.stop(),
    ]);

    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      throw failure.reason instanceof Error
        ? failure.reason
        : new Error('A monitoring loop failed to stop.');
    }
  }

  /**
   * Runs every loop once, now.
   *
   * The entry point for an external scheduler. It exists because a platform
   * that suspends an idle instance never runs the in-process timers: the
   * request that wakes the process is the only thing that can make work happen,
   * and it has to do so before returning.
   *
   * Loops run concurrently here, unlike within a tick, because these are three
   * independent queues and the caller is waiting on the slowest of them.
   * Failures are collected rather than propagated: a report queue that cannot
   * be drained must not stop the uptime sweep from being reported as done.
   */
  async runOnce(): Promise<{
    readonly ran: readonly string[];
    readonly failed: readonly { readonly loop: string; readonly reason: string }[];
  }> {
    if (this.stopping) return { ran: [], failed: [] };

    const loops: readonly (readonly [string, () => Promise<void>])[] = [
      ['uptime', () => this.uptimeLoop.tickNow()],
      ['monitors', () => this.monitorLoop.tickNow()],
      ['reports', () => this.reportLoop.tickNow()],
    ];

    const outcomes = await Promise.allSettled(loops.map(([, tick]) => tick()));

    const ran: string[] = [];
    const failed: { loop: string; reason: string }[] = [];

    outcomes.forEach((outcome, index) => {
      const name = loops[index]?.[0] ?? 'unknown';
      if (outcome.status === 'fulfilled') {
        ran.push(name);
        return;
      }
      const reason = outcome.reason instanceof Error ? outcome.reason.message : 'The tick failed.';
      failed.push({ loop: name, reason });
      log.error({ err: outcome.reason, loop: name }, 'monitoring_runtime.tick_failed');
    });

    await this.writeHeartbeat(failed.length);

    return { ran, failed };
  }

  snapshot(): MonitoringRuntimeSnapshot {
    return {
      instanceId: this.instanceId,
      host: this.host,
      startedAt: this.startedAt.toISOString(),
      lastUptimeTickAt: toIso(this.uptimeLoop.lastTickAt()),
      lastMonitorTickAt: toIso(this.monitorLoop.lastTickAt()),
      lastReportTickAt: toIso(this.reportLoop.lastTickAt()),
    };
  }

  /**
   * Records that this instance is alive and what it last completed.
   *
   * Never throws. A heartbeat is diagnostics, and a diagnostics write that
   * could take the monitoring loop down with it would be strictly worse than
   * no diagnostics at all.
   */
  private async writeHeartbeat(tickFailures = 0): Promise<void> {
    try {
      await WorkerHeartbeatModel.updateOne(
        { instanceId: this.instanceId },
        {
          $set: {
            host: this.host,
            startedAt: this.startedAt,
            lastHeartbeatAt: new Date(),
            lastUptimeTickAt: toDate(this.uptimeLoop.lastTickAt()),
            lastMonitorTickAt: toDate(this.monitorLoop.lastTickAt()),
            lastReportTickAt: toDate(this.reportLoop.lastTickAt()),
          },
          $inc: { tickFailures },
          $setOnInsert: { instanceId: this.instanceId, websitesChecked: 0 },
        },
        { upsert: true },
      ).exec();
    } catch (error) {
      log.warn({ err: error }, 'monitoring_runtime.heartbeat_failed');
    }
  }
}

function toDate(epochMs: number | null): Date | null {
  return epochMs === null ? null : new Date(epochMs);
}

function toIso(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}
