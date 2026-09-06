import type { Types } from 'mongoose';

import { env } from '../config/env.js';
import { formatDuration, type CheckErrorType } from '../contracts/index.js';
import type { EmailService } from '../email/email.service.js';
import { websiteDownTemplate, websiteRecoveredTemplate } from '../email/templates/index.js';
import { IncidentModel } from '../models/index.js';
import type { NotificationRepository } from '../repositories/notification.repository.js';
import { dispatchToRecipients, resolveRecipients } from './notification-dispatch.js';

export interface NotifiableWebsite {
  readonly id: Types.ObjectId;
  readonly organizationId: Types.ObjectId;
  readonly name: string;
  readonly url: string;
}

/**
 * Alerting for one incident transition.
 *
 * Idempotency has two layers, and both are enforced by the database rather than
 * by bookkeeping in this file:
 *
 *  1. `incident.downNotifiedAt` is claimed with a conditional update
 *     (`{ downNotifiedAt: null }` in the *filter*). A job that runs twice for
 *     the same incident finds the field already set and does nothing further.
 *  2. Within one dispatch, each recipient's notification carries a
 *     deterministic `dedupeKey`, and the unique index on it makes a duplicate
 *     insert impossible rather than merely unlikely.
 *
 * One notification per incident transition, never a repeat while a site stays
 * down. That is the difference between a monitoring product and a mailing list.
 */

export async function notifyWebsiteDown(
  website: NotifiableWebsite,
  incidentId: Types.ObjectId,
  emailService: EmailService,
  notifications: NotificationRepository,
): Promise<void> {
  const claimed = await claimDispatch(incidentId, 'downNotifiedAt');
  if (!claimed) return;

  // The incident document, not a hand-built context, is the source of truth: it
  // was written by `incident-processor.ts` in the same pass that decided to open
  // this incident, so reading it back here cannot drift from what was persisted.
  const incident = await IncidentModel.findById(incidentId)
    .select({ startedAt: 1, failedCheckCount: 1, lastStatusCode: 1, lastErrorType: 1 })
    .lean<{
      startedAt: Date;
      failedCheckCount: number;
      lastStatusCode: number | null;
      lastErrorType: CheckErrorType | null;
    }>()
    .exec();
  if (!incident) return;

  const recipients = await resolveRecipients(website.organizationId, 'websiteDown', notifications);
  if (recipients.length === 0) return;

  const dashboardUrl = `${env.APP_URL}/dashboard/websites/${website.id.toHexString()}`;
  const content = websiteDownTemplate({
    websiteName: website.name,
    websiteUrl: website.url,
    startedAt: incident.startedAt,
    failedCheckCount: incident.failedCheckCount,
    lastStatusCode: incident.lastStatusCode,
    lastErrorType: incident.lastErrorType,
    dashboardUrl,
  });

  await dispatchToRecipients(
    recipients,
    {
      organizationId: website.organizationId,
      event: 'website.down',
      websiteId: website.id,
      incidentId,
      dedupeScope: incidentId.toHexString(),
      title: `${website.name} is down`,
      body: `Started at ${incident.startedAt.toISOString()}, after ${String(incident.failedCheckCount)} consecutive failed checks.`,
    },
    content,
    emailService,
    notifications,
  );
}

export async function notifyWebsiteRecovered(
  website: NotifiableWebsite,
  incidentId: Types.ObjectId,
  emailService: EmailService,
  notifications: NotificationRepository,
): Promise<void> {
  const claimed = await claimDispatch(incidentId, 'recoveryNotifiedAt');
  if (!claimed) return;

  const incident = await IncidentModel.findById(incidentId)
    .select({ resolvedAt: 1, durationSeconds: 1 })
    .lean<{ resolvedAt: Date | null; durationSeconds: number | null }>()
    .exec();
  if (!incident?.resolvedAt || incident.durationSeconds === null) return;

  const recipients = await resolveRecipients(
    website.organizationId,
    'websiteRecovered',
    notifications,
  );
  if (recipients.length === 0) return;

  const dashboardUrl = `${env.APP_URL}/dashboard/websites/${website.id.toHexString()}`;
  const content = websiteRecoveredTemplate({
    websiteName: website.name,
    websiteUrl: website.url,
    resolvedAt: incident.resolvedAt,
    durationSeconds: incident.durationSeconds,
    dashboardUrl,
  });

  await dispatchToRecipients(
    recipients,
    {
      organizationId: website.organizationId,
      event: 'website.recovered',
      websiteId: website.id,
      incidentId,
      dedupeScope: incidentId.toHexString(),
      title: `${website.name} has recovered`,
      body: `Resolved at ${incident.resolvedAt.toISOString()}. Was down for ${formatDuration(incident.durationSeconds)}.`,
    },
    content,
    emailService,
    notifications,
  );
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
