import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CHANNEL_EVENTS, type Plan } from '../../src/contracts/index.js';
import { EmailService } from '../../src/email/email.service.js';
import { runMonitoringJob } from '../../src/jobs/monitoring.job.js';
import {
  ChannelDeliveryModel,
  IncidentModel,
  NotificationChannelModel,
  NotificationModel,
  OrganizationMemberModel,
  OrganizationModel,
  UserModel,
  WebsiteCheckModel,
  WebsiteModel,
} from '../../src/models/index.js';
import { ChannelEventPublisher } from '../../src/monitoring/channel-dispatch.js';
import { PlanLookup } from '../../src/monitoring/plan-lookup.js';
import { claimBatch } from '../../src/queues/monitoring.queue.js';
import { ChannelRepository } from '../../src/repositories/channel.repository.js';
import { NotificationRepository } from '../../src/repositories/notification.repository.js';
import { sealSecret } from '../../src/utils/secret-box.js';
import { startMockServer, type MockServer } from '../support/mock-server.js';
import {
  clearTestDatabase,
  databaseAvailable,
  disconnectTestDatabase,
} from '../support/test-db.js';

/**
 * Response-time anomaly detection through the real pipeline: a website with an
 * established baseline slows down, is declared degraded after the configured
 * streak, is announced once by email and channel, and recovers.
 *
 * The seeded baseline is 150 and 250 ms alternating — a mean of 200 and a
 * standard deviation of 50 — so the loopback mock answering in a few
 * milliseconds is unambiguously normal, and one answering after a second is
 * unambiguously not. Loopback jitter cannot land a false positive in between.
 */

const available = await databaseAvailable();

const notifications = new NotificationRepository();
const channels = new ChannelEventPublisher(new ChannelRepository());

const JOB_OPTIONS = {
  maxRedirects: 5,
  maxAttempts: 1,
  allowLoopback: true,
  userAgent: 'SiteOpsMonitor/1.0 (test)',
  anomaly: {
    windowSize: 100,
    minSamples: 30,
    zThreshold: 3,
    minRatio: 1.5,
    triggerChecks: 3,
    recoveryChecks: 3,
  },
} as const;

const SLOW_MS = 1_000;
const BASELINE = Array.from({ length: 50 }, (_unused, index) => (index % 2 === 0 ? 150 : 250));

let organizationId: Types.ObjectId;
let server: MockServer | null = null;
let slow = false;

/*
 * Every tick claims whatever websites are due, from the whole collection. A
 * website another file left behind would be claimed in place of this file's
 * own, and the first case would see a check that never ran. Starting from an
 * empty queue makes the file independent of what ran before it.
 */
beforeAll(async () => {
  if (available) await clearTestDatabase();
});

