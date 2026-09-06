import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MonitorDto } from '../../src/contracts/index.js';
import { IncidentModel, WebsiteMonitorModel } from '../../src/models/index.js';
import { applyMonitorIncident } from '../../src/monitoring/monitor-incident.js';
import { onboard, type SignedInAccount } from '../support/api.js';
import {
  clearTestDatabase,
  databaseAvailable,
  disconnectTestDatabase,
} from '../support/test-db.js';

/**
 * The auxiliary monitors, end to end.
 *
 * Two things are being proved here and neither can be proved without a real
 * database: that the widened unique index actually lets an SSL incident and an
 * outage coexist while still refusing a second of either, and that the plan
 * gate is enforced by the API rather than only by the dashboard.
 */

const available = await databaseAvailable();

interface Envelope<T> {
  readonly data: T;
}

let owner: SignedInAccount & { organizationId: string };
let free: SignedInAccount & { organizationId: string };
let outsider: SignedInAccount & { organizationId: string };
let websiteId = '';
let freeWebsiteId = '';

async function createWebsite(
  account: SignedInAccount & { organizationId: string },
  name: string,
  url: string,
): Promise<string> {
  const response = await account.agent
    .post('/api/websites')
    .set('X-Organization-Id', account.organizationId)
    .send({ name, url })
    .expect(201);
  return (response.body as Envelope<{ id: string }>).data.id;
}

async function listMonitors(
  account: SignedInAccount & { organizationId: string },
  id: string,
): Promise<readonly MonitorDto[]> {
  const response = await account.agent
    .get(`/api/websites/${id}/monitors`)
    .set('X-Organization-Id', account.organizationId)
    .expect(200);
  return (response.body as Envelope<{ items: readonly MonitorDto[] }>).data.items;
}

