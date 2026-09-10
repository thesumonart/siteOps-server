import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import { Types } from 'mongoose';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  CHANNEL_EVENTS,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  type ChannelEvent,
  type ChannelType,
  type Plan,
  type WebhookBody,
} from '../../src/contracts/index.js';
import { EmailService } from '../../src/email/email.service.js';
import {
  runChannelDelivery,
  type ChannelDeliveryJobOptions,
} from '../../src/jobs/channel-delivery.job.js';
import { runMonitoringJob } from '../../src/jobs/monitoring.job.js';
import {
  ChannelDeliveryModel,
  IncidentModel,
  NotificationChannelModel,
  OrganizationModel,
  WebsiteModel,
} from '../../src/models/index.js';
import { ChannelEventPublisher } from '../../src/monitoring/channel-dispatch.js';
import { PlanLookup } from '../../src/monitoring/plan-lookup.js';
import type { ClaimedMonitor } from '../../src/queues/monitor.queue.js';
import { claimDeliveryBatch } from '../../src/queues/channel-delivery.queue.js';
import { claimBatch } from '../../src/queues/monitoring.queue.js';
import { ChannelRepository } from '../../src/repositories/channel.repository.js';
import { NotificationRepository } from '../../src/repositories/notification.repository.js';
import { sealSecret } from '../../src/utils/secret-box.js';
import { handlers, startMockServer, type MockServer } from '../support/mock-server.js';
import {
  clearTestDatabase,
  databaseAvailable,
  disconnectTestDatabase,
} from '../support/test-db.js';

/**
 * The whole channel path, against a real database and real HTTP receivers: a
 * check fails, the incident opens, a delivery is queued per channel, the
 * delivery loop sends it signed, retries it, and records what happened.
 *
 * Channels and websites are written directly rather than through the API for
 * the reason the monitoring pipeline test gives: the receivers live on
 * loopback, which the API is right to refuse, and the worker's job is to send
 * to what is stored. The loopback exemption is the only thing relaxed, and the
 * last cases prove every other private range is still refused.
 */

const available = await databaseAvailable();

const channelRepository = new ChannelRepository();
const publisher = new ChannelEventPublisher(channelRepository);
const notifications = new NotificationRepository();

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

const DELIVERY_OPTIONS: ChannelDeliveryJobOptions = {
  timeoutMs: 2_000,
  maxAttempts: 3,
  retryBaseSeconds: 30,
  allowLoopback: true,
};

const SECRET = 'so_whsec_integration-test-secret';

let organizationId: Types.ObjectId;
let userId: Types.ObjectId;
const servers: MockServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  if (available) await clearTestDatabase();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Answer {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** A receiver that records every request and answers per attempt. */
async function startReceiver(
  answer: (attempt: number) => Answer = () => ({ status: 200 }),
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = await startMockServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      const reply = answer(received.length);
      response.writeHead(reply.status, reply.headers ?? {});
      response.end(reply.body ?? '');
    });
  });
  servers.push(server);
  return { url: `${server.url}/hook`, received };
}

async function startWebsite(handler: Parameters<typeof startMockServer>[0]): Promise<string> {
  const server = await startMockServer(handler);
  servers.push(server);
  return server.url;
}

async function seedOrganization(plan: Plan = 'starter'): Promise<void> {
  organizationId = new Types.ObjectId();
  userId = new Types.ObjectId();
  await OrganizationModel.create({
    _id: organizationId,
    name: 'Channel Org',
    slug: `channel-org-${organizationId.toHexString()}`,
    plan,
    createdByUserId: userId,
  });
}

async function seedWebsite(url: string, name = 'Acme Store'): Promise<Types.ObjectId> {
  const website = await WebsiteModel.create({
    organizationId,
    name,
    url,
    canonicalKey: url,
    status: 'unknown',
    monitoringEnabled: true,
    monitoringIntervalSeconds: 300,
    requestTimeoutMs: 2_000,
    failureThreshold: 1,
    recoveryThreshold: 1,
    nextCheckAt: new Date(),
  });
  return website._id;
}

