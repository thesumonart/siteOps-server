import type { Types } from 'mongoose';

import { env } from '../config/env.js';
import type { NotificationEvent, PreferenceField } from '../contracts/index.js';
import type { EmailService } from '../email/email.service.js';
import type { EmailContent } from '../email/types.js';
import { OrganizationMemberModel, UserModel } from '../models/index.js';
import type { NotificationRepository } from '../repositories/notification.repository.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('notification');

/**
 * The delivery mechanics shared by every alert SiteOps sends.
 *
 * Extracted from `notification-processor.ts` when the auxiliary monitors
 * arrived and needed the same three things: work out who wants this, send it
 * once per person, and record what happened. Duplicating that would have meant
 * two implementations of the deduplication guarantee, and the second one is
 * always the one that sends twice.
 *
 * What stays out of here is *what* to send and *when*. Each caller decides
 * that; this module only decides who and how.
 */

/** Base backoff between delivery attempts; doubled each time. */
const RETRY_BASE_DELAY_MS = 500;

export interface Recipient {
  readonly userId: Types.ObjectId;
  readonly email: string;
  readonly name: string;
}

export interface DispatchMeta {
  readonly organizationId: Types.ObjectId;
  readonly event: NotificationEvent;
  readonly websiteId: Types.ObjectId | null;
  readonly incidentId: Types.ObjectId | null;
  readonly title: string;
  readonly body: string;
  /**
   * Deterministic identity for one alert about one thing.
   *
   * Combined with the recipient to form the `dedupeKey`, whose unique index is
   * what makes duplicate delivery impossible rather than merely unlikely.
   */
  readonly dedupeScope: string;
}

/**
 * Everyone in an organization who has not turned this kind of alert off.
 *
 * Two rules are worth stating because both are security-relevant and both are
 * easy to get wrong in the permissive direction:
 *
 *  - An unverified address never receives anything. It is the same address a
 *    stranger could have typed at sign-up, and an alert would confirm the
 *    organization exists and name its websites to them.
 *  - No stored preference means *notified*. Absence means "never asked", and
 *    defaulting that to silence would mean an outage nobody hears about.
 */
export async function resolveRecipients(
  organizationId: Types.ObjectId,
  preference: PreferenceField,
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

  return users
    .filter((user) => user.emailVerified)
    .filter((user) => {
      const explicit = settingsByUser.get(user._id.toHexString());
      return explicit ? explicit[preference] : true;
    })
    .map((user) => ({ userId: user._id, email: user.email, name: user.name }));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Sends one message, retrying a transient failure with exponential backoff.
 *
 * Retrying is bounded by `NOTIFICATION_MAX_ATTEMPTS` and happens *inside* one
 * dispatch rather than through a sweeper over `failed` rows. Sending an email
 * is not idempotent, so a background job that re-sent anything marked failed
 * would deliver duplicates whenever a send actually succeeded and only the
 * status write failed. Here the attempt count and the send stay in one place,
 * and a genuinely undeliverable address is recorded rather than retried
 * forever.
 */
export async function sendWithRetries(
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

/** Sends one alert to each recipient, recording a delivery row for each. */
export async function dispatchToRecipients(
  recipients: readonly Recipient[],
  meta: DispatchMeta,
  content: EmailContent,
  emailService: EmailService,
  notifications: NotificationRepository,
): Promise<void> {
  for (const recipient of recipients) {
    const dedupeKey = `${meta.dedupeScope}:${meta.event}:${recipient.userId.toHexString()}`;

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