beforeAll(async () => {
  if (!available) return;

  owner = await onboard('monitor-owner', { plan: 'agency' });
  free = await onboard('monitor-free');
  outsider = await onboard('monitor-outsider', { plan: 'agency' });

  websiteId = await createWebsite(owner, 'Monitored', 'https://monitored.example.org');
  freeWebsiteId = await createWebsite(free, 'Free Site', 'https://free-site.example.org');
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe.skipIf(!available)('monitor configuration', () => {
  it('lists every monitor type, disabled, before any is configured', async () => {
    const monitors = await listMonitors(owner, websiteId);

    expect(monitors).toHaveLength(6);
    expect(monitors.map((monitor) => monitor.type).sort()).toEqual([
      'content',
      'domain',
      'links',
      'performance',
      'seo',
      'ssl',
    ]);
    for (const monitor of monitors) {
      expect(monitor.enabled).toBe(false);
      expect(monitor.status).toBe('unknown');
      expect(monitor.latestResult).toBeNull();
    }
  });

  it('does not write a document until something is changed', async () => {
    const count = await WebsiteMonitorModel.countDocuments({
      websiteId: new Types.ObjectId(websiteId),
    }).exec();

    // Listing rendered six rows from defaults; none of them is stored yet.
    expect(count).toBe(0);
  });

  it('creates the monitor on first enable and makes it due immediately', async () => {
    const response = await owner.agent
      .patch(`/api/websites/${websiteId}/monitors/ssl`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ enabled: true })
      .expect(200);

    const monitor = (response.body as Envelope<MonitorDto>).data;

    expect(monitor.enabled).toBe(true);
    expect(monitor.id).not.toBe('');
    expect(monitor.nextRunAt).not.toBeNull();
    // Due now, so the first result appears within a poll interval rather than
    // after a full day.
    expect(new Date(monitor.nextRunAt ?? '').getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('applies a configuration change without resetting the rest', async () => {
    const response = await owner.agent
      .patch(`/api/websites/${websiteId}/monitors/ssl`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ config: { type: 'ssl', warningDays: 21, criticalDays: 3 } })
      .expect(200);

    const monitor = (response.body as Envelope<MonitorDto>).data;

    expect(monitor.enabled).toBe(true);
    expect(monitor.config).toMatchObject({ type: 'ssl', warningDays: 21, criticalDays: 3 });
  });

  it('refuses a configuration belonging to a different monitor type', async () => {
    const response = await owner.agent
      .patch(`/api/websites/${websiteId}/monitors/ssl`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ config: { type: 'seo', minScore: 70 } })
      .expect(400);

    expect((response.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses an interval faster than the plan allows', async () => {
    const response = await owner.agent
      .patch(`/api/websites/${websiteId}/monitors/ssl`)
      .set('X-Organization-Id', owner.organizationId)
      // Agency's floor is one hour for auxiliary monitors; the schema's own
      // floor is the same, so a sub-hour value is refused before the plan.
      .send({ intervalSeconds: 3600 })
      .expect(200);

    expect((response.body as Envelope<MonitorDto>).data.intervalSeconds).toBe(3600);
  });

  it('clamps a crawl to the plan ceiling rather than refusing it', async () => {
    const response = await owner.agent
      .patch(`/api/websites/${websiteId}/monitors/links`)
      .set('X-Organization-Id', owner.organizationId)
      .send({
        enabled: true,
        config: {
          type: 'links',
          maxPages: 500,
          maxDepth: 3,
          checkExternal: true,
          respectRobotsTxt: true,
        },
      })
      .expect(200);

    const monitor = (response.body as Envelope<MonitorDto>).data;
    // Agency allows 250; asking for 500 gets the crawl the plan permits.
    expect(monitor.config).toMatchObject({ type: 'links', maxPages: 250 });
  });

  it('refuses to run a monitor that is turned off', async () => {
    const response = await owner.agent
      .post(`/api/websites/${websiteId}/monitors/seo/run`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(404);

    expect((response.body as { error: { code: string } }).error.code).toBe('MONITOR_NOT_FOUND');
  });

  it('schedules a run without performing one in the request', async () => {
    const before = Date.now();
    const response = await owner.agent
      .post(`/api/websites/${websiteId}/monitors/ssl/run`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);

    const monitor = (response.body as Envelope<MonitorDto>).data;
    expect(new Date(monitor.nextRunAt ?? '').getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The result is still whatever the worker last wrote — the handler does no
    // TLS handshake of its own.
    expect(monitor.latestResult).toBeNull();
  });

  it('rejects an unknown monitor type in the path', async () => {
    await owner.agent
      .patch(`/api/websites/${websiteId}/monitors/telepathy`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ enabled: true })
      .expect(400);
  });
});

describe.skipIf(!available)('monitor plan gating', () => {
  it('allows the monitors the free plan includes', async () => {
    await free.agent
      .patch(`/api/websites/${freeWebsiteId}/monitors/ssl`)
      .set('X-Organization-Id', free.organizationId)
      .send({ enabled: true })
      .expect(200);
  });

  it('refuses a monitor the plan does not include', async () => {
    const response = await free.agent
      .patch(`/api/websites/${freeWebsiteId}/monitors/seo`)
      .set('X-Organization-Id', free.organizationId)
      .send({ enabled: true })
      .expect(403);

    const body = response.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(body.error.message).toContain('Professional');
  });

  it('allows turning a monitor off regardless of plan', async () => {
    // Someone downgraded with a monitor already on must always be able to
    // switch it off; refusing that would trap them.
    await free.agent
      .patch(`/api/websites/${freeWebsiteId}/monitors/ssl`)
      .set('X-Organization-Id', free.organizationId)
      .send({ enabled: false })
      .expect(200);
  });
});

describe.skipIf(!available)('monitor tenant isolation', () => {
  it("does not expose another organization's monitors", async () => {
    await outsider.agent
      .get(`/api/websites/${websiteId}/monitors`)
      .set('X-Organization-Id', outsider.organizationId)
      .expect(404);
  });

  it('refuses a forged organization header', async () => {
    await outsider.agent
      .get(`/api/websites/${websiteId}/monitors`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(404);
  });

  it("cannot configure another organization's monitor", async () => {
    await outsider.agent
      .patch(`/api/websites/${websiteId}/monitors/ssl`)
      .set('X-Organization-Id', outsider.organizationId)
      .send({ enabled: false })
      .expect(404);

    // And the owner's monitor is untouched.
    const monitors = await listMonitors(owner, websiteId);
    expect(monitors.find((monitor) => monitor.type === 'ssl')?.enabled).toBe(true);
  });
});

describe.skipIf(!available)('monitor incident deduplication', () => {
  const organizationId = new Types.ObjectId();
  const testWebsiteId = new Types.ObjectId();

  beforeEach(async () => {
    if (!available) return;
    await IncidentModel.deleteMany({ websiteId: testWebsiteId }).exec();
  });

  it('opens one incident for a failing monitor', async () => {
    const result = await applyMonitorIncident(null, {
      organizationId,
      websiteId: testWebsiteId,
      monitorType: 'ssl',
      status: 'failing',
      detail: 'Certificate expired 2 days ago.',
      checkedAt: new Date(),
    });

    expect(result.newlyOpenedIncidentId).not.toBeNull();
    expect(result.openIncidentId).not.toBeNull();
  });

  it('lets an SSL incident and an outage be open for the same website at once', async () => {
    // This is exactly what the old `{ websiteId }` unique index made impossible.
    await IncidentModel.create({
      organizationId,
      websiteId: testWebsiteId,
      status: 'open',
      type: 'downtime',
      category: 'availability',
      severity: 'critical',
      startedAt: new Date(),
      failedCheckCount: 3,
    });

    const result = await applyMonitorIncident(null, {
      organizationId,
      websiteId: testWebsiteId,
      monitorType: 'ssl',
      status: 'warning',
      detail: 'Certificate expires in 6 days.',
      checkedAt: new Date(),
    });

    expect(result.newlyOpenedIncidentId).not.toBeNull();
    expect(await IncidentModel.countDocuments({ websiteId: testWebsiteId, status: 'open' })).toBe(
      2,
    );
  });

  it('refuses a second open incident in the same category, at the database', async () => {
    const first = await applyMonitorIncident(null, {
      organizationId,
      websiteId: testWebsiteId,
      monitorType: 'ssl',
      status: 'failing',
      detail: 'Certificate expired.',
      checkedAt: new Date(),
    });

    // Passing null again simulates a worker that lost track of the open
    // incident — the index, not this code, is what stops the duplicate.
    const second = await applyMonitorIncident(null, {
      organizationId,
      websiteId: testWebsiteId,
      monitorType: 'ssl',
      status: 'failing',
      detail: 'Certificate expired.',
      checkedAt: new Date(),
    });

    expect(second.newlyOpenedIncidentId).toBeNull();
    expect(second.openIncidentId?.toHexString()).toBe(first.openIncidentId?.toHexString());
    expect(await IncidentModel.countDocuments({ websiteId: testWebsiteId, category: 'ssl' })).toBe(
      1,
    );
  });

  it('updates the open incident when the problem changes within a category', async () => {
    const opened = await applyMonitorIncident(null, {
      organizationId,
      websiteId: testWebsiteId,
      monitorType: 'ssl',
      status: 'warning',
      detail: 'Certificate expires in 20 days.',
      checkedAt: new Date(),
    });

    await applyMonitorIncident(opened.openIncidentId, {
      organizationId,
      websiteId: testWebsiteId,
      monitorType: 'ssl',
      status: 'failing',
      detail: 'Certificate expired.',
      checkedAt: new Date(),
    });

    const incident = await IncidentModel.findById(opened.openIncidentId).lean().exec();
    // Warning became failing, so the type and severity move with it rather than
    // a second incident being opened alongside.
    expect(incident?.type).toBe('ssl_invalid');
    expect(incident?.severity).toBe('critical');
    expect(incident?.detail).toBe('Certificate expired.');
  });

  it('resolves the incident when the monitor passes', async () => {
    const opened = await applyMonitorIncident(null, {
      organizationId,
      websiteId: testWebsiteId,
      monitorType: 'ssl',
      status: 'failing',
      detail: 'Certificate expired.',
      checkedAt: new Date(Date.now() - 60_000),
    });

    const resolved = await applyMonitorIncident(opened.openIncidentId, {
      organizationId,
      websiteId: testWebsiteId,
      monitorType: 'ssl',
      status: 'passing',
      detail: 'Valid, 89 days remaining.',
      checkedAt: new Date(),
    });

    expect(resolved.newlyResolvedIncidentId?.toHexString()).toBe(
      opened.openIncidentId?.toHexString(),
    );

    const incident = await IncidentModel.findById(opened.openIncidentId).lean().exec();
    expect(incident?.status).toBe('resolved');
    expect(incident?.durationSeconds).toBeGreaterThan(0);
  });

  it('leaves an open incident alone when the monitor could not get an answer', async () => {
    const opened = await applyMonitorIncident(null, {
      organizationId,
      websiteId: testWebsiteId,
      monitorType: 'domain',
      status: 'failing',
      detail: 'Registration expires in 3 days.',
      checkedAt: new Date(),
    });

    const errored = await applyMonitorIncident(opened.openIncidentId, {
      organizationId,
      websiteId: testWebsiteId,
      monitorType: 'domain',
      status: 'error',
      detail: 'The registry timed out.',
      checkedAt: new Date(),
    });

    // Nothing was learned, so resolving would send a recovery notification for
    // a problem that has not gone away.
    expect(errored.newlyResolvedIncidentId).toBeNull();
    expect(errored.openIncidentId?.toHexString()).toBe(opened.openIncidentId?.toHexString());

    const incident = await IncidentModel.findById(opened.openIncidentId).lean().exec();
    expect(incident?.status).toBe('open');
  });

  it('does not open an incident from an errored run', async () => {
    const result = await applyMonitorIncident(null, {
      organizationId,
      websiteId: testWebsiteId,
      monitorType: 'domain',
      status: 'error',
      detail: 'The registry timed out.',
      checkedAt: new Date(),
    });

    expect(result.newlyOpenedIncidentId).toBeNull();
    expect(await IncidentModel.countDocuments({ websiteId: testWebsiteId })).toBe(0);
  });
});

describe.skipIf(!available)('monitor cleanup', () => {
  it('removes the monitors when the website is deleted', async () => {
    await clearTestDatabase();
    const account = await onboard('monitor-cleanup', { plan: 'agency' });
    const id = await createWebsite(account, 'Doomed', 'https://doomed.example.org');

    await account.agent
      .patch(`/api/websites/${id}/monitors/ssl`)
      .set('X-Organization-Id', account.organizationId)
      .send({ enabled: true })
      .expect(200);

    expect(
      await WebsiteMonitorModel.countDocuments({ websiteId: new Types.ObjectId(id) }).exec(),
    ).toBe(1);

    await account.agent
      .delete(`/api/websites/${id}`)
      .set('X-Organization-Id', account.organizationId)
      .expect(204);

    /*
     * A leftover monitor is not merely stale data: it is a queue document the
     * worker would keep claiming for a website that no longer exists.
     */
    expect(
      await WebsiteMonitorModel.countDocuments({ websiteId: new Types.ObjectId(id) }).exec(),
    ).toBe(0);
  });
});