async function seedChannel(input: {
  readonly type: ChannelType;
  readonly url: string;
  readonly secret?: string | null;
  readonly events?: readonly ChannelEvent[];
  readonly enabled?: boolean;
  readonly metadata?: Record<string, string>;
  readonly sealedFor?: string;
}): Promise<Types.ObjectId> {
  const context = input.sealedFor ?? organizationId.toHexString();
  const channel = await NotificationChannelModel.create({
    organizationId,
    name: `${input.type} ${new Types.ObjectId().toHexString()}`,
    type: input.type,
    enabled: input.enabled ?? true,
    events: [...(input.events ?? CHANNEL_EVENTS)],
    urlCiphertext: sealSecret(input.url, context),
    targetPreview: 'http://127.0.0.1/…',
    secretCiphertext: input.secret ? sealSecret(input.secret, context) : null,
    metadata: input.metadata ?? {},
    createdByUserId: userId,
  });
  return channel._id;
}

/** One uptime tick, due immediately. */
async function tick(): Promise<void> {
  await WebsiteModel.updateMany({}, { $set: { nextCheckAt: new Date(0), leaseExpiresAt: null } });
  const claimed = await claimBatch({ batchSize: 10, leaseDurationMs: 60_000 });
  await Promise.all(
    claimed.map((website) =>
      runMonitoringJob(website, JOB_OPTIONS, {
        emailService: new EmailService(),
        notifications,
        channels: publisher,
        plans: new PlanLookup(0),
      }),
    ),
  );
}

/** One pass of the delivery loop. */
async function deliverDue(options: ChannelDeliveryJobOptions = DELIVERY_OPTIONS): Promise<void> {
  const claimed = await claimDeliveryBatch({ batchSize: 10, leaseDurationMs: 30_000 });
  await Promise.all(
    claimed.map((delivery) =>
      runChannelDelivery(delivery, options, { channels: channelRepository }),
    ),
  );
}

/** Pulls every scheduled retry forward, since a test cannot wait out a backoff. */
async function makeRetriesDue(): Promise<void> {
  await ChannelDeliveryModel.updateMany(
    { status: 'pending' },
    { $set: { nextAttemptAt: new Date(0) } },
  ).exec();
}

