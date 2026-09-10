import type { Types } from 'mongoose';

import { env } from '../config/env.js';
import { PREFERENCE_FOR_MONITOR } from '../contracts/index.js';
import type { EmailService } from '../email/email.service.js';
import { monitorAlertTemplate, monitorRecoveredTemplate } from '../email/templates/index.js';
import { IncidentModel } from '../models/index.js';
import type { ChannelEventPublisher } from '../monitoring/channel-dispatch.js';
import type { MonitorRunResult } from '../monitoring/monitor-runner.js';
import { dispatchToRecipients, resolveRecipients } from '../monitoring/notification-dispatch.js';
import type { ClaimedMonitor } from '../queues/monitor.queue.js';
import type { NotificationRepository } from '../repositories/notification.repository.js';

/**
 * Alerting for the auxiliary monitors.
 *
 * Idempotency has the same two layers as uptime alerting, and both are enforced
 * by the database rather than by bookkeeping here:
 *
 *  1. `incident.downNotifiedAt` is claimed with a conditional update, so a
 *     replayed job finds it already set and sends nothing.
 *  2. Each recipient's row carries a deterministic `dedupeKey` whose unique
 *     index makes a duplicate insert impossible.
 *
 * Declared as an interface so the job can be tested without a mail provider,
 * and so a future channel — Slack, a webhook — is another implementation rather
 * than a branch inside this one.
 */
export interface MonitorNotifier {
  monitorProblem(
    monitor: ClaimedMonitor,
    result: MonitorRunResult,
    incidentId: Types.ObjectId,
  ): Promise<void>;

  monitorRecovered(
    monitor: ClaimedMonitor,
    result: MonitorRunResult,
    incidentId: Types.ObjectId,
  ): Promise<void>;
}

/** Atomically claims the incident-level dispatch flag for one event. */
async function claimDispatch(
  incidentId: Types.ObjectId,
  field: 'downNotifiedAt' | 'recoveryNotifiedAt',
): Promise<boolean> {
  const result = await IncidentModel.updateOne(
    { _id: incidentId, [field]: null },
    { $set: { [field]: new Date() } },
  ).exec();

  return result.modifiedCount > 0;
}

export function createEmailMonitorNotifier(
  emailService: EmailService,
  notifications: NotificationRepository,
): MonitorNotifier {
  return {
    async monitorProblem(monitor, result, incidentId): Promise<void> {
      // Only these two statuses open an incident, so anything else reaching
      // here is a caller bug rather than a case to render.
      if (result.status !== 'failing' && result.status !== 'warning') return;

      const claimed = await claimDispatch(incidentId, 'downNotifiedAt');
      if (!claimed) return;

      const recipients = await resolveRecipients(
        monitor.organizationId,
        PREFERENCE_FOR_MONITOR[monitor.type],
        notifications,
      );
      if (recipients.length === 0) return;

      const detectedAt = new Date();
      const dashboardUrl = `${env.APP_URL}/dashboard/websites/${monitor.websiteId.toHexString()}`;

      await dispatchToRecipients(
        recipients,
        {
          organizationId: monitor.organizationId,
          event: 'monitor.problem',
          websiteId: monitor.websiteId,
          incidentId,
          dedupeScope: incidentId.toHexString(),
          title: `${monitor.websiteName}: ${result.summary}`,
          body: result.summary,
        },
        monitorAlertTemplate({
          websiteName: monitor.websiteName,
          websiteUrl: monitor.websiteUrl,
          monitorType: monitor.type,
          status: result.status,
          summary: result.summary,
          findings: result.findings,
          detectedAt,
          dashboardUrl,
        }),
        emailService,
        notifications,
      );
    },

    async monitorRecovered(monitor, result, incidentId): Promise<void> {
      const claimed = await claimDispatch(incidentId, 'recoveryNotifiedAt');
      if (!claimed) return;

      const recipients = await resolveRecipients(
        monitor.organizationId,
        PREFERENCE_FOR_MONITOR[monitor.type],
        notifications,
      );
      if (recipients.length === 0) return;

      const resolvedAt = new Date();
      const dashboardUrl = `${env.APP_URL}/dashboard/websites/${monitor.websiteId.toHexString()}`;

      await dispatchToRecipients(
        recipients,
        {
          organizationId: monitor.organizationId,
          event: 'monitor.recovered',
          websiteId: monitor.websiteId,
          incidentId,
          dedupeScope: incidentId.toHexString(),
          title: `${monitor.websiteName}: resolved`,
          body: result.summary,
        },
        monitorRecoveredTemplate({
          websiteName: monitor.websiteName,
          websiteUrl: monitor.websiteUrl,
          monitorType: monitor.type,
          summary: result.summary,
          resolvedAt,
          dashboardUrl,
        }),
        emailService,
        notifications,
      );
    },
  };
}

/**
 * Monitor transitions for the organization's Slack, Discord and webhook
 * channels. The publisher only queues; see `monitoring/channel-dispatch.ts`.
 */
export function createChannelMonitorNotifier(publisher: ChannelEventPublisher): MonitorNotifier {
  return {
    async monitorProblem(monitor, result, incidentId): Promise<void> {
      // The same guard as email: only these two statuses open an incident.
      if (result.status !== 'failing' && result.status !== 'warning') return;
      await publisher.monitorProblem(monitor, result, incidentId);
    },

    async monitorRecovered(monitor, result, incidentId): Promise<void> {
      await publisher.monitorRecovered(monitor, result, incidentId);
    },
  };
}

/**
 * One transition, told to every notifier.
 *
 * Each runs whatever happens to the others — an email provider outage must not
 * stop the Slack message, nor the reverse — and the first failure is rethrown
 * once all have settled, so the job still logs that something went wrong.
 */
export function combineMonitorNotifiers(...notifiers: readonly MonitorNotifier[]): MonitorNotifier {
  async function everyone(send: (notifier: MonitorNotifier) => Promise<void>): Promise<void> {
    const results = await Promise.allSettled(notifiers.map(send));
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) {
      throw failure.reason instanceof Error ? failure.reason : new Error('A notifier failed.');
    }
  }

  return {
    monitorProblem: (monitor, result, incidentId) =>
      everyone((notifier) => notifier.monitorProblem(monitor, result, incidentId)),
    monitorRecovered: (monitor, result, incidentId) =>
      everyone((notifier) => notifier.monitorRecovered(monitor, result, incidentId)),
  };
}
