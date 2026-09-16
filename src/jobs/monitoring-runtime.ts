import { randomUUID } from 'node:crypto';

import { languageModelFrom } from '../ai/language-model-factory.js';
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
import type { AnomalySettings } from '../monitoring/anomaly-detection.js';
import { ChannelEventPublisher } from '../monitoring/channel-dispatch.js';
import { PlanLookup } from '../monitoring/plan-lookup.js';
import { AuditLogRepository } from '../repositories/audit-log.repository.js';
import { ChannelRepository } from '../repositories/channel.repository.js';
import { IncidentAnalysisRepository } from '../repositories/incident-analysis.repository.js';
import { NotificationRepository } from '../repositories/notification.repository.js';
import { ReportRepository } from '../repositories/report.repository.js';
import { AuditService } from '../services/audit.service.js';
import { BrandingService } from '../services/branding.service.js';
import { IncidentAnalysisScheduler } from '../services/incident-analysis-scheduler.js';
import { createLogger } from '../utils/logger.js';
import { ChannelDeliveryLoop } from './channel-delivery-loop.js';
import { IncidentAnalysisLoop } from './incident-analysis-loop.js';
import {
  combineMonitorNotifiers,
  createChannelMonitorNotifier,
  createEmailMonitorNotifier,
} from './monitor-notifier.js';
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

/**
 * How long a channel delivery claim is held: one attempt's timeout, plus the
 * same margin the uptime lease leaves for the writes that follow. Shorter, and
 * a slow receiver's delivery would be claimed and sent a second time while the
 * first attempt was still waiting on it.
 */
const CHANNEL_LEASE_DURATION_MS = env.CHANNEL_DELIVERY_TIMEOUT_MS + 30_000;

/**
 * How long the worker trusts what it last read about an organization's plan.
 *
 * Anomaly detection is a paid feature checked on every uptime check, and a
 * minute is the delay after which an upgrade or downgrade takes effect there —
 * short enough that nobody notices, long enough that the plan costs one read
 * per organization per minute rather than one per check.
 */
const PLAN_CACHE_TTL_MS = 60_000;

/**
 * How long an incident analysis claim is held: one generation's timeout, plus
 * the time to gather the checks before it and write the summary after.
 */
const ANALYSIS_LEASE_DURATION_MS = env.AI_REQUEST_TIMEOUT_MS + 60_000;