/** Verifies a signature exactly as docs/API.md tells a receiver to. */
function signatureVerifies(header: string | string[] | undefined, body: string): boolean {
  if (typeof header !== 'string') return false;
  const parts = new Map(header.split(',').map((part) => part.split('=') as [string, string]));
  const timestamp = Number(parts.get('t'));
  if (Math.abs(Date.now() / 1000 - timestamp) > WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = createHmac('sha256', SECRET)
    .update(`${String(timestamp)}.${body}`)
    .digest();
  const received = Buffer.from(parts.get('v1') ?? '', 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

describe.skipIf(!available)('dispatching an outage to channels', () => {
  it('queues one delivery per channel, then sends it signed', async () => {
    await seedOrganization();
    const websiteUrl = await startWebsite(handlers.status(503));
    await seedWebsite(websiteUrl);
    const receiver = await startReceiver();
    const channelId = await seedChannel({
      type: 'webhook',
      url: receiver.url,
      secret: SECRET,
      metadata: { environment: 'production' },
    });

    await tick();

    const queued = await ChannelDeliveryModel.find({ channelId }).lean().exec();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ event: 'website.down', status: 'pending', attemptCount: 0 });

    await deliverDue();

    expect(receiver.received).toHaveLength(1);
    const [request] = receiver.received;
    const body = JSON.parse(request?.body ?? '{}') as WebhookBody;

    expect(request?.headers['x-siteops-event']).toBe('website.down');
    expect(request?.headers['x-siteops-delivery']).toBe(queued[0]?._id.toHexString());
    expect(request?.headers['user-agent']).toContain('SiteOpsWebhooks');
    expect(signatureVerifies(request?.headers['x-siteops-signature'], request?.body ?? '')).toBe(
      true,
    );

    expect(body.type).toBe('website.down');
    expect(body.organizationId).toBe(organizationId.toHexString());
    expect(body.data.website?.name).toBe('Acme Store');
    expect(body.data.incident).toMatchObject({ status: 'open', lastStatusCode: 503 });
    expect(body.metadata).toEqual({ environment: 'production' });

    const delivered = await ChannelDeliveryModel.findById(queued[0]?._id).lean().exec();
    expect(delivered).toMatchObject({ status: 'delivered', attemptCount: 1, responseStatus: 200 });
    expect(delivered?.leaseExpiresAt).toBeNull();

    const channel = await NotificationChannelModel.findById(channelId).lean().exec();
    expect(channel).toMatchObject({ lastDeliveryStatus: 'delivered', consecutiveFailures: 0 });
  });

  it('says nothing more while the site stays down, and once when it recovers', async () => {
    await seedOrganization();
    let healthy = false;
    const websiteUrl = await startWebsite((_request, response) => {
      response.writeHead(healthy ? 200 : 503);
      response.end();
    });
    await seedWebsite(websiteUrl);
    const receiver = await startReceiver();
    await seedChannel({ type: 'webhook', url: receiver.url, secret: SECRET });

    await tick();
    await tick();
    await tick();
    expect(await ChannelDeliveryModel.countDocuments({}).exec()).toBe(1);

    healthy = true;
    await tick();
    await tick();

    await deliverDue();
    const events = receiver.received.map((request) => request.headers['x-siteops-event']);
    expect(events.sort()).toEqual(['website.down', 'website.recovered']);

    const recovered = receiver.received
      .map((request) => JSON.parse(request.body) as WebhookBody)
      .find((body) => body.type === 'website.recovered');
    expect(recovered?.data.incident?.status).toBe('resolved');
    expect(recovered?.data.incident?.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('never queues one transition twice, however often it is published', async () => {
    await seedOrganization();
    const websiteUrl = await startWebsite(handlers.status(500));
    const websiteId = await seedWebsite(websiteUrl);
    const receiver = await startReceiver();
    await seedChannel({ type: 'webhook', url: receiver.url, secret: SECRET });

    await tick();
    const incident = await IncidentModel.findOne({ websiteId }).lean().exec();
    const website = {
      id: websiteId,
      organizationId,
      name: 'Acme Store',
      url: websiteUrl,
    };

    // A replayed job, published again for the same incident.
    expect(await publisher.websiteDown(website, incident!._id)).toBe(0);
    expect(await ChannelDeliveryModel.countDocuments({}).exec()).toBe(1);
  });

  it('only queues the events a channel subscribes to', async () => {
    await seedOrganization();
    const websiteUrl = await startWebsite(handlers.status(503));
    await seedWebsite(websiteUrl);
    const receiver = await startReceiver();
    await seedChannel({ type: 'webhook', url: receiver.url, events: ['website.recovered'] });

    await tick();

    expect(await ChannelDeliveryModel.countDocuments({}).exec()).toBe(0);
  });

  it('skips a disabled channel, and one the plan no longer includes', async () => {
    await seedOrganization();
    let websiteUrl = await startWebsite(handlers.status(503));
    await seedWebsite(websiteUrl);
    const receiver = await startReceiver();
    await seedChannel({ type: 'webhook', url: receiver.url, enabled: false });

    await tick();
    expect(await ChannelDeliveryModel.countDocuments({}).exec()).toBe(0);

    await clearTestDatabase();
    await seedOrganization('free');
    websiteUrl = await startWebsite(handlers.status(503));
    await seedWebsite(websiteUrl);
    await seedChannel({ type: 'webhook', url: receiver.url });

    await tick();
    expect(await ChannelDeliveryModel.countDocuments({}).exec()).toBe(0);
  });

  it('queues a monitor problem for the channels that want one', async () => {
    await seedOrganization();
    const receiver = await startReceiver();
    await seedChannel({ type: 'webhook', url: receiver.url, events: ['monitor.problem'] });

    const websiteId = new Types.ObjectId();
    const incident = await IncidentModel.create({
      organizationId,
      websiteId,
      status: 'open',
      type: 'ssl_expiring',
      category: 'ssl',
      severity: 'warning',
      detail: 'Certificate expires in 6 days',
      startedAt: new Date(),
      failedCheckCount: 1,
    });
    const monitor = {
      id: new Types.ObjectId(),
      organizationId,
      websiteId,
      type: 'ssl',
      websiteName: 'Acme Store',
      websiteUrl: 'https://acme.example.org/',
    } as unknown as ClaimedMonitor;

    await publisher.monitorProblem(
      monitor,
      {
        status: 'warning',
        summary: 'Certificate expires in 6 days',
        data: {},
        findings: [],
      } as never,
      incident._id,
    );
    await deliverDue();

    const body = JSON.parse(receiver.received[0]?.body ?? '{}') as WebhookBody;
    expect(body.type).toBe('monitor.problem');
    expect(body.data.monitor).toEqual({
      type: 'ssl',
      status: 'warning',
      summary: 'Certificate expires in 6 days',
    });
    expect(body.data.incident).toMatchObject({ category: 'ssl', severity: 'warning' });
  });
});

describe.skipIf(!available)('retrying a delivery', () => {
  async function queueOneOutage(answer: (attempt: number) => Answer) {
    await seedOrganization();
    const websiteUrl = await startWebsite(handlers.status(503));
    await seedWebsite(websiteUrl);
    const receiver = await startReceiver(answer);
    const channelId = await seedChannel({ type: 'webhook', url: receiver.url, secret: SECRET });
    await tick();
    return { receiver, channelId };
  }

  it('backs off after a transient failure, then delivers with the same delivery id', async () => {
    const { receiver, channelId } = await queueOneOutage((attempt) =>
      attempt === 1 ? { status: 503, body: 'deploying' } : { status: 200 },
    );

    await deliverDue();

    let delivery = await ChannelDeliveryModel.findOne({ channelId }).lean().exec();
    expect(delivery).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      responseStatus: 503,
      failureReason: 'HTTP 503: deploying',
    });
    expect(delivery?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now() + 25_000);

    // Not due yet: a second pass sends nothing.
    await deliverDue();
    expect(receiver.received).toHaveLength(1);

    // A retry that has not settled is not yet a failure of the channel.
    let channel = await NotificationChannelModel.findById(channelId).lean().exec();
    expect(channel?.consecutiveFailures).toBe(0);

    await makeRetriesDue();
    await deliverDue();

    delivery = await ChannelDeliveryModel.findOne({ channelId }).lean().exec();
    expect(delivery).toMatchObject({ status: 'delivered', attemptCount: 2, failureReason: null });
    expect(receiver.received).toHaveLength(2);
    expect(receiver.received[0]?.headers['x-siteops-delivery']).toBe(
      receiver.received[1]?.headers['x-siteops-delivery'],
    );
    // Signed at send time, so the retry carries a fresh, valid signature.
    expect(
      signatureVerifies(
        receiver.received[1]?.headers['x-siteops-signature'],
        receiver.received[1]?.body ?? '',
      ),
    ).toBe(true);

    channel = await NotificationChannelModel.findById(channelId).lean().exec();
    expect(channel?.lastDeliveryStatus).toBe('delivered');
  });

  it('gives up once the attempt budget is spent, and says so on the channel', async () => {
    const { channelId } = await queueOneOutage(() => ({ status: 500 }));
    const options = { ...DELIVERY_OPTIONS, maxAttempts: 2 };

    await deliverDue(options);
    await makeRetriesDue();
    await deliverDue(options);

    const delivery = await ChannelDeliveryModel.findOne({ channelId }).lean().exec();
    expect(delivery).toMatchObject({ status: 'failed', attemptCount: 2 });
    expect(delivery?.nextAttemptAt).toBeNull();

    const channel = await NotificationChannelModel.findById(channelId).lean().exec();
    expect(channel).toMatchObject({
      lastDeliveryStatus: 'failed',
      consecutiveFailures: 1,
      lastFailureReason: 'HTTP 500',
    });
  });

  it('does not retry a request the receiver will never accept', async () => {
    const { receiver, channelId } = await queueOneOutage(() => ({
      status: 404,
      body: 'no_service',
    }));

    await deliverDue();
    await makeRetriesDue();
    await deliverDue();

    expect(receiver.received).toHaveLength(1);
    const delivery = await ChannelDeliveryModel.findOne({ channelId }).lean().exec();
    expect(delivery).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      failureReason: 'HTTP 404: no_service',
    });
  });
});

