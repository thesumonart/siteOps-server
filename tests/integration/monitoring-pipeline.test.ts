import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EmailService } from '../../src/email/email.service.js';
import { runMonitoringJob } from '../../src/jobs/monitoring.job.js';
import {
  IncidentModel,
  NotificationModel,
  OrganizationMemberModel,
  UserModel,
  WebsiteCheckModel,
  WebsiteModel,
} from '../../src/models/index.js';
import { claimBatch } from '../../src/queues/monitoring.queue.js';
import { NotificationRepository } from '../../src/repositories/notification.repository.js';
import { handlers, startMockServer, type MockServer } from '../support/mock-server.js';
import {
  clearTestDatabase,
  databaseAvailable,
  disconnectTestDatabase,
} from '../support/test-db.js';

/**
 * The whole monitoring pipeline, against a real database and a real HTTP server:
 * claim a lease, perform the check, record it, apply the incident rules, notify.
 *
 * The parts are unit-tested individually — `incident-rules.ts` exhaustively, the
 * checker against this same mock server. What only an end-to-end run can show is
 * that they compose: that the counters the checker produces are the ones the
 * rules read, that the incident the rules open is the one the notifier claims,
 * and that a second pass over the same failure does none of it twice.
 *
 * The mock server lives on loopback, which the SSRF guard blocks by design, so
 * these run with the test-only loopback exemption. Websites are inserted
 * directly rather than through the API for the same reason: the API is right to
 * refuse a loopback URL, and the worker's job is to check what is stored.
 */

const available = await databaseAvailable();

const JOB_OPTIONS = {
  maxRedirects: 5,
  maxAttempts: 1,
  allowLoopback: true,
  userAgent: 'SiteOpsMonitor/1.0 (test)',
} as const;

const QUEUE_OPTIONS = { batchSize: 10, leaseDurationMs: 60_000 } as const;

const notifications = new NotificationRepository();

let organizationId: Types.ObjectId;
let userId: Types.ObjectId;

beforeAll(async () => {
  if (!available) return;
  await clearTestDatabase();
});

