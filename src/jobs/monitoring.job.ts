import type { EmailService } from '../email/email.service.js';
import { checkWebsiteWithRetries } from '../monitoring/check-with-retries.js';
import type { CheckOptions } from '../monitoring/http-checker.js';
import { notifyWebsiteDown, notifyWebsiteRecovered } from '../monitoring/notification-processor.js';
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
}

export interface MonitoringJobDependencies {
  readonly emailService: EmailService;
  readonly notifications: NotificationRepository;
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
    const result = await processCheckResult(website, outcome, checkedAt);

    // A failed alert must never roll back the incident that triggered it — the
    // incident and check state are already durably written by the time either
    // of these runs, so a notification failure is only ever logged.
    if (result.incident.newlyOpenedIncidentId) {
      await notifyWebsiteDown(
        website,
        result.incident.newlyOpenedIncidentId,
        dependencies.emailService,
        dependencies.notifications,
      ).catch((error: unknown) => {
        logger.error(
          { err: error, websiteId: website.id.toHexString() },
          'notification.down_dispatch_failed',
        );
      });
    } else if (result.incident.newlyResolvedIncidentId) {
      await notifyWebsiteRecovered(
        website,
        result.incident.newlyResolvedIncidentId,
        dependencies.emailService,
        dependencies.notifications,
      ).catch((error: unknown) => {
        logger.error(
          { err: error, websiteId: website.id.toHexString() },
          'notification.recovery_dispatch_failed',
        );
      });
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