describe.skipIf(!available)('Slack and Discord', () => {
  it('renders Block Kit for Slack, escaping what a customer typed, and signs nothing', async () => {
    await seedOrganization();
    const websiteUrl = await startWebsite(handlers.status(503));
    await seedWebsite(websiteUrl, '<!channel> Acme & Co');
    const receiver = await startReceiver();
    await seedChannel({ type: 'slack', url: receiver.url });

    await tick();
    await deliverDue();

    const [request] = receiver.received;
    expect(request?.headers['x-siteops-signature']).toBeUndefined();

    const body = JSON.parse(request?.body ?? '{}') as {
      text: string;
      attachments: {
        color: string;
        blocks: { type: string; text?: { type: string; text: string } }[];
      }[];
    };
    const [header, section] = body.attachments[0]?.blocks ?? [];

    expect(body.attachments[0]?.color).toBe('#DC2626');
    // mrkdwn fields, where a mention would fire, are escaped...
    expect(body.text).toContain('&lt;!channel&gt; Acme &amp; Co');
    expect(section?.text?.text).toContain('&lt;!channel&gt; Acme &amp; Co');
    // ...and the plain_text header, where it cannot, shows the name as typed.
    expect(header?.text?.type).toBe('plain_text');
    expect(header?.text?.text).toContain('<!channel> Acme & Co');
  });

  it('renders a Discord embed that cannot mention anyone', async () => {
    await seedOrganization();
    const websiteUrl = await startWebsite(handlers.status(503));
    await seedWebsite(websiteUrl, '@everyone Acme');
    const receiver = await startReceiver();
    await seedChannel({ type: 'discord', url: receiver.url });

    await tick();
    await deliverDue();

    const body = JSON.parse(receiver.received[0]?.body ?? '{}') as {
      allowed_mentions: { parse: unknown[] };
      embeds: { title: string; color: number }[];
    };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0]?.title).toContain('@everyone Acme is down');
    expect(body.embeds[0]?.color).toBe(0xdc2626);
  });
});

