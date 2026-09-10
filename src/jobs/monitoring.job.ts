import type { EmailService } from '../email/email.service.js';
import type { AnomalySettings } from '../monitoring/anomaly-detection.js';
import type { ChannelEventPublisher } from '../monitoring/channel-dispatch.js';
import { checkWebsiteWithRetries } from '../monitoring/check-with-retries.js';
import type { CheckOptions } from '../monitoring/http-checker.js';
import {
  notifyWebsiteDegradationResolved,
  notifyWebsiteDegraded,
  notifyWebsiteDown,
  notifyWebsiteRecovered,
} from '../monitoring/notification-processor.js';
import type { PlanLookup } from '../monitoring/plan-lookup.js';
import { processCheckResult } from '../monitoring/result-processor.js';
import { releaseAndReschedule, type ClaimedWebsite } from '../queues/monitoring.queue.js';
import type { NotificationRepository } from '../repositories/notification.repository.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('monitoring-job');

export interface MonitoringJobOptions {
  readonly maxRedirects: number;
  readonly maxAttempts: number;
  readonly allowLoopback: boolean;
  readonly userAgent: string;
  readonly anomaly: AnomalySettings;
}

export interface MonitoringJobDependencies {
  readonly emailService: EmailService;
  readonly notifications: NotificationRepository;
  /** Queues Slack, Discord and webhook messages. Never sends inside the lease. */
  readonly channels: ChannelEventPublisher;
  /** Answers "does this organization's plan include anomaly detection" without a query per check. */
  readonly plans: PlanLookup;
}

/**
 * The full pipeline for one claimed website: check (with retries), record,
 * apply the incident rules, notify, then always release the lease and schedule
 * the next check.
 *
 * The `finally` block is the actual reliability guarantee here — every
 * exception path above it still leaves the website rescheduled promptly, rather
 * than depending on the lease to expire on its own.
 */
export async function runMonitoringJob(
  website: ClaimedWebsite,
  options: MonitoringJobOptions,
  dependencies: MonitoringJobDependencies,
): Promise<void> {
  try {
    const outcome = await checkWebsiteWithRetries(
      website.url,
      {
        timeoutMs: website.requestTimeoutMs,
        maxRedirects: options.maxRedirects,
        allowLoopback: options.allowLoopback,
        userAgent: options.userAgent,
      } satisfies CheckOptions,
      { maxAttempts: options.maxAttempts },
    );

    const checkedAt = new Date();
    const result = await processCheckResult(website, outcome, checkedAt, {
      anomaly: options.anomaly,
      plans: dependencies.plans,
    });

    // A failed alert must never roll back the incident that triggered it — the
    // incident and check state are already durably written by the time either
    // of these runs, so a notification failure is only ever logged. Email and
    // channels are independent of each other for the same reason: a mail
    // provider outage must not stop the Slack message, nor the reverse.
    const logFailure =
      (event: string) =>
      (error: unknown): void => {
        logger.error({ err: error, websiteId: website.id.toHexString() }, event);
      };

    const openedId = result.incident.newlyOpenedIncidentId;
    const resolvedId = result.incident.newlyResolvedIncidentId;

    if (openedId) {
      await Promise.all([
        notifyWebsiteDown(
          website,
          openedId,
          dependencies.emailService,
          dependencies.notifications,
        ).catch(logFailure('notification.down_dispatch_failed')),
        dependencies.channels
          .websiteDown(website, openedId)
          .catch(logFailure('channel.down_publish_failed')),
      ]);
    } else if (resolvedId) {
      await Promise.all([
        notifyWebsiteRecovered(
          website,
          resolvedId,
          dependencies.emailService,
          dependencies.notifications,
        ).catch(logFailure('notification.recovery_dispatch_failed')),
        dependencies.channels
          .websiteRecovered(website, resolvedId)
          .catch(logFailure('channel.recovery_publish_failed')),
      ]);
    }

    // Degradation is told the same way, and separately from availability: one
    // check can confirm both a recovery and the end of a slowdown.
    const degradedId = result.anomaly.newlyOpenedIncidentId;
    const restoredId = result.anomaly.newlyResolvedIncidentId;
    const facts = result.anomaly.facts;

    if (degradedId && facts) {
      await Promise.all([
        notifyWebsiteDegraded(
          website,
          degradedId,
          facts,
          result.anomaly.counters.consecutiveAnomalies,
          dependencies.emailService,
          dependencies.notifications,
        ).catch(logFailure('notification.degraded_dispatch_failed')),
        dependencies.channels
          .websiteDegraded(website, degradedId, facts)
          .catch(logFailure('channel.degraded_publish_failed')),
      ]);
    } else if (restoredId) {
      await Promise.all([
        notifyWebsiteDegradationResolved(
          website,
          restoredId,
          dependencies.emailService,
          dependencies.notifications,
        ).catch(logFailure('notification.degradation_resolved_dispatch_failed')),
        dependencies.channels
          .websiteDegradationResolved(website, restoredId)
          .catch(logFailure('channel.degradation_resolved_publish_failed')),
      ]);
    }
  } catch (error) {
    logger.error(
      { err: error, websiteId: website.id.toHexString() },
      'website.check.pipeline_failed',
    );
  } finally {
    await releaseAndReschedule(website.id, website.monitoringIntervalSeconds).catch(
      (error: unknown) => {
        // Nothing further can be done from here; the lease's own expiry is the
        // last-resort backstop if even this write fails.
        logger.error(
          { err: error, websiteId: website.id.toHexString() },
          'scheduler.release_failed',
        );
      },
    );
  }
}
