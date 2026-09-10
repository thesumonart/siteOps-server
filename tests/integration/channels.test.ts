import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  CreatedNotificationChannelDto,
  CursorPaginatedResult,
  ChannelDeliveryDto,
  NotificationChannelDto,
} from '../../src/contracts/index.js';
import {
  AuditLogModel,
  NotificationChannelModel,
  OrganizationMemberModel,
} from '../../src/models/index.js';
import { sealSecret } from '../../src/utils/secret-box.js';
import {
  onboard,
  setOrganizationPlan,
  signUpAndVerify,
  type SignedInAccount,
} from '../support/api.js';
import { databaseAvailable, disconnectTestDatabase } from '../support/test-db.js';

/**
 * Notification channels through the real API.
 *
 * The cases that matter most are the ones about what must never happen: a
 * Slack URL echoed back in a response, a signing secret readable twice, a
 * member or another tenant reaching a channel, and a downgraded organization
 * locked out of cleaning up what it had.
 */

const available = await databaseAvailable();

const SLACK_TOKEN = 'abcdefghijklmnopqrstuvwx';
const SLACK_URL = `https://hooks.slack.com/services/T0000/B0000/${SLACK_TOKEN}`;
const DISCORD_URL = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-jkl';
const WEBHOOK_URL = 'https://hooks.example.org/siteops/receive?token=s3cr3t-token-value';

interface Envelope<T> {
  readonly data: T;
}

type Onboarded = SignedInAccount & { organizationId: string };

let agency: Onboarded;
let outsider: Onboarded;
let member: SignedInAccount;

beforeAll(async () => {
  if (!available) return;

  agency = await onboard('channels-agency', { plan: 'agency' });
  outsider = await onboard('channels-outsider', { plan: 'agency' });

  member = await signUpAndVerify('channels-member');
  await OrganizationMemberModel.create({
    organizationId: new Types.ObjectId(agency.organizationId),
    userId: new Types.ObjectId(member.userId),
    role: 'member',
    joinedAt: new Date(),
  });
});

afterAll(async () => {
  await disconnectTestDatabase();
});

async function createChannel(
  account: Onboarded,
  body: Record<string, unknown>,
): Promise<CreatedNotificationChannelDto> {
  const response = await account.agent
    .post('/api/channels')
    .set('X-Organization-Id', account.organizationId)
    .send(body)
    .expect(201);
  return (response.body as Envelope<CreatedNotificationChannelDto>).data;
}

describe.skipIf(!available)('creating a channel', () => {
  it('never returns a Slack URL, and stores it only sealed', async () => {
    const response = await agency.agent
      .post('/api/channels')
      .set('X-Organization-Id', agency.organizationId)
      .send({ name: 'Slack on-call', type: 'slack', url: SLACK_URL })
      .expect(201);

    const { channel, signingSecret } = (response.body as Envelope<CreatedNotificationChannelDto>)
      .data;

    expect(channel).toMatchObject({
      name: 'Slack on-call',
      type: 'slack',
      enabled: true,
      target: 'https://hooks.slack.com/…uvwx',
      hasSigningSecret: false,
      consecutiveFailures: 0,
      lastDeliveryStatus: null,
    });
    expect(signingSecret).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain(SLACK_TOKEN);

    const stored = await NotificationChannelModel.findById(channel.id).lean().exec();
    expect(stored?.urlCiphertext).not.toContain('hooks.slack.com');
    expect(stored?.urlCiphertext).not.toContain(SLACK_TOKEN);
  });

  it('shows a webhook signing secret once, and never again', async () => {
    const { channel, signingSecret } = await createChannel(agency, {
      name: 'Pager webhook',
      type: 'webhook',
      url: WEBHOOK_URL,
      metadata: { environment: 'production' },
    });

    expect(signingSecret).toMatch(/^so_whsec_[A-Za-z0-9_-]{43}$/);
    expect(channel.hasSigningSecret).toBe(true);
    expect(channel.metadata).toEqual({ environment: 'production' });

    const read = await agency.agent
      .get(`/api/channels/${channel.id}`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);
    const list = await agency.agent
      .get('/api/channels')
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);

    for (const body of [read.body, list.body]) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(signingSecret ?? 'unreachable');
      expect(serialized).not.toContain('s3cr3t-token-value');
    }
  });

  it('refuses a URL that is not the kind of channel it claims to be', async () => {
    const response = await agency.agent
      .post('/api/channels')
      .set('X-Organization-Id', agency.organizationId)
      .send({ name: 'Not Slack', type: 'slack', url: DISCORD_URL })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect((response.body.error.fields as { field: string }[]).map((f) => f.field)).toContain(
      'url',
    );
  });

  it('refuses a webhook aimed at a private address', async () => {
    for (const url of [
      'https://169.254.169.254/latest/meta-data/',
      'https://10.1.2.3/hook',
      'https://localhost/hook',
      'http://hooks.example.org/plaintext',
    ]) {
      await agency.agent
        .post('/api/channels')
        .set('X-Organization-Id', agency.organizationId)
        .send({ name: `Refused ${url}`, type: 'webhook', url })
        .expect(400);
    }
  });

  it('refuses a second channel with the same name', async () => {
    await createChannel(agency, { name: 'Discord', type: 'discord', url: DISCORD_URL });

    const response = await agency.agent
      .post('/api/channels')
      .set('X-Organization-Id', agency.organizationId)
      .send({ name: 'Discord', type: 'discord', url: DISCORD_URL })
      .expect(409);

    expect(response.body.error.code).toBe('CHANNEL_NAME_TAKEN');
  });

  it('records who connected it in the audit log', async () => {
    const { channel } = await createChannel(agency, {
      name: 'Audited',
      type: 'slack',
      url: SLACK_URL,
    });

    const entry = await AuditLogModel.findOne({
      organizationId: new Types.ObjectId(agency.organizationId),
      action: 'integration.created',
      targetId: new Types.ObjectId(channel.id),
    })
      .lean()
      .exec();
    expect(entry?.targetLabel).toBe('Audited');
  });
});