describe.skipIf(!available)('what a delivery refuses to do', () => {
  it('will not send into cloud metadata, whatever the channel stores', async () => {
    await seedOrganization();
    const websiteUrl = await startWebsite(handlers.status(503));
    await seedWebsite(websiteUrl);
    const channelId = await seedChannel({
      type: 'webhook',
      url: 'http://169.254.169.254/latest/meta-data/',
      secret: SECRET,
    });

    await tick();
    await deliverDue();

    const delivery = await ChannelDeliveryModel.findOne({ channelId }).lean().exec();
    expect(delivery).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      failureReason: 'The destination resolves to an address that must not be reached.',
    });
  });

  it('fails, with a reason to act on, when the stored URL cannot be opened', async () => {
    await seedOrganization();
    const websiteUrl = await startWebsite(handlers.status(503));
    await seedWebsite(websiteUrl);
    const receiver = await startReceiver();
    // Sealed for another organization: copied across tenants, it must not open.
    const channelId = await seedChannel({
      type: 'webhook',
      url: receiver.url,
      sealedFor: new Types.ObjectId().toHexString(),
    });

    await tick();
    await deliverDue();

    expect(receiver.received).toHaveLength(0);
    const channel = await NotificationChannelModel.findById(channelId).lean().exec();
    expect(channel?.lastFailureReason).toContain('could not be read');
  });

  it('does not send for a channel deleted after the event was queued', async () => {
    await seedOrganization();
    const websiteUrl = await startWebsite(handlers.status(503));
    await seedWebsite(websiteUrl);
    const receiver = await startReceiver();
    const channelId = await seedChannel({ type: 'webhook', url: receiver.url });

    await tick();
    await NotificationChannelModel.deleteOne({ _id: channelId }).exec();
    await deliverDue();

    expect(receiver.received).toHaveLength(0);
    const delivery = await ChannelDeliveryModel.findOne({ channelId }).lean().exec();
    expect(delivery?.status).toBe('failed');
  });
});