afterEach(async () => {
  if (!available) return;
  await clearTestDatabase();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

/** One verified member, so notifications have a recipient. */
async function seedOrganization(): Promise<void> {
  organizationId = new Types.ObjectId();
  userId = new Types.ObjectId();

  await UserModel.create({
    _id: userId,
    name: 'Alert Recipient',
    email: `pipeline-${userId.toHexString()}@siteops.test`,
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
}

async function seedWebsite(
  url: string,
  overrides: Partial<{ failureThreshold: number; recoveryThreshold: number }> = {},
): Promise<Types.ObjectId> {
  const website = await WebsiteModel.create({
    organizationId,
    name: 'Pipeline Site',
    url,
    canonicalKey: url,
    status: 'unknown',
    monitoringEnabled: true,
    monitoringIntervalSeconds: 300,
    requestTimeoutMs: 2_000,
    failureThreshold: overrides.failureThreshold ?? 3,
    recoveryThreshold: overrides.recoveryThreshold ?? 2,
    nextCheckAt: new Date(),
  });
  return website._id;
}

/**
 * Runs one full tick. `nextCheckAt` is pulled back first because the job
 * reschedules a website a full interval into the future, and a test cannot wait
 * five minutes to see the second check.
 */
async function tick(): Promise<void> {
  await WebsiteModel.updateMany({}, { $set: { nextCheckAt: new Date(0), leaseExpiresAt: null } });

  const claimed = await claimBatch(QUEUE_OPTIONS);
  await Promise.all(
    claimed.map((website) =>
      runMonitoringJob(website, JOB_OPTIONS, {
        emailService: new EmailService(),
        notifications,
      }),
    ),
  );
}

describe.skipIf(!available)('the monitoring pipeline', () => {
  let server: MockServer;

  afterEach(async () => {
    await server.close();
  });

  it('records a successful check and reports the site operational', async () => {
    server = await startMockServer(handlers.ok());
    await seedOrganization();
    const websiteId = await seedWebsite(server.url);

    await tick();

    const checks = await WebsiteCheckModel.find({ websiteId }).lean().exec();
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: 'up', statusCode: 200, redirectCount: 0 });
    expect(checks[0]?.responseTimeMs).toBeGreaterThanOrEqual(0);

    const website = await WebsiteModel.findById(websiteId).lean().exec();
    expect(website?.status).toBe('operational');
    expect(website?.consecutiveFailures).toBe(0);
    expect(website?.lastStatusCode).toBe(200);
    expect(website?.lastSuccessfulCheckAt).not.toBeNull();

    // No incident, and nothing to tell anyone about.
    expect(await IncidentModel.countDocuments({ websiteId }).exec()).toBe(0);
    expect(await NotificationModel.countDocuments({}).exec()).toBe(0);
  });

  it('does not open an incident until the failure threshold is crossed', async () => {
    server = await startMockServer(handlers.status(503));
    await seedOrganization();
    const websiteId = await seedWebsite(server.url, { failureThreshold: 3 });

    await tick();
    await tick();

    // Two failures, threshold three. Nobody is paged for a blip.
    expect(await IncidentModel.countDocuments({ websiteId }).exec()).toBe(0);
    let website = await WebsiteModel.findById(websiteId).lean().exec();
    expect(website?.consecutiveFailures).toBe(2);
    expect(website?.status).toBe('degraded');

    await tick();

    const incidents = await IncidentModel.find({ websiteId }).lean().exec();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      status: 'open',
      type: 'http_error',
      failedCheckCount: 3,
      lastStatusCode: 503,
      lastErrorType: 'http_error',
    });

    website = await WebsiteModel.findById(websiteId).lean().exec();
    expect(website?.status).toBe('down');
    expect(website?.currentIncidentId?.toHexString()).toBe(incidents[0]?._id.toHexString());
  });

  it('sends exactly one alert, however long the outage lasts', async () => {
    server = await startMockServer(handlers.status(500));
    await seedOrganization();
    const websiteId = await seedWebsite(server.url, { failureThreshold: 1 });

    const send = vi.spyOn(EmailService.prototype, 'send');

    await tick();
    expect(send).toHaveBeenCalledTimes(1);

    // Three more failing checks while the incident stays open.
    await tick();
    await tick();
    await tick();

    // Still one email, and one delivery record.
    expect(send).toHaveBeenCalledTimes(1);
    expect(await NotificationModel.countDocuments({ event: 'website.down' }).exec()).toBe(1);

    // One incident, with its failure count still accumulating.
    const incidents = await IncidentModel.find({ websiteId }).lean().exec();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.failedCheckCount).toBe(4);
    expect(incidents[0]?.downNotifiedAt).not.toBeNull();
  });

  it('resolves the incident once the recovery threshold is met, and says so once', async () => {
    let healthy = false;
    server = await startMockServer((_request, response) => {
      if (healthy) {
        response.writeHead(200);
        response.end('ok');
        return;
      }
      response.writeHead(503);
      response.end();
    });

    await seedOrganization();
    const websiteId = await seedWebsite(server.url, {
      failureThreshold: 1,
      recoveryThreshold: 2,
    });

    const send = vi.spyOn(EmailService.prototype, 'send');

    await tick();
    const opened = await IncidentModel.findOne({ websiteId }).lean().exec();
    expect(opened?.status).toBe('open');

    healthy = true;

    await tick();
    // One success, recovery threshold two: still down, and still no second email.
    let incident = await IncidentModel.findById(opened?._id).lean().exec();
    expect(incident?.status).toBe('open');
    let website = await WebsiteModel.findById(websiteId).lean().exec();
    // The incident is still open, so the dashboard must not contradict it.
    expect(website?.status).toBe('down');
    expect(send).toHaveBeenCalledTimes(1);

    await tick();

    incident = await IncidentModel.findById(opened?._id).lean().exec();
    expect(incident?.status).toBe('resolved');
    expect(incident?.resolvedAt).not.toBeNull();
    expect(incident?.durationSeconds).toBeGreaterThanOrEqual(0);
    // Resolved automatically, so no person is recorded against it.
    expect(incident?.resolvedByUserId).toBeNull();

    website = await WebsiteModel.findById(websiteId).lean().exec();
    expect(website?.status).toBe('operational');
    expect(website?.currentIncidentId).toBeNull();

    expect(send).toHaveBeenCalledTimes(2);
    expect(await NotificationModel.countDocuments({ event: 'website.recovered' }).exec()).toBe(1);

    // Further healthy checks say nothing more.
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('classifies a timeout rather than reporting a generic failure', async () => {
    server = await startMockServer(handlers.hang());
    await seedOrganization();
    const websiteId = await seedWebsite(server.url, { failureThreshold: 1 });

    await tick();

    const check = await WebsiteCheckModel.findOne({ websiteId }).lean().exec();
    expect(check?.status).toBe('timeout');
    expect(check?.errorType).toBe('timeout');

    const incident = await IncidentModel.findOne({ websiteId }).lean().exec();
    expect(incident?.type).toBe('timeout');
  });

  it('classifies a refused connection', async () => {
    server = await startMockServer(handlers.ok());
    const { port } = server;
    await server.close();
    // Reopened only so `afterEach` has something to close.
    server = await startMockServer(handlers.ok());

    await seedOrganization();
    const websiteId = await seedWebsite(`http://127.0.0.1:${String(port)}`, {
      failureThreshold: 1,
    });

    await tick();

    const check = await WebsiteCheckModel.findOne({ websiteId }).lean().exec();
    expect(check?.status).toBe('error');
    expect(check?.errorType).toBe('connection_refused');

    const incident = await IncidentModel.findOne({ websiteId }).lean().exec();
    expect(incident?.type).toBe('connection_error');
  });

  it('follows a redirect and counts the hops', async () => {
    const target = await startMockServer(handlers.ok());
    server = await startMockServer(handlers.redirectTo(`${target.url}/final`));

    await seedOrganization();
    const websiteId = await seedWebsite(server.url);

    await tick();
    await target.close();

    const check = await WebsiteCheckModel.findOne({ websiteId }).lean().exec();
    expect(check?.status).toBe('up');
    expect(check?.redirectCount).toBe(1);
  });

  it('refuses a redirect into a blocked address, mid-chain', async () => {
    // A public-looking origin that 302s straight at cloud metadata. The
    // connect-time guard would never see this hop, because Node skips a custom
    // DNS lookup for an IP literal — the per-hop string check is what catches it.
    server = await startMockServer(handlers.redirectTo('http://169.254.169.254/latest/meta-data/'));

    await seedOrganization();
    const websiteId = await seedWebsite(server.url, { failureThreshold: 1 });

    await tick();

    const check = await WebsiteCheckModel.findOne({ websiteId }).lean().exec();
    expect(check?.status).toBe('error');
    expect(check?.errorType).toBe('blocked_target');
  });

  it('always reschedules and releases the lease, even after a failure', async () => {
    server = await startMockServer(handlers.status(500));
    await seedOrganization();
    const websiteId = await seedWebsite(server.url);

    await tick();

    const website = await WebsiteModel.findById(websiteId).lean().exec();
    // A stranded lease would silently stop a website being checked ever again.
    expect(website?.leaseExpiresAt).toBeNull();
    expect(website?.nextCheckAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('never claims the same website twice within one lease', async () => {
    server = await startMockServer(handlers.ok());
    await seedOrganization();
    await seedWebsite(server.url);

    const first = await claimBatch(QUEUE_OPTIONS);
    const second = await claimBatch(QUEUE_OPTIONS);

    expect(first).toHaveLength(1);
    // The lease is held, so a second worker finds nothing left to claim.
    expect(second).toHaveLength(0);
  });

  it('does not claim a paused website', async () => {
    server = await startMockServer(handlers.ok());
    await seedOrganization();
    const websiteId = await seedWebsite(server.url);
    await WebsiteModel.updateOne(
      { _id: websiteId },
      { $set: { monitoringEnabled: false, status: 'paused' } },
    ).exec();

    const claimed = await claimBatch(QUEUE_OPTIONS);
    expect(claimed).toHaveLength(0);
  });
});
