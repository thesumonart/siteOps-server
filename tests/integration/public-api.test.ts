import { createHash } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  API_KEY_SCOPES,
  type ApiKeyScope,
  type IssuedApiKeyDto,
} from '../../src/contracts/index.js';
import { resetApiKeyRateLimiter } from '../../src/middlewares/api-key.middleware.js';
import { resetRateLimiter } from '../../src/middlewares/rate-limit.middleware.js';
import {
  ApiKeyModel,
  ApiUsageModel,
  AuditLogModel,
  IncidentModel,
  OrganizationMemberModel,
} from '../../src/models/index.js';
import {
  client,
  onboard,
  setOrganizationPlan,
  signUpAndVerify,
  type SignedInAccount,
} from '../support/api.js';
import { databaseAvailable, disconnectTestDatabase } from '../support/test-db.js';

/**
 * API keys and the public API, through the real application.
 *
 * The cases that matter most are the ones about what must not happen: a key
 * readable after it was issued, a session cookie accepted where only a key
 * should be, a read-only key writing, one organization's key reaching
 * another's data, and a quota that is not actually enforced.
 */

const available = await databaseAvailable();

type Onboarded = SignedInAccount & { organizationId: string };

interface Envelope<T> {
  readonly data: T;
}

let agency: Onboarded;
let outsider: Onboarded;
let agencyWebsiteId = '';
let outsiderWebsiteId = '';
let fullKey = '';
let outsiderKey = '';

beforeEach(() => {
  resetRateLimiter();
  resetApiKeyRateLimiter();
});

async function createWebsite(account: Onboarded, name: string, url: string): Promise<string> {
  const response = await account.agent
    .post('/api/websites')
    .set('X-Organization-Id', account.organizationId)
    .send({ name, url })
    .expect(201);
  return (response.body as Envelope<{ id: string }>).data.id;
}

async function issueKey(
  account: Onboarded,
  scopes: readonly ApiKeyScope[] = API_KEY_SCOPES,
  extra: Record<string, unknown> = {},
): Promise<IssuedApiKeyDto> {
  const response = await account.agent
    .post('/api/api-keys')
    .set('X-Organization-Id', account.organizationId)
    .send({ name: `Key ${new Types.ObjectId().toHexString()}`, scopes, ...extra })
    .expect(201);
  return (response.body as Envelope<IssuedApiKeyDto>).data;
}

function withKey(token: string) {
  const agent = client();
  return {
    get: (path: string) => agent.get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string) => agent.post(path).set('Authorization', `Bearer ${token}`),
    patch: (path: string) => agent.patch(path).set('Authorization', `Bearer ${token}`),
    delete: (path: string) => agent.delete(path).set('Authorization', `Bearer ${token}`),
  };
}

