import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { onboard, type SignedInAccount } from '../support/api.js';
import { databaseAvailable, disconnectTestDatabase } from '../support/test-db.js';

/**
 * The guarantee that matters most in a multi-tenant product: one agency can
 * never reach another's data, and cannot even confirm that a given identifier
 * exists.
 *
 * Asserted end to end because it depends on three things agreeing — the
 * organization header the browser sends, the membership the API resolves from
 * the session, and every repository query being scoped by organization. A unit
 * test on any one of them would still pass if another were wrong.
 */

const available = await databaseAvailable();

let owner: SignedInAccount & { organizationId: string };
let outsider: SignedInAccount & { organizationId: string };
let websiteId = '';
let incidentId = '';

beforeAll(async () => {
  if (!available) return;

  owner = await onboard('tenant-owner');
  outsider = await onboard('tenant-outsider');

  const website = await owner.agent
    .post('/api/websites')
    .set('X-Organization-Id', owner.organizationId)
    .send({ name: 'Owned Site', url: 'https://owned-site.example.org' })
    .expect(201);
  websiteId = (website.body as { data: { id: string } }).data.id;

  // A real incident in the owner's tenant, so "not found" cannot pass merely
  // because there is nothing to find.
  const { IncidentModel } = await import('../../src/models/index.js');
  const incident = await IncidentModel.create({
    organizationId: new Types.ObjectId(owner.organizationId),
    websiteId: new Types.ObjectId(websiteId),
    status: 'open',
    type: 'downtime',
    startedAt: new Date(),
    failedCheckCount: 3,
  });
  incidentId = incident._id.toHexString();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe.skipIf(!available)("another organization's data", () => {
  it('is not listed', async () => {
    const response = await outsider.agent
      .get('/api/websites')
      .set('X-Organization-Id', outsider.organizationId)
      .expect(200);

    expect(response.body.data.items).toHaveLength(0);
  });

  it('is refused when the organization header is forged', async () => {
    // A real session, pointed at an organization this user does not belong to.
    const response = await outsider.agent
      .get('/api/websites')
      .set('X-Organization-Id', owner.organizationId);

    // "Not found", never "forbidden": confirming the id exists but belongs to
    // someone else is an enumeration oracle.
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('reads as not found when a website is addressed directly', async () => {
    const response = await outsider.agent
      .get(`/api/websites/${websiteId}`)
      .set('X-Organization-Id', outsider.organizationId);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('WEBSITE_NOT_FOUND');
  });

  it('cannot be modified through a website id from another tenant', async () => {
    const patch = await outsider.agent
      .patch(`/api/websites/${websiteId}`)
      .set('X-Organization-Id', outsider.organizationId)
      .send({ name: 'Renamed by an outsider' });
    expect(patch.status).toBe(404);

    const remove = await outsider.agent
      .delete(`/api/websites/${websiteId}`)
      .set('X-Organization-Id', outsider.organizationId);
    expect(remove.status).toBe(404);

    const pause = await outsider.agent
      .post(`/api/websites/${websiteId}/pause`)
      .set('X-Organization-Id', outsider.organizationId);
    expect(pause.status).toBe(404);

    // The owner's website is untouched by any of it.
    const stillThere = await owner.agent
      .get(`/api/websites/${websiteId}`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);
    expect(stillThere.body.data.name).toBe('Owned Site');
    expect(stillThere.body.data.monitoringEnabled).toBe(true);
  });

  it('hides monitoring history behind the same boundary', async () => {
    for (const path of [
      `/api/websites/${websiteId}/stats`,
      `/api/websites/${websiteId}/uptime`,
      `/api/websites/${websiteId}/checks`,
    ]) {
      const response = await outsider.agent
        .get(path)
        .set('X-Organization-Id', outsider.organizationId);
      expect(response.status).toBe(404);
    }
  });

  it('hides an incident that exists in another tenant', async () => {
    const response = await outsider.agent
      .get(`/api/incidents/${incidentId}`)
      .set('X-Organization-Id', outsider.organizationId);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('INCIDENT_NOT_FOUND');

    // And the owner can still see it, so the 404 above is about the boundary
    // rather than about a missing document.
    const asOwner = await owner.agent
      .get(`/api/incidents/${incidentId}`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);
    expect(asOwner.body.data.websiteName).toBe('Owned Site');
  });

  it('hides the member list of another organization', async () => {
    const response = await outsider.agent.get(`/api/organizations/${owner.organizationId}/members`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('refuses a request that names no organization at all', async () => {
    const response = await outsider.agent.get('/api/websites');

    // The active organization is never inferred: a request that does not say
    // which tenant it is for is a bug in the caller, not a licence to guess.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a malformed organization id without reaching the database', async () => {
    const response = await outsider.agent
      .get('/api/websites')
      .set('X-Organization-Id', 'not-an-object-id');

    // A 500 here would mean an unhandled cast error, which is both a bad
    // response and a hint about the storage layer.
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ORGANIZATION_NOT_FOUND');
  });
});