describe.skipIf(!available)('what the plan allows', () => {
  it('refuses channels on the free plan', async () => {
    const free = await onboard('channels-free');

    const response = await free.agent
      .post('/api/channels')
      .set('X-Organization-Id', free.organizationId)
      .send({ name: 'Slack', type: 'slack', url: SLACK_URL })
      .expect(403);

    expect(response.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('counts channels against the integration limit', async () => {
    // Professional allows three.
    const starter = await onboard('channels-starter', { plan: 'starter' });
    for (const name of ['One', 'Two', 'Three']) {
      await createChannel(starter, { name, type: 'slack', url: SLACK_URL });
    }

    const response = await starter.agent
      .post('/api/channels')
      .set('X-Organization-Id', starter.organizationId)
      .send({ name: 'Four', type: 'slack', url: SLACK_URL })
      .expect(403);
    expect(response.body.error.code).toBe('PLAN_LIMIT_REACHED');

    const entitlements = await starter.agent
      .get(`/api/organizations/${starter.organizationId}/entitlements`)
      .expect(200);
    expect(entitlements.body.data.usage.integrations).toBe(3);
  });

  it('after a downgrade, still lets an organization see, disable and delete what it had', async () => {
    const downgraded = await onboard('channels-downgraded', { plan: 'starter' });
    const { channel } = await createChannel(downgraded, {
      name: 'Kept',
      type: 'slack',
      url: SLACK_URL,
    });
    await setOrganizationPlan(downgraded.organizationId, 'free');

    const org: [string, string] = ['X-Organization-Id', downgraded.organizationId];

    await downgraded.agent
      .get('/api/channels')
      .set(...org)
      .expect(200);
    await downgraded.agent
      .patch(`/api/channels/${channel.id}`)
      .set(...org)
      .send({ enabled: false })
      .expect(200);

    // Turning it back on is using the feature, which the plan no longer has.
    const reenable = await downgraded.agent
      .patch(`/api/channels/${channel.id}`)
      .set(...org)
      .send({ enabled: true })
      .expect(403);
    expect(reenable.body.error.code).toBe('PLAN_LIMIT_REACHED');

    await downgraded.agent
      .delete(`/api/channels/${channel.id}`)
      .set(...org)
      .expect(204);
  });
});

describe.skipIf(!available)('who can reach a channel', () => {
  it('refuses a member: channels are for admins and owners', async () => {
    const response = await member.agent
      .get('/api/channels')
      .set('X-Organization-Id', agency.organizationId)
      .expect(403);
    expect(response.body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it("reads another organization's channel as not found", async () => {
    const { channel } = await createChannel(agency, {
      name: 'Private',
      type: 'slack',
      url: SLACK_URL,
    });

    for (const [method, path] of [
      ['get', `/api/channels/${channel.id}`],
      ['patch', `/api/channels/${channel.id}`],
      ['delete', `/api/channels/${channel.id}`],
      ['post', `/api/channels/${channel.id}/test`],
      ['post', `/api/channels/${channel.id}/rotate-secret`],
      ['get', `/api/channels/${channel.id}/deliveries`],
    ] as const) {
      const response = await outsider.agent[method](path)
        .set('X-Organization-Id', outsider.organizationId)
        .send({ name: 'Taken over' });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('CHANNEL_NOT_FOUND');
    }

    const stillThere = await NotificationChannelModel.findById(channel.id).lean().exec();
    expect(stillThere?.name).toBe('Private');
  });
});

describe.skipIf(!available)('editing a channel', () => {
  it('judges a new URL by the type the channel already is', async () => {
    const { channel } = await createChannel(agency, {
      name: 'Retargeted',
      type: 'slack',
      url: SLACK_URL,
    });

    const response = await agency.agent
      .patch(`/api/channels/${channel.id}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ url: DISCORD_URL })
      .expect(400);
    expect(response.body.error.fields[0].field).toBe('url');

    const moved = await agency.agent
      .patch(`/api/channels/${channel.id}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ url: 'https://hooks.slack.com/services/T1111/B1111/zyxwvutsrqponmlk' })
      .expect(200);
    expect((moved.body as Envelope<NotificationChannelDto>).data.target).toBe(
      'https://hooks.slack.com/…nmlk',
    );
  });

  it('refuses metadata on a channel that has nowhere to put it', async () => {
    const { channel } = await createChannel(agency, {
      name: 'No metadata',
      type: 'slack',
      url: SLACK_URL,
    });

    await agency.agent
      .patch(`/api/channels/${channel.id}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ metadata: { team: 'ops' } })
      .expect(400);
  });

  it('rotates a webhook secret, and refuses to for Slack', async () => {
    const webhook = await createChannel(agency, {
      name: 'Rotated',
      type: 'webhook',
      url: WEBHOOK_URL,
    });
    const slack = await createChannel(agency, { name: 'Unsigned', type: 'slack', url: SLACK_URL });

    const rotated = await agency.agent
      .post(`/api/channels/${webhook.channel.id}/rotate-secret`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);
    const next = (rotated.body as Envelope<{ signingSecret: string }>).data.signingSecret;
    expect(next).toMatch(/^so_whsec_/);
    expect(next).not.toBe(webhook.signingSecret);

    await agency.agent
      .post(`/api/channels/${slack.channel.id}/rotate-secret`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(400);
  });

  it('deletes a channel', async () => {
    const { channel } = await createChannel(agency, {
      name: 'Gone',
      type: 'slack',
      url: SLACK_URL,
    });

    await agency.agent
      .delete(`/api/channels/${channel.id}`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(204);
    await agency.agent
      .get(`/api/channels/${channel.id}`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(404);
  });
});

describe.skipIf(!available)('testing and the delivery log', () => {
  it('sends a test through the SSRF boundary, which refuses a private destination', async () => {
    const { channel } = await createChannel(agency, {
      name: 'Rebound',
      type: 'webhook',
      url: WEBHOOK_URL,
    });

    // A stored URL that somehow points inward — written directly, since the
    // API would never accept it — is still refused at send time.
    await NotificationChannelModel.updateOne(
      { _id: new Types.ObjectId(channel.id) },
      { $set: { urlCiphertext: sealSecret('http://127.0.0.1:9/hook', agency.organizationId) } },
    ).exec();

    const response = await agency.agent
      .post(`/api/channels/${channel.id}/test`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);

    expect(response.body.data).toMatchObject({
      delivered: false,
      statusCode: null,
      failureReason: 'The destination resolves to an address that must not be reached.',
    });
  });

  it('pages the delivery log with a cursor', async () => {
    const { channel } = await createChannel(agency, {
      name: 'Quiet',
      type: 'slack',
      url: SLACK_URL,
    });

    const response = await agency.agent
      .get(`/api/channels/${channel.id}/deliveries`)
      .query({ pageSize: 10 })
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);

    expect((response.body as Envelope<CursorPaginatedResult<ChannelDeliveryDto>>).data).toEqual({
      items: [],
      pagination: { nextCursor: null, hasNextPage: false, pageSize: 10 },
    });
  });
});