afterEach(async () => {
  await server?.close();
  server = null;
  slow = false;
  if (available) await clearTestDatabase();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

/** An organization with one verified member, so an alert has somebody to go to. */
async function seedOrganization(plan: Plan): Promise<void> {
  organizationId = new Types.ObjectId();
  const userId = new Types.ObjectId();

  await OrganizationModel.create({
    _id: organizationId,
    name: 'Anomaly Org',
    slug: `anomaly-org-${organizationId.toHexString()}`,
    plan,
    createdByUserId: userId,
  });
  await UserModel.create({
    _id: userId,
    name: 'On Call',
    email: `anomaly-${userId.toHexString()}@siteops.test`,
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await OrganizationMemberModel.create({
    organizationId,
    userId,
    role: 'owner',
    invitedByUserId: null,
    joinedAt: new Date(),
  });
  await NotificationChannelModel.create({
    organizationId,
    name: 'Webhook',
    type: 'webhook',
    enabled: true,
    events: [...CHANNEL_EVENTS],
    urlCiphertext: sealSecret('https://hooks.example.org/in', organizationId.toHexString()),
    targetPreview: 'https://hooks.example.org/…',
    secretCiphertext: null,
    metadata: {},
    createdByUserId: userId,
  });
}

/** A website whose answer is fast or slow depending on `slow`. */
async function seedWebsite(samples: readonly number[] = BASELINE): Promise<Types.ObjectId> {
  server = await startMockServer((_request, response) => {
    const answer = (): void => {
      response.writeHead(200);
      response.end('ok');
    };
    if (slow) setTimeout(answer, SLOW_MS).unref();
    else answer();
  });

  const website = await WebsiteModel.create({
    organizationId,
    name: 'Acme Store',
    url: server.url,
    canonicalKey: server.url,
    status: 'operational',
    monitoringEnabled: true,
    monitoringIntervalSeconds: 300,
    requestTimeoutMs: 5_000,
    failureThreshold: 3,
    recoveryThreshold: 2,
    nextCheckAt: new Date(),
    responseTimeSamples: [...samples],
  });
  return website._id;
}

async function tick(): Promise<void> {
  await WebsiteModel.updateMany({}, { $set: { nextCheckAt: new Date(0), leaseExpiresAt: null } });
  const claimed = await claimBatch({ batchSize: 10, leaseDurationMs: 60_000 });
  await Promise.all(
    claimed.map((website) =>
      runMonitoringJob(website, JOB_OPTIONS, {
        emailService: new EmailService(),
        notifications,
        channels,
        plans: new PlanLookup(0),
      }),
    ),
  );
}

async function ticks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await tick();
}

describe.skipIf(!available)('a website that slows down', () => {
  it('is declared degraded after the streak, announced once, and recovers', async () => {
    await seedOrganization('starter');
    const websiteId = await seedWebsite();

    slow = true;
    await ticks(2);

    // Two slow checks, trigger three: flagged, but nobody is told yet.
    expect(await IncidentModel.countDocuments({ websiteId, category: 'anomaly' }).exec()).toBe(0);
    let website = await WebsiteModel.findById(websiteId).lean().exec();
    expect(website?.consecutiveAnomalies).toBe(2);

    await tick();

    const incident = await IncidentModel.findOne({ websiteId, category: 'anomaly' }).lean().exec();
    expect(incident).toMatchObject({
      status: 'open',
      type: 'response_time_anomaly',
      severity: 'warning',
      failedCheckCount: 3,
    });
    expect(incident?.detail).toMatch(/^Responding in \d+ ms, against a usual \d+ ± \d+ ms/);

    // Still up, and not described as down: degraded.
    website = await WebsiteModel.findById(websiteId).lean().exec();
    expect(website?.status).toBe('degraded');
    expect(website?.currentAnomalyIncidentId?.toHexString()).toBe(incident?._id.toHexString());
    expect(website?.currentIncidentId).toBeNull();

    const checks = await WebsiteCheckModel.find({ websiteId }).sort({ checkedAt: 1 }).lean().exec();
    expect(checks.map((check) => check.anomalous)).toEqual([true, true, true]);
    expect(checks[0]?.zScore).toBeGreaterThan(3);

    // One email row per recipient, one queued delivery per channel.
    expect(await NotificationModel.countDocuments({ event: 'website.degraded' }).exec()).toBe(1);
    const delivery = await ChannelDeliveryModel.findOne({ event: 'website.degraded' })
      .lean()
      .exec();
    expect(delivery?.payload.data.anomaly).toMatchObject({
      baselineMeanMs: expect.any(Number),
      sampleCount: 52,
      zScore: expect.any(Number),
    });
    expect(delivery?.payload.data.anomaly?.responseTimeMs).toBeGreaterThanOrEqual(SLOW_MS);

    // Staying slow says nothing more.
    await tick();
    expect(await NotificationModel.countDocuments({ event: 'website.degraded' }).exec()).toBe(1);
    expect(await ChannelDeliveryModel.countDocuments({ event: 'website.degraded' }).exec()).toBe(1);

    slow = false;
    await ticks(2);

    // Two normal checks, recovery three: still degraded.
    website = await WebsiteModel.findById(websiteId).lean().exec();
    expect(website?.status).toBe('degraded');

    await tick();

    const resolved = await IncidentModel.findById(incident?._id).lean().exec();
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.durationSeconds).toBeGreaterThanOrEqual(0);

    website = await WebsiteModel.findById(websiteId).lean().exec();
    expect(website?.status).toBe('operational');
    expect(website?.currentAnomalyIncidentId).toBeNull();

    expect(
      await NotificationModel.countDocuments({ event: 'website.degradation_resolved' }).exec(),
    ).toBe(1);
    expect(
      await ChannelDeliveryModel.countDocuments({ event: 'website.degradation_resolved' }).exec(),
    ).toBe(1);
  });

  it('is not declared degraded by one slow check', async () => {
    await seedOrganization('starter');
    const websiteId = await seedWebsite();

    slow = true;
    await tick();
    slow = false;
    await ticks(3);

    expect(await IncidentModel.countDocuments({ websiteId }).exec()).toBe(0);
    const website = await WebsiteModel.findById(websiteId).lean().exec();
    expect(website?.status).toBe('operational');
    expect(website?.consecutiveAnomalies).toBe(0);
  });

  it('is not scored without enough history', async () => {
    await seedOrganization('starter');
    const websiteId = await seedWebsite(BASELINE.slice(0, 10));

    slow = true;
    await ticks(3);

    expect(await IncidentModel.countDocuments({ websiteId }).exec()).toBe(0);
    const checks = await WebsiteCheckModel.find({ websiteId }).lean().exec();
    expect(checks.every((check) => !check.anomalous && check.zScore === null)).toBe(true);
  });
});

describe.skipIf(!available)('what the plan includes', () => {
  it('scores nothing on a plan without anomaly detection, but keeps the window', async () => {
    await seedOrganization('free');
    const websiteId = await seedWebsite();

    slow = true;
    await ticks(3);

    expect(await IncidentModel.countDocuments({ websiteId }).exec()).toBe(0);
    const checks = await WebsiteCheckModel.find({ websiteId }).lean().exec();
    expect(checks.every((check) => !check.anomalous && check.zScore === null)).toBe(true);

    // An upgrade must not start with thirty checks of silence.
    const website = await WebsiteModel.findById(websiteId).lean().exec();
    expect(website?.responseTimeSamples).toHaveLength(BASELINE.length + 3);
  });

  it('closes an open anomaly quietly after a downgrade', async () => {
    await seedOrganization('starter');
    const websiteId = await seedWebsite();

    slow = true;
    await ticks(3);
    expect(await IncidentModel.countDocuments({ websiteId, status: 'open' }).exec()).toBe(1);

    await OrganizationModel.updateOne({ _id: organizationId }, { $set: { plan: 'free' } }).exec();
    await tick();

    expect(await IncidentModel.countDocuments({ websiteId, status: 'open' }).exec()).toBe(0);
    const website = await WebsiteModel.findById(websiteId).lean().exec();
    // Answering, under the absolute slow threshold, and nothing open: operational.
    expect(website?.status).toBe('operational');
    expect(website?.currentAnomalyIncidentId).toBeNull();
    // Nobody is paying to hear that it ended.
    expect(
      await ChannelDeliveryModel.countDocuments({ event: 'website.degradation_resolved' }).exec(),
    ).toBe(0);
  });
});

describe.skipIf(!available)('the rolling window', () => {
  it('never grows past its size', async () => {
    await seedOrganization('starter');
    const full = Array.from({ length: 100 }, (_unused, index) => (index % 2 === 0 ? 150 : 250));
    const websiteId = await seedWebsite(full);

    await ticks(2);

    const website = await WebsiteModel.findById(websiteId).lean().exec();
    expect(website?.responseTimeSamples).toHaveLength(100);
    // The oldest were trimmed, the newest appended.
    expect(website?.responseTimeSamples.slice(0, 98)).toEqual(full.slice(2));
  });

  it('keeps failed checks out of the window and out of the streak', async () => {
    await seedOrganization('starter');
    const websiteId = await seedWebsite();
    await server?.close();
    // Nothing listening: every check is a refused connection.
    server = null;

    await ticks(2);

    const website = await WebsiteModel.findById(websiteId).lean().exec();
    expect(website?.responseTimeSamples).toHaveLength(BASELINE.length);
    expect(website?.consecutiveAnomalies).toBe(0);
    expect(await IncidentModel.countDocuments({ websiteId, category: 'anomaly' }).exec()).toBe(0);
  });
});