beforeAll(async () => {
  if (!available) return;

  agency = await onboard('api-agency', { plan: 'agency' });
  outsider = await onboard('api-outsider', { plan: 'agency' });

  agencyWebsiteId = await createWebsite(agency, 'Agency Site', 'https://agency-api.example.org');
  outsiderWebsiteId = await createWebsite(
    outsider,
    'Outsider Site',
    'https://outsider-api.example.org',
  );

  fullKey = (await issueKey(agency)).token;
  outsiderKey = (await issueKey(outsider)).token;
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe.skipIf(!available)('issuing a key', () => {
  it('shows the key exactly once, and stores only its hash', async () => {
    const { apiKey, token } = await issueKey(agency, ['monitors:read']);

    expect(token).toMatch(/^so_live_[A-Za-z0-9_-]{43}$/);
    expect(apiKey).toMatchObject({
      prefix: token.slice(0, 16),
      scopes: ['monitors:read'],
      status: 'active',
      lastUsedAt: null,
      expiresAt: null,
    });

    const list = await agency.agent
      .get('/api/api-keys')
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);
    expect(JSON.stringify(list.body)).not.toContain(token);

    const stored = await ApiKeyModel.findById(apiKey.id).lean().exec();
    expect(stored?.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('records who issued it', async () => {
    const { apiKey } = await issueKey(agency, ['monitors:read']);

    const entry = await AuditLogModel.findOne({
      action: 'api_key.created',
      targetId: new Types.ObjectId(apiKey.id),
    })
      .lean()
      .exec();
    expect(entry?.actorName).toBe(agency.account.name);
  });

  it('is not available on a plan without API access', async () => {
    const starter = await onboard('api-starter', { plan: 'starter' });

    const response = await starter.agent
      .post('/api/api-keys')
      .set('X-Organization-Id', starter.organizationId)
      .send({ name: 'Nope', scopes: ['monitors:read'] })
      .expect(403);
    expect(response.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('is not open to members', async () => {
    const member = await signUpAndVerify('api-member');
    await OrganizationMemberModel.create({
      organizationId: new Types.ObjectId(agency.organizationId),
      userId: new Types.ObjectId(member.userId),
      role: 'member',
      joinedAt: new Date(),
    });

    const response = await member.agent
      .get('/api/api-keys')
      .set('X-Organization-Id', agency.organizationId)
      .expect(403);
    expect(response.body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('counts only live keys against the plan limit', async () => {
    // Agency allows five.
    const capped = await onboard('api-capped', { plan: 'agency' });
    const keys: IssuedApiKeyDto[] = [];
    for (let index = 0; index < 5; index += 1) keys.push(await issueKey(capped, ['monitors:read']));

    const refused = await capped.agent
      .post('/api/api-keys')
      .set('X-Organization-Id', capped.organizationId)
      .send({ name: 'Sixth', scopes: ['monitors:read'] })
      .expect(403);
    expect(refused.body.error.code).toBe('PLAN_LIMIT_REACHED');

    // A revoked key frees its slot.
    await capped.agent
      .delete(`/api/api-keys/${keys[0]?.apiKey.id ?? ''}`)
      .set('X-Organization-Id', capped.organizationId)
      .expect(204);
    await issueKey(capped, ['monitors:read']);
  });
});

describe.skipIf(!available)('rotating, revoking and expiring a key', () => {
  it('rotates: the new secret works and the old one stops at once', async () => {
    const issued = await issueKey(agency, ['monitors:read']);
    await withKey(issued.token).get('/api/v1/monitors').expect(200);

    const rotated = await agency.agent
      .post(`/api/api-keys/${issued.apiKey.id}/rotate`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);
    const next = (rotated.body as Envelope<IssuedApiKeyDto>).data;

    expect(next.apiKey.id).toBe(issued.apiKey.id);
    expect(next.token).not.toBe(issued.token);
    await withKey(issued.token).get('/api/v1/monitors').expect(401);
    await withKey(next.token).get('/api/v1/monitors').expect(200);
  });

  it('revokes, idempotently, and the key stops working', async () => {
    const issued = await issueKey(agency, ['monitors:read']);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await agency.agent
        .delete(`/api/api-keys/${issued.apiKey.id}`)
        .set('X-Organization-Id', agency.organizationId)
        .expect(204);
    }

    await withKey(issued.token).get('/api/v1/monitors').expect(401);
    expect(
      await AuditLogModel.countDocuments({
        action: 'api_key.revoked',
        targetId: new Types.ObjectId(issued.apiKey.id),
      }).exec(),
    ).toBe(1);

    // A revoked key cannot be brought back by rotating it.
    await agency.agent
      .post(`/api/api-keys/${issued.apiKey.id}/rotate`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(409);
  });

  it('stops working when it expires', async () => {
    const issued = await issueKey(agency, ['monitors:read'], { expiresInDays: 30 });
    expect(issued.apiKey.expiresAt).not.toBeNull();

    await ApiKeyModel.updateOne(
      { _id: new Types.ObjectId(issued.apiKey.id) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    ).exec();

    await withKey(issued.token).get('/api/v1/monitors').expect(401);
    const list = await agency.agent
      .get('/api/api-keys')
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);
    const listed = (list.body as Envelope<{ items: { id: string; status: string }[] }>).data.items;
    expect(listed.find((key) => key.id === issued.apiKey.id)?.status).toBe('expired');
  });
});

describe.skipIf(!available)('authenticating to the public API', () => {
  it('refuses a request with no key, and says how to send one', async () => {
    const response = await client().get('/api/v1/monitors').expect(401);

    expect(response.body.error.code).toBe('API_KEY_INVALID');
    expect(response.headers['www-authenticate']).toContain('Bearer');
  });

  it('refuses anything that is not a live key, identically', async () => {
    for (const token of ['nonsense', `so_live_${'x'.repeat(43)}`, fullKey.slice(0, -1)]) {
      const response = await withKey(token).get('/api/v1/monitors').expect(401);
      expect(response.body.error.code).toBe('API_KEY_INVALID');
    }
  });

  it('never accepts a session cookie in place of a key', async () => {
    // A signed-in admin's browser must not be able to call the public API for
    // them from somebody else's page.
    const response = await agency.agent
      .get('/api/v1/monitors')
      .set('X-Organization-Id', agency.organizationId)
      .expect(401);
    expect(response.body.error.code).toBe('API_KEY_INVALID');
  });

  it('answers in the same envelope as the rest of the API', async () => {
    const response = await withKey(fullKey).get('/api/v1/monitors').expect(200);

    expect(Object.keys(response.body).sort()).toEqual(['data', 'success']);
    expect(response.body.data.items.map((item: { id: string }) => item.id)).toEqual([
      agencyWebsiteId,
    ]);
  });
});

describe.skipIf(!available)('what a key can reach', () => {
  it("never reaches another organization's data, whatever the request says", async () => {
    const response = await withKey(fullKey)
      .get(`/api/v1/monitors/${outsiderWebsiteId}`)
      .set('X-Organization-Id', outsider.organizationId)
      .expect(404);
    expect(response.body.error.code).toBe('WEBSITE_NOT_FOUND');

    const own = await withKey(outsiderKey).get('/api/v1/monitors').expect(200);
    expect(own.body.data.items.map((item: { id: string }) => item.id)).toEqual([outsiderWebsiteId]);
  });

  it('refuses a route whose scope the key does not carry', async () => {
    const { token } = await issueKey(agency, ['monitors:read']);

    await withKey(token).get('/api/v1/monitors').expect(200);

    for (const [method, path] of [
      ['post', '/api/v1/monitors'],
      ['get', '/api/v1/incidents'],
      ['get', `/api/v1/monitors/${agencyWebsiteId}/checks`],
      ['get', '/api/v1/metrics/summary'],
    ] as const) {
      const response = await withKey(token)[method](path).send({});
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('INSUFFICIENT_SCOPE');
    }
  });

  it('creates, pauses and deletes a monitor, and the audit log names the key', async () => {
    const created = await withKey(fullKey)
      .post('/api/v1/monitors')
      .send({ name: 'Created by API', url: 'https://created-by-api.example.org' })
      .expect(201);
    const id = (created.body as Envelope<{ id: string }>).data.id;

    const paused = await withKey(fullKey).post(`/api/v1/monitors/${id}/pause`).expect(200);
    expect(paused.body.data.monitoringEnabled).toBe(false);

    await withKey(fullKey).delete(`/api/v1/monitors/${id}`).expect(204);

    const entry = await AuditLogModel.findOne({
      action: 'website.created',
      targetId: new Types.ObjectId(id),
    })
      .lean()
      .exec();
    expect(entry?.actorName).toMatch(/^API key “Key [0-9a-f]{24}”$/);
  });

  it('validates input exactly as the dashboard does', async () => {
    const response = await withKey(fullKey)
      .post('/api/v1/monitors')
      .send({ name: 'Internal', url: 'http://169.254.169.254/' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('reads checks, metrics and incidents, and resolves an incident', async () => {
    const incident = await IncidentModel.create({
      organizationId: new Types.ObjectId(agency.organizationId),
      websiteId: new Types.ObjectId(agencyWebsiteId),
      status: 'open',
      type: 'downtime',
      startedAt: new Date(),
      failedCheckCount: 3,
    });
    const incidentId = incident._id.toHexString();
    const key = withKey(fullKey);

    const checks = await key.get(`/api/v1/monitors/${agencyWebsiteId}/checks`).expect(200);
    expect(checks.body.data.pagination).toMatchObject({ hasNextPage: false });

    const stats = await key
      .get(`/api/v1/monitors/${agencyWebsiteId}/stats`)
      .query({ range: '7d' })
      .expect(200);
    expect(stats.body.data).toMatchObject({ range: '7d', totalChecks: 0 });

    await key.get(`/api/v1/monitors/${agencyWebsiteId}/uptime`).expect(200);
    const summary = await key.get('/api/v1/metrics/summary').expect(200);
    expect(summary.body.data.openIncidents).toBeGreaterThanOrEqual(1);

    const listed = await key.get('/api/v1/incidents').query({ status: 'open' }).expect(200);
    expect(listed.body.data.items.map((item: { id: string }) => item.id)).toContain(incidentId);

    const resolved = await key.post(`/api/v1/incidents/${incidentId}/resolve`).expect(200);
    expect(resolved.body.data.status).toBe('resolved');
  });
});

describe.skipIf(!available)('budgets', () => {
  it('limits each key per minute, independently of other keys', async () => {
    // An organization of its own: the shared one is at its plan's key limit
    // by the time this runs.
    const limited = await onboard('api-rate', { plan: 'agency' });
    const busy = withKey((await issueKey(limited, ['monitors:read'])).token);
    const quiet = withKey((await issueKey(limited, ['monitors:read'])).token);

    for (let request = 0; request < 120; request += 1) {
      await busy.get('/api/v1/monitors').expect(200);
    }
    const refused = await busy.get('/api/v1/monitors').expect(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');
    expect(refused.headers['retry-after']).toBeDefined();

    // Another key of the same organization is unaffected.
    await quiet.get('/api/v1/monitors').expect(200);
  });

  it("enforces the plan's daily quota, and says when it resets", async () => {
    const quota = await onboard('api-quota', { plan: 'agency' });
    const { token } = await issueKey(quota, ['monitors:read']);

    const first = await withKey(token).get('/api/v1/monitors').expect(200);
    expect(first.headers['x-quota-limit']).toBe('20000');
    expect(first.headers['x-quota-remaining']).toBe('19999');

    const today = new Date();
    await ApiUsageModel.updateOne(
      {
        organizationId: new Types.ObjectId(quota.organizationId),
        day: today.toISOString().slice(0, 10),
      },
      { $set: { requests: 20_000 } },
    ).exec();

    const refused = await withKey(token).get('/api/v1/monitors').expect(429);
    expect(refused.body.error.code).toBe('API_QUOTA_EXCEEDED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

    const entitlements = await quota.agent
      .get(`/api/organizations/${quota.organizationId}/entitlements`)
      .expect(200);
    expect(entitlements.body.data.usage.apiRequestsToday).toBe(20_001);
    expect(entitlements.body.data.usage.apiKeys).toBe(1);
  });

  it('stops every key after a downgrade, without deleting them', async () => {
    const downgraded = await onboard('api-downgraded', { plan: 'agency' });
    const { token } = await issueKey(downgraded, ['monitors:read']);
    await setOrganizationPlan(downgraded.organizationId, 'starter');

    const response = await withKey(token).get('/api/v1/monitors').expect(403);
    expect(response.body.error.code).toBe('PLAN_LIMIT_REACHED');

    const list = await downgraded.agent
      .get('/api/api-keys')
      .set('X-Organization-Id', downgraded.organizationId)
      .expect(200);
    expect(list.body.data.items).toHaveLength(1);
  });
});
