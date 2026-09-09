import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_NOTIFICATION_PREFERENCES, PREFERENCE_FIELDS } from '../../src/contracts/index.js';
import { IncidentModel, WebsiteCheckModel } from '../../src/models/index.js';
import { onboard, type SignedInAccount } from '../support/api.js';
import { databaseAvailable, disconnectTestDatabase } from '../support/test-db.js';

/**
 * Every call `siteOps-client` makes, answered by this API.
 *
 * This file is the compatibility checklist. The dashboard is a separate
 * repository and a separate deployment, so nothing in a normal build catches a
 * renamed field or a moved route until a screen breaks in front of someone.
 * Each case below is copied from a real call site in `siteOps-client/src/lib`,
 * with the path, the method and the shape the caller destructures.
 *
 * A failure here means the dashboard is broken, not that a test is out of date.
 */

const available = await databaseAvailable();

let account: SignedInAccount & { organizationId: string };
let websiteId = '';
let incidentId = '';

beforeAll(async () => {
  if (!available) return;

  account = await onboard('contract');

  const website = await account.agent
    .post('/api/websites')
    .set('X-Organization-Id', account.organizationId)
    .send({ name: 'Contract Site', url: 'https://contract-site.example.org' })
    .expect(201);
  websiteId = (website.body as { data: { id: string } }).data.id;

  // Real recorded data, so the read endpoints return populated shapes rather
  // than empty ones that would hide a renamed field.
  await WebsiteCheckModel.create({
    websiteId: new Types.ObjectId(websiteId),
    organizationId: new Types.ObjectId(account.organizationId),
    status: 'up',
    statusCode: 200,
    responseTimeMs: 128,
    checkedAt: new Date(),
    errorType: null,
    errorMessage: null,
    redirectCount: 0,
  });

  const incident = await IncidentModel.create({
    organizationId: new Types.ObjectId(account.organizationId),
    websiteId: new Types.ObjectId(websiteId),
    status: 'resolved',
    type: 'downtime',
    startedAt: new Date(Date.now() - 60_000),
    resolvedAt: new Date(),
    durationSeconds: 60,
    failedCheckCount: 3,
    lastStatusCode: 503,
    lastErrorType: 'http_error',
    lastErrorMessage: 'Responded with HTTP 503.',
  });
  incidentId = incident._id.toHexString();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

function org(): [string, string] {
  return ['X-Organization-Id', account.organizationId];
}

describe.skipIf(!available)('the response envelope siteOps-client parses', () => {
  it('wraps success as { success, data } and nothing else', async () => {
    const response = await account.agent
      .get('/api/websites')
      .set(...org())
      .expect(200);

    /*
     * `apiRequest` in the dashboard reads `payload.success` and returns
     * `payload.data`. A `statusCode` or `message` at the top level would be
     * silently dropped; a different key for the payload would break every
     * screen at once.
     */
    expect(Object.keys(response.body).sort()).toEqual(['data', 'success']);
    expect(response.body.success).toBe(true);
  });

  it('wraps failure as { success, error: { code, message } }', async () => {
    const response = await account.agent
      .get('/api/websites/000000000000000000000000')
      .set(...org())
      .expect(404);

    expect(Object.keys(response.body).sort()).toEqual(['error', 'success']);
    expect(response.body.success).toBe(false);
    // `ApiError.code` is what the dashboard branches on; the message is for
    // humans and may be reworded at any time.
    expect(typeof response.body.error.code).toBe('string');
    expect(typeof response.body.error.message).toBe('string');
  });

  it('carries field errors the dashboard maps onto form controls', async () => {
    const response = await account.agent
      .post('/api/websites')
      .set(...org())
      .send({ name: '', url: 'http://localhost/' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(response.body.error.fields)).toBe(true);
    // `ApiError.fieldErrors` builds `Record<field, message>` from exactly this.
    for (const field of response.body.error.fields as { field: string; message: string }[]) {
      expect(typeof field.field).toBe('string');
      expect(typeof field.message).toBe('string');
    }
    // The names have to match the form controls, so no `body.` prefix.
    expect((response.body.error.fields as { field: string }[]).map((f) => f.field)).toContain(
      'url',
    );
  });
});

describe.skipIf(!available)('every endpoint siteOps-client calls', () => {
  it('GET /api/session — src/lib/auth.ts fetchSession', async () => {
    const response = await account.agent.get('/api/session').expect(200);
    const { user, memberships } = response.body.data;

    expect(user).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      email: expect.any(String),
      emailVerified: expect.any(Boolean),
      createdAt: expect.any(String),
    });
    expect(user.image).toBeNull();
    expect(memberships[0]).toMatchObject({
      organization: expect.any(Object),
      role: expect.any(String),
      permissions: expect.any(Array),
      joinedAt: expect.any(String),
    });
  });

  it('POST /api/organizations — src/lib/organizations.ts createOrganization', async () => {
    const fresh = await onboard('contract-create-org');
    const response = await fresh.agent
      .post('/api/organizations')
      .send({ name: 'Second Org' })
      .expect(201);

    expect(response.body.data.organization).toMatchObject({
      id: expect.any(String),
      name: 'Second Org',
      slug: expect.any(String),
      plan: expect.any(String),
      timezone: expect.any(String),
      websiteCount: expect.any(Number),
      createdAt: expect.any(String),
    });
  });

  it('GET /api/organizations/:id/members — fetchMembers', async () => {
    const response = await account.agent
      .get(`/api/organizations/${account.organizationId}/members`)
      .expect(200);

    // The dashboard destructures `{ members, invitations }`.
    expect(response.body.data).toHaveProperty('members');
    expect(response.body.data).toHaveProperty('invitations');
    expect(response.body.data.members[0]).toMatchObject({
      id: expect.any(String),
      userId: expect.any(String),
      name: expect.any(String),
      email: expect.any(String),
      role: expect.any(String),
      joinedAt: expect.any(String),
    });
  });

  it('GET /api/websites — fetchWebsites, with the 24h rollups the table shows', async () => {
    const response = await account.agent
      .get('/api/websites')
      .query({ page: 1, pageSize: 20, search: 'Contract', status: 'unknown' })
      .set(...org())
      .expect(200);

    expect(response.body.data.pagination).toMatchObject({
      page: expect.any(Number),
      pageSize: expect.any(Number),
      totalItems: expect.any(Number),
      totalPages: expect.any(Number),
      hasNextPage: expect.any(Boolean),
    });

    const row = (response.body.data.items as Record<string, unknown>[])[0];
    expect(row).toBeDefined();
    // `WebsiteSummaryDto` extends `WebsiteDto` with three rollup fields; the
    // table renders all three and they must be present even when null.
    for (const key of ['uptimePercentage24h', 'averageResponseTimeMs24h', 'openIncidentId']) {
      expect(row).toHaveProperty(key);
    }
  });

  it('GET /api/websites/:id — fetchWebsite', async () => {
    const response = await account.agent
      .get(`/api/websites/${websiteId}`)
      .set(...org())
      .expect(200);

    expect(Object.keys(response.body.data).sort()).toEqual(
      [
        // The agency client a website belongs to, or null. Part of the wire
        // shape the dashboard's website detail reads.
        'clientId',
        'createdAt',
        'failureThreshold',
        'id',
        'lastCheckedAt',
        'lastFailedAt',
        'lastResponseTimeMs',
        'lastStatusCode',
        'lastSuccessfulCheckAt',
        'monitoringEnabled',
        'monitoringIntervalSeconds',
        'name',
        'organizationId',
        'recoveryThreshold',
        'requestTimeoutMs',
        'status',
        'updatedAt',
        'url',
      ].sort(),
    );
  });

  it('PATCH /api/websites/:id — updateWebsite', async () => {
    const response = await account.agent
      .patch(`/api/websites/${websiteId}`)
      .set(...org())
      .send({ name: 'Contract Site Renamed' })
      .expect(200);

    expect(response.body.data.name).toBe('Contract Site Renamed');
  });

  it('POST /api/websites/:id/pause and /resume — setWebsiteMonitoring', async () => {
    const paused = await account.agent
      .post(`/api/websites/${websiteId}/pause`)
      .set(...org())
      .expect(200);
    expect(paused.body.data.monitoringEnabled).toBe(false);

    const resumed = await account.agent
      .post(`/api/websites/${websiteId}/resume`)
      .set(...org())
      .expect(200);
    expect(resumed.body.data.monitoringEnabled).toBe(true);
  });

  it('GET /api/dashboard/stats — fetchDashboardStats', async () => {
    const response = await account.agent
      .get('/api/dashboard/stats')
      .set(...org())
      .expect(200);

    expect(Object.keys(response.body.data).sort()).toEqual(
      [
        'averageResponseTimeMs24h',
        'averageUptimePercentage24h',
        'degraded',
        'down',
        'openIncidents',
        'operational',
        'paused',
        'totalWebsites',
        'unknown',
        // Freshness, added with the staleness banner: the newest check across
        // the organization and the shortest interval any website is set to.
        // The dashboard reads both to decide whether these figures are current.
        'lastCheckAt',
        'shortestIntervalSeconds',
      ].sort(),
    );
  });

  it('GET /api/websites/:id/stats?range — fetchWebsiteStats', async () => {
    for (const range of ['24h', '7d', '30d']) {
      const response = await account.agent
        .get(`/api/websites/${websiteId}/stats`)
        .query({ range })
        .set(...org())
        .expect(200);

      expect(response.body.data).toMatchObject({
        range,
        totalChecks: expect.any(Number),
        successfulChecks: expect.any(Number),
        failedChecks: expect.any(Number),
        downtimeSeconds: expect.any(Number),
      });
      expect(response.body.data).toHaveProperty('uptimePercentage');
      expect(response.body.data).toHaveProperty('averageResponseTimeMs');
      expect(response.body.data).toHaveProperty('fastestResponseTimeMs');
      expect(response.body.data).toHaveProperty('slowestResponseTimeMs');
    }
  });

  it('GET /api/websites/:id/uptime?range — fetchWebsiteUptime returns a bare array', async () => {
    const response = await account.agent
      .get(`/api/websites/${websiteId}/uptime`)
      .query({ range: '24h' })
      .set(...org())
      .expect(200);

    // The caller types this as `readonly UptimeBucketDto[]`, not a paginated
    // result — the chart plots `data` directly.
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data[0]).toMatchObject({
      bucketStart: expect.any(String),
      totalChecks: expect.any(Number),
      successfulChecks: expect.any(Number),
    });
  });

  it('GET /api/websites/:id/checks — fetchWebsiteChecks, cursor paginated', async () => {
    const response = await account.agent
      .get(`/api/websites/${websiteId}/checks`)
      .query({ pageSize: 20, status: 'up' })
      .set(...org())
      .expect(200);

    expect(response.body.data.pagination).toMatchObject({
      nextCursor: null,
      hasNextPage: false,
      pageSize: 20,
    });
    expect(response.body.data.items[0]).toMatchObject({
      id: expect.any(String),
      websiteId: expect.any(String),
      status: 'up',
      statusCode: 200,
      responseTimeMs: 128,
      checkedAt: expect.any(String),
      redirectCount: 0,
    });
  });

  it('GET /api/incidents — fetchIncidents, with the website label the row shows', async () => {
    const response = await account.agent
      .get('/api/incidents')
      .query({ pageSize: 20, status: 'resolved', websiteId })
      .set(...org())
      .expect(200);

    expect(response.body.data.items[0]).toMatchObject({
      id: incidentId,
      organizationId: account.organizationId,
      websiteId,
      // Denormalized onto the response, not the document, so a renamed website
      // changes how its past incidents read.
      websiteName: expect.any(String),
      websiteUrl: expect.any(String),
      status: 'resolved',
      type: 'downtime',
      startedAt: expect.any(String),
      resolvedAt: expect.any(String),
      durationSeconds: 60,
      failedCheckCount: 3,
      lastStatusCode: 503,
      lastErrorType: 'http_error',
    });
  });

  it('GET and PATCH /api/notification-settings — fetch/updateNotificationSettings', async () => {
    const initial = await account.agent
      .get('/api/notification-settings')
      .set(...org())
      .expect(200);

    /*
     * Absence of a stored row means "never asked", which defaults to notifying.
     * Compared against the contract's own defaults rather than a literal, so
     * adding a preference does not break this case — but the *shape* is still
     * asserted exactly, which is what the dashboard's settings form depends on.
     */
    expect(initial.body.data.preferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(Object.keys(initial.body.data.preferences).sort()).toEqual(
      [...PREFERENCE_FIELDS].sort(),
    );

    const updated = await account.agent
      .patch('/api/notification-settings')
      .set(...org())
      .send({ websiteRecovered: false })
      .expect(200);

    // A partial patch must not rewrite any field it did not mention.
    expect(updated.body.data.preferences).toEqual({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      websiteRecovered: false,
    });
  });

  it('DELETE /api/websites/:id — deleteWebsite answers 204 with no body', async () => {
    const created = await account.agent
      .post('/api/websites')
      .set(...org())
      .send({ name: 'Disposable', url: 'https://disposable-contract.example.org' })
      .expect(201);

    const response = await account.agent
      .delete(`/api/websites/${created.body.data.id as string}`)
      .set(...org())
      .expect(204);

    // The dashboard short-circuits on 204 before parsing JSON; a body here
    // would be discarded, so sending one is pure waste.
    expect(response.text).toBe('');
  });
});
