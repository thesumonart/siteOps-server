import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  clearTestDatabase,
  databaseAvailable,
  disconnectTestDatabase,
} from '../../tests/support/test-db.js';
import { EmailService } from '../email/email.service.js';
import {
  IncidentModel,
  NotificationModel,
  NotificationSettingsModel,
  OrganizationMemberModel,
  UserModel,
} from '../models/index.js';
import { NotificationRepository } from '../repositories/notification.repository.js';
import {
  notifyWebsiteDown,
  notifyWebsiteRecovered,
  type NotifiableWebsite,
} from './notification-processor.js';

const notificationRepository = new NotificationRepository();

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    // These prove guarantees that only a real database can enforce — the
    // unique `dedupeKey` index above all. Skipping is better than a mocked
    // model that would pass whether or not the index exists.
    return;
  }
});

afterEach(async () => {
  await clearTestDatabase();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

/**
 * These fixture inserts are the one place this suite writes directly to the
 * `user` collection, which application code must never do at runtime — Better
 * Auth owns it (see `UserModel`'s own doc comment). Test-only seeding of a
 * name/email pair, with no password or session field touched, is a different
 * concern from that rule and does not compete with Better Auth for ownership.
 */
async function seedMember(
  organizationId: Types.ObjectId,
  overrides: {
    readonly emailVerified?: boolean;
    readonly settings?: { websiteDown?: boolean; websiteRecovered?: boolean };
  } = {},
): Promise<{ userId: Types.ObjectId; email: string }> {
  const userId = new Types.ObjectId();
  const email = `member-${userId.toHexString()}@example.test`;

  await UserModel.create({
    _id: userId,
    name: 'Test Member',
    email,
    emailVerified: overrides.emailVerified ?? true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await OrganizationMemberModel.create({
    organizationId,
    userId,
    role: 'member',
    invitedByUserId: null,
    joinedAt: new Date(),
  });

  if (overrides.settings) {
    await NotificationSettingsModel.create({
      organizationId,
      userId,
      websiteDown: overrides.settings.websiteDown ?? true,
      websiteRecovered: overrides.settings.websiteRecovered ?? true,
    });
  }

  return { userId, email };
}

async function seedOpenIncident(
  organizationId: Types.ObjectId,
  websiteId: Types.ObjectId,
): Promise<Types.ObjectId> {
  const incident = await IncidentModel.create({
    organizationId,
    websiteId,
    status: 'open',
    type: 'downtime',
    startedAt: new Date(),
    failedCheckCount: 3,
    lastStatusCode: null,
    lastErrorType: 'timeout',
    lastErrorMessage: 'The request timed out.',
  });
  return incident._id;
}

async function seedResolvedIncident(
  organizationId: Types.ObjectId,
  websiteId: Types.ObjectId,
): Promise<Types.ObjectId> {
  const startedAt = new Date(Date.now() - 5 * 60_000);
  const incident = await IncidentModel.create({
    organizationId,
    websiteId,
    status: 'resolved',
    type: 'downtime',
    startedAt,
    resolvedAt: new Date(),
    durationSeconds: 300,
    failedCheckCount: 3,
  });
  return incident._id;
}

function websiteOf(organizationId: Types.ObjectId): NotifiableWebsite {
  return {
    id: new Types.ObjectId(),
    organizationId,
    name: 'Acme',
    url: 'https://acme.com/',
  };
}

describe('notifyWebsiteDown', () => {
  it('sends to every eligible member and records a notification per recipient', async () => {
    const organizationId = new Types.ObjectId();
    const alice = await seedMember(organizationId);
    const bob = await seedMember(organizationId);
    const website = websiteOf(organizationId);
    const incidentId = await seedOpenIncident(organizationId, website.id);

    const sendSpy = vi.spyOn(EmailService.prototype, 'send');
    const emailService = new EmailService();

    await notifyWebsiteDown(website, incidentId, emailService, notificationRepository);

    expect(sendSpy).toHaveBeenCalledTimes(2);
    const sentTo = sendSpy.mock.calls.map(([message]) => message.to).sort();
    expect(sentTo).toEqual([alice.email, bob.email].sort());

    const notifications = await NotificationModel.find({ incidentId }).lean().exec();
    expect(notifications).toHaveLength(2);
    expect(notifications.every((n) => n.event === 'website.down')).toBe(true);
  });

  it('skips a member who has turned off down alerts', async () => {
    const organizationId = new Types.ObjectId();
    await seedMember(organizationId, { settings: { websiteDown: false } });
    const website = websiteOf(organizationId);
    const incidentId = await seedOpenIncident(organizationId, website.id);

    const sendSpy = vi.spyOn(EmailService.prototype, 'send');
    await notifyWebsiteDown(website, incidentId, new EmailService(), notificationRepository);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(await NotificationModel.countDocuments({ incidentId }).exec()).toBe(0);
  });

  it('defaults to notifying when no preference row exists', async () => {
    const organizationId = new Types.ObjectId();
    // No `settings` override: seedMember does not create a NotificationSettings row.
    await seedMember(organizationId);
    const website = websiteOf(organizationId);
    const incidentId = await seedOpenIncident(organizationId, website.id);

    const sendSpy = vi.spyOn(EmailService.prototype, 'send');
    await notifyWebsiteDown(website, incidentId, new EmailService(), notificationRepository);

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('never emails an unverified member', async () => {
    const organizationId = new Types.ObjectId();
    await seedMember(organizationId, { emailVerified: false });
    const website = websiteOf(organizationId);
    const incidentId = await seedOpenIncident(organizationId, website.id);

    const sendSpy = vi.spyOn(EmailService.prototype, 'send');
    await notifyWebsiteDown(website, incidentId, new EmailService(), notificationRepository);

    expect(sendSpy).not.toHaveBeenCalled();
  });

  /**
   * The actual guarantee under test: `notification_dedupe_unique` is what
   * makes it *impossible* to double-notify, not application bookkeeping. Two
   * concurrent dispatch attempts for the same incident must still add up to
   * exactly one notification per recipient.
   */
  it('never sends twice for the same incident, even from two concurrent dispatch attempts', async () => {
    const organizationId = new Types.ObjectId();
    const member = await seedMember(organizationId);
    const website = websiteOf(organizationId);
    const incidentId = await seedOpenIncident(organizationId, website.id);

    const sendSpy = vi.spyOn(EmailService.prototype, 'send');
    const emailService = new EmailService();

    await Promise.all([
      notifyWebsiteDown(website, incidentId, emailService, notificationRepository),
      notifyWebsiteDown(website, incidentId, emailService, notificationRepository),
    ]);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[0].to).toBe(member.email);

    const notifications = await NotificationModel.find({ incidentId }).lean().exec();
    expect(notifications).toHaveLength(1);
  });

  it('is a no-op when called again after the incident-level flag is already claimed', async () => {
    const organizationId = new Types.ObjectId();
    await seedMember(organizationId);
    const website = websiteOf(organizationId);
    const incidentId = await seedOpenIncident(organizationId, website.id);

    const sendSpy = vi.spyOn(EmailService.prototype, 'send');
    const emailService = new EmailService();

    await notifyWebsiteDown(website, incidentId, emailService, notificationRepository);
    await notifyWebsiteDown(website, incidentId, emailService, notificationRepository);

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

describe('notifyWebsiteRecovered', () => {
  it('sends a recovery email to eligible members', async () => {
    const organizationId = new Types.ObjectId();
    const member = await seedMember(organizationId);
    const website = websiteOf(organizationId);
    const incidentId = await seedResolvedIncident(organizationId, website.id);

    const sendSpy = vi.spyOn(EmailService.prototype, 'send');
    await notifyWebsiteRecovered(website, incidentId, new EmailService(), notificationRepository);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[0].to).toBe(member.email);

    const notification = await NotificationModel.findOne({ incidentId }).lean().exec();
    expect(notification?.event).toBe('website.recovered');
  });

  it('respects the recovered-specific preference independently of the down preference', async () => {
    const organizationId = new Types.ObjectId();
    await seedMember(organizationId, { settings: { websiteDown: true, websiteRecovered: false } });
    const website = websiteOf(organizationId);
    const incidentId = await seedResolvedIncident(organizationId, website.id);

    const sendSpy = vi.spyOn(EmailService.prototype, 'send');
    await notifyWebsiteRecovered(website, incidentId, new EmailService(), notificationRepository);

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('does nothing for an incident that is not actually resolved', async () => {
    const organizationId = new Types.ObjectId();
    await seedMember(organizationId);
    const website = websiteOf(organizationId);
    const incidentId = await seedOpenIncident(organizationId, website.id);

    const sendSpy = vi.spyOn(EmailService.prototype, 'send');
    await notifyWebsiteRecovered(website, incidentId, new EmailService(), notificationRepository);

    // The claim on `recoveryNotifiedAt` succeeds regardless (the incident
    // simply has no `resolvedAt` yet), so the guard is the subsequent
    // `!incident?.resolvedAt` check reading the document back.
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
