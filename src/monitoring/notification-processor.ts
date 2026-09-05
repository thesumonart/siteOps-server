import type { Types } from 'mongoose';

import { env } from '../config/env.js';
import { formatDuration, type CheckErrorType, type NotificationEvent } from '../contracts/index.js';
import type { EmailService } from '../email/email.service.js';
import { websiteDownTemplate, websiteRecoveredTemplate } from '../email/templates/index.js';
import type { EmailContent } from '../email/types.js';
import { IncidentModel, OrganizationMemberModel, UserModel } from '../models/index.js';
import type { NotificationRepository } from '../repositories/notification.repository.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('notification');

export interface NotifiableWebsite {
  readonly id: Types.ObjectId;
  readonly organizationId: Types.ObjectId;
  readonly name: string;
  readonly url: string;
}

interface Recipient {
  readonly userId: Types.ObjectId;
  readonly email: string;
  readonly name: string;
}

interface DispatchMeta {
  readonly organizationId: Types.ObjectId;
  readonly event: Extract<NotificationEvent, 'website.down' | 'website.recovered'>;
  readonly websiteId: Types.ObjectId;
  readonly incidentId: Types.ObjectId;
  readonly title: string;
  readonly body: string;
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

/** Base backoff between delivery attempts; doubled each time. */
const RETRY_BASE_DELAY_MS = 500;

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

async function resolveRecipients(
  organizationId: Types.ObjectId,
  preference: 'websiteDown' | 'websiteRecovered',
  notifications: NotificationRepository,
): Promise<readonly Recipient[]> {
  const members = await OrganizationMemberModel.find({ organizationId })
    .select({ userId: 1 })
    .lean<{ userId: Types.ObjectId }[]>()
    .exec();

  if (members.length === 0) return [];
  const userIds = members.map((member) => member.userId);

  const [users, settingsByUser] = await Promise.all([
    UserModel.find({ _id: { $in: userIds } })
      .select({ email: 1, name: 1, emailVerified: 1 })
      .lean<{ _id: Types.ObjectId; email: string; name: string; emailVerified: boolean }[]>()
      .exec(),
    notifications.preferencesFor(organizationId, userIds),
  ]);

  return (
    users
      // An address nobody has proven they control must never receive an alert:
      // it is the same address a stranger could have typed at sign-up.
      .filter((user) => user.emailVerified)
      .filter((user) => {
        const explicit = settingsByUser.get(user._id.toHexString());
        // No stored preference defaults to on: silently not alerting on an
        // outage is worse than one extra email.
        return explicit ? explicit[preference] : true;
      })
      .map((user) => ({ userId: user._id, email: user.email, name: user.name }))
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Sends one message, retrying a transient failure with exponential backoff.
 *
 * Retrying is bounded by `NOTIFICATION_MAX_ATTEMPTS` and happens *inside* one
 * dispatch rather than through a sweeper over `failed` rows. That is deliberate:
 * sending an email is not idempotent, so a background job that re-sent anything
 * marked failed would deliver duplicates whenever a send actually succeeded and
 * only the status write failed. Here the attempt count and the send stay in one
 * place, and a genuinely undeliverable address is recorded rather than retried
 * forever.
 */
async function sendWithRetries(
  emailService: EmailService,
  to: string,
  content: EmailContent,
): Promise<{ delivered: boolean; attempts: number; reason: string }> {
  let reason = 'Unknown delivery error.';

  for (let attempt = 1; attempt <= env.NOTIFICATION_MAX_ATTEMPTS; attempt += 1) {
    const result = await emailService.send({ to, ...content });
    if (result.delivered) return { delivered: true, attempts: attempt, reason: '' };

    reason = result.reason ?? reason;

    // A message the provider will never accept — or no provider at all — must
    // not consume the whole budget waiting between pointless retries.
    if (result.retryable !== true) return { delivered: false, attempts: attempt, reason };

    if (attempt < env.NOTIFICATION_MAX_ATTEMPTS) {
      await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  return { delivered: false, attempts: env.NOTIFICATION_MAX_ATTEMPTS, reason };
}

async function dispatchToRecipients(
  recipients: readonly Recipient[],
  meta: DispatchMeta,
  content: EmailContent,
  emailService: EmailService,
  notifications: NotificationRepository,
): Promise<void> {
  for (const recipient of recipients) {
    const dedupeKey = `${meta.incidentId.toHexString()}:${meta.event}:${recipient.userId.toHexString()}`;

    const notification = await notifications.createPending({
      organizationId: meta.organizationId,
      userId: recipient.userId,
      event: meta.event,
      websiteId: meta.websiteId,
      incidentId: meta.incidentId,
      title: meta.title,
      body: meta.body,
      dedupeKey,
    });
    // Null means the unique index rejected it: someone else already claimed
    // this recipient for this transition.
    if (!notification) continue;

    const outcome = await sendWithRetries(emailService, recipient.email, content);

    if (outcome.delivered) {
      await notifications.markSent(notification._id, outcome.attempts);
      continue;
    }

    await notifications.markFailed(notification._id, outcome.attempts, outcome.reason);
    logger.error(
      {
        userId: recipient.userId.toHexString(),
        event: meta.event,
        attempts: outcome.attempts,
        reason: outcome.reason,
      },
      'notification.delivery_failed',
    );
  }
}