const ANOMALY_SETTINGS: AnomalySettings = {
  windowSize: env.ANOMALY_WINDOW_SIZE,
  minSamples: env.ANOMALY_MIN_SAMPLES,
  zThreshold: env.ANOMALY_Z_THRESHOLD,
  minRatio: env.ANOMALY_MIN_RATIO,
  triggerChecks: env.ANOMALY_TRIGGER_CHECKS,
  recoveryChecks: env.ANOMALY_RECOVERY_CHECKS,
};

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
  readonly lastChannelTickAt: string | null;
  /** Null when no model is configured, and so no analysis loop runs. */
  readonly lastAnalysisTickAt: string | null;
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
  private readonly channelLoop: ChannelDeliveryLoop;
  private readonly analysisLoop: IncidentAnalysisLoop | null;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private started = false;
  private stopping = false;

  /** Whether outage alerts can actually be delivered. Logged at startup. */
  readonly emailConfigured: boolean;

  constructor(private readonly host: MonitoringRuntimeHost) {
    const emailService = new EmailService();
    const notifications = new NotificationRepository();
    const channelRepository = new ChannelRepository();

    /*
     * Slack, Discord and webhook messages get a loop of their own. The jobs
     * below only queue them, because a receiver that takes ten seconds to
     * answer must not hold a lease sized for one uptime check; this loop sends,
     * retries with backoff, and records what happened. Queuing wakes it, so a
     * message leaves as soon as the check that caused it is done.
     */
    this.channelLoop = new ChannelDeliveryLoop(
      {
        pollIntervalMs: env.CHANNEL_DELIVERY_POLL_INTERVAL_SECONDS * 1000,
        queue: {
          batchSize: env.CHANNEL_DELIVERY_CONCURRENCY,
          leaseDurationMs: CHANNEL_LEASE_DURATION_MS,
        },
        job: {
          timeoutMs: env.CHANNEL_DELIVERY_TIMEOUT_MS,
          maxAttempts: env.CHANNEL_DELIVERY_MAX_ATTEMPTS,
          retryBaseSeconds: env.CHANNEL_DELIVERY_RETRY_BASE_SECONDS,
          allowLoopback: env.MONITOR_ALLOW_PRIVATE_ADDRESSES,
        },
      },
      { channels: channelRepository },
    );
    const channels = new ChannelEventPublisher(channelRepository, () => {
      this.channelLoop.wake();
    });

    /*
     * AI incident analysis, only where a model is configured. The uptime job
     * queues an analysis when an outage or slowdown ends; a loop of its own
     * writes it, because a generation takes tens of seconds on somebody else's
     * servers and must never hold up a check or an alert.
     */
    const plans = new PlanLookup(PLAN_CACHE_TTL_MS);
    const model = languageModelFrom(env);
    const analysisRepository = new IncidentAnalysisRepository();
    const analyses = new IncidentAnalysisScheduler(analysisRepository, {
      enabled: model !== null,
      delaySeconds: env.AI_ANALYSIS_DELAY_SECONDS,
      minDurationSeconds: env.AI_ANALYSIS_MIN_DURATION_SECONDS,
    });
    this.analysisLoop = model
      ? new IncidentAnalysisLoop(
          {
            pollIntervalMs: env.AI_ANALYSIS_POLL_INTERVAL_SECONDS * 1000,
            queue: {
              batchSize: env.AI_ANALYSIS_CONCURRENCY,
              leaseDurationMs: ANALYSIS_LEASE_DURATION_MS,
            },
            job: {
              maxAttempts: env.AI_ANALYSIS_MAX_ATTEMPTS,
              maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
            },
          },
          {
            repository: analysisRepository,
            model,
            plans,
            audit: new AuditService(new AuditLogRepository()),
          },
        )
      : null;

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
          anomaly: ANOMALY_SETTINGS,
        },
      },
      { emailService, notifications, channels, plans, analyses },
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
        notifier: combineMonitorNotifiers(
          createEmailMonitorNotifier(emailService, notifications),
          createChannelMonitorNotifier(channels),
        ),
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
    this.channelLoop.start();
    this.analysisLoop?.start();

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
        aiAnalysis: this.analysisLoop !== null,
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
      this.channelLoop.stop(),
      this.analysisLoop?.stop(),
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
   *
   * Channel deliveries run afterwards rather than alongside. Those loops are
   * what queue them, and on a host that suspends between ticks, a message
   * queued by this sweep would otherwise wait for the next one — a minute
   * late for an outage alert.
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

    const ran: string[] = [];
    const failed: { loop: string; reason: string }[] = [];

    const record = (name: string, outcome: PromiseSettledResult<void>): void => {
      if (outcome.status === 'fulfilled') {
        ran.push(name);
        return;
      }
      const reason = outcome.reason instanceof Error ? outcome.reason.message : 'The tick failed.';
      failed.push({ loop: name, reason });
      log.error({ err: outcome.reason, loop: name }, 'monitoring_runtime.tick_failed');
    };

    const outcomes = await Promise.allSettled(loops.map(([, tick]) => tick()));
    outcomes.forEach((outcome, index) => {
      record(loops[index]?.[0] ?? 'unknown', outcome);
    });

    const [channelOutcome] = await Promise.allSettled([this.channelLoop.tickNow()]);
    if (channelOutcome) record('channels', channelOutcome);

    // Last: nothing above waits on it, and one generation can take a minute.
    if (this.analysisLoop) {
      const [analysisOutcome] = await Promise.allSettled([this.analysisLoop.tickNow()]);
      if (analysisOutcome) record('analysis', analysisOutcome);
    }

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
      lastChannelTickAt: toIso(this.channelLoop.lastTickAt()),
      lastAnalysisTickAt: toIso(this.analysisLoop?.lastTickAt() ?? null),
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
