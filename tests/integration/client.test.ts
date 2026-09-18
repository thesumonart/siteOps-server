import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  ClientDto,
  CursorPaginatedResult,
  DashboardStatsDto,
  IncidentDto,
  MonitorSummaryDto,
  OffsetPaginatedResult,
  ReportDto,
  WebsiteSummaryDto,
} from '../../src/contracts/index.js';
import {
  IncidentModel,
  OrganizationMemberModel,
  ReportModel,
  WebsiteMonitorModel,
} from '../../src/models/index.js';
import { client, onboard, signUpAndVerify, type SignedInAccount } from '../support/api.js';
import { databaseAvailable, disconnectTestDatabase } from '../support/test-db.js';

/**
 * Agency clients and the portal.
 *
 * The cases that matter most are the isolation ones. A client contact is given
 * a window into part of an agency's data, and the two failures that would end
 * the product are a contact seeing another client's websites and a contact
 * seeing the agency itself. Both are asserted directly rather than inferred
 * from the permission table.
 */

const available = await databaseAvailable();

interface Envelope<T> {
  readonly data: T;
}

let agency: SignedInAccount & { organizationId: string };
let otherAgency: SignedInAccount & { organizationId: string };
let free: SignedInAccount & { organizationId: string };

let acmeId = '';
let globexId = '';
let acmeWebsiteId = '';
let globexWebsiteId = '';
let unassignedWebsiteId = '';

/** A signed-in client contact with portal access to Acme. */
let acmeContact: SignedInAccount;

async function createClient(name: string): Promise<ClientDto> {
  const response = await agency.agent
    .post('/api/clients')
    .set('X-Organization-Id', agency.organizationId)
    .send({ name })
    .expect(201);

  return (response.body as Envelope<ClientDto>).data;
}

async function createWebsite(name: string, url: string, clientId: string | null): Promise<string> {
  const created = await agency.agent
    .post('/api/websites')
    .set('X-Organization-Id', agency.organizationId)
    .send({ name, url })
    .expect(201);

  const id = (created.body as Envelope<{ id: string }>).data.id;

  if (clientId !== null) {
    await agency.agent
      .patch(`/api/websites/${id}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ clientId })
      .expect(200);
  }

  return id;
}

/**
 * Grants portal access directly.
 *
 * The invitation flow is exercised separately; this writes the membership so
 * the isolation cases below have a real client session to test with, without
 * re-running the whole accept flow for each.
 */
async function grantPortalAccess(contact: SignedInAccount, clientId: string): Promise<void> {
  await OrganizationMemberModel.create({
    organizationId: new Types.ObjectId(agency.organizationId),
    userId: new Types.ObjectId(contact.userId),
    role: 'client',
    clientId: new Types.ObjectId(clientId),
    joinedAt: new Date(),
  });
}

beforeAll(async () => {
  if (!available) return;

  agency = await onboard('client-agency', { plan: 'agency' });
  otherAgency = await onboard('client-other-agency', { plan: 'agency' });
  free = await onboard('client-free');

  const acme = await createClient('Acme');
  const globex = await createClient('Globex');
  acmeId = acme.id;
  globexId = globex.id;

  acmeWebsiteId = await createWebsite('Acme Site', 'https://acme-site.example.org', acmeId);
  globexWebsiteId = await createWebsite('Globex Site', 'https://globex-site.example.org', globexId);
  unassignedWebsiteId = await createWebsite(
    'Internal Site',
    'https://internal-site.example.org',
    null,
  );

  acmeContact = await signUpAndVerify('client-contact');
  await grantPortalAccess(acmeContact, acmeId);
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe.skipIf(!available)('client management', () => {
  it('lists clients with their website and contact counts', async () => {
    const response = await agency.agent
      .get('/api/clients')
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);

    const clients = (response.body as Envelope<{ items: ClientDto[] }>).data.items;
    const acme = clients.find((entry) => entry.name === 'Acme');

    expect(clients).toHaveLength(2);
    expect(acme?.websiteCount).toBe(1);
    expect(acme?.contactCount).toBe(1);
  });

  it('refuses a duplicate name within one organization', async () => {
    const response = await agency.agent
      .post('/api/clients')
      .set('X-Organization-Id', agency.organizationId)
      .send({ name: 'Acme' })
      .expect(409);

    expect((response.body as { error: { code: string } }).error.code).toBe('CLIENT_NAME_TAKEN');
  });

  it('allows the same client name in a different organization', async () => {
    // Scoped uniqueness: two agencies may both work for a company called Acme.
    await otherAgency.agent
      .post('/api/clients')
      .set('X-Organization-Id', otherAgency.organizationId)
      .send({ name: 'Acme' })
      .expect(201);
  });

  it('filters by status and searches by name', async () => {
    const search = await agency.agent
      .get('/api/clients')
      .set('X-Organization-Id', agency.organizationId)
      .query({ search: 'glob' })
      .expect(200);

    expect((search.body as Envelope<{ items: ClientDto[] }>).data.items).toHaveLength(1);
  });

  it('treats a search term as literal text, not as a pattern', async () => {
    const response = await agency.agent
      .get('/api/clients')
      .set('X-Organization-Id', agency.organizationId)
      .query({ search: '.*' })
      .expect(200);

    expect((response.body as Envelope<{ items: ClientDto[] }>).data.items).toHaveLength(0);
  });

  it('assigns a website to a client', async () => {
    const response = await agency.agent
      .get(`/api/websites/${acmeWebsiteId}`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);

    expect((response.body as Envelope<{ clientId: string | null }>).data.clientId).toBe(acmeId);
  });

  it("refuses to assign a website to another organization's client", async () => {
    const theirs = await otherAgency.agent
      .post('/api/clients')
      .set('X-Organization-Id', otherAgency.organizationId)
      .send({ name: 'Their Client' })
      .expect(201);
    const theirClientId = (theirs.body as Envelope<ClientDto>).data.id;

    const response = await agency.agent
      .patch(`/api/websites/${unassignedWebsiteId}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ clientId: theirClientId })
      .expect(404);

    expect((response.body as { error: { code: string } }).error.code).toBe('CLIENT_NOT_FOUND');
  });

  it('clears an assignment with an explicit null', async () => {
    const response = await agency.agent
      .patch(`/api/websites/${globexWebsiteId}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ clientId: null })
      .expect(200);

    expect((response.body as Envelope<{ clientId: string | null }>).data.clientId).toBeNull();

    // Put it back for the isolation cases below.
    await agency.agent
      .patch(`/api/websites/${globexWebsiteId}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ clientId: globexId })
      .expect(200);
  });

  it('narrows the agency website list by client', async () => {
    const response = await agency.agent
      .get('/api/websites')
      .set('X-Organization-Id', agency.organizationId)
      .query({ clientId: acmeId })
      .expect(200);

    const { items } = (response.body as Envelope<OffsetPaginatedResult<WebsiteSummaryDto>>).data;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(acmeWebsiteId);
  });
});

describe.skipIf(!available)('the client portal', () => {
  it('shows a contact only their own client websites', async () => {
    const response = await acmeContact.agent
      .get('/api/websites')
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);

    const { items } = (response.body as Envelope<OffsetPaginatedResult<WebsiteSummaryDto>>).data;

    // The agency has three websites. The contact sees one.
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(acmeWebsiteId);
  });

  it("cannot open another client's website, even by id", async () => {
    // The scope is part of the query, so this is genuinely not found rather
    // than found-and-refused.
    await acmeContact.agent
      .get(`/api/websites/${globexWebsiteId}`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(404);
  });

  it('cannot open an unassigned website', async () => {
    await acmeContact.agent
      .get(`/api/websites/${unassignedWebsiteId}`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(404);
  });

  it('cannot list the agency clients', async () => {
    // A client must not be able to enumerate the agency's other customers.
    // `client:read` simply does not exist in their role.
    await acmeContact.agent
      .get('/api/clients')
      .set('X-Organization-Id', agency.organizationId)
      .expect(403);
  });

  it('cannot see who works at the agency', async () => {
    await acmeContact.agent
      .get(`/api/organizations/${agency.organizationId}/members`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(403);
  });

  it('cannot read the audit log', async () => {
    await acmeContact.agent
      .get('/api/audit-logs')
      .set('X-Organization-Id', agency.organizationId)
      .expect(403);
  });

  it('cannot add a website', async () => {
    await acmeContact.agent
      .post('/api/websites')
      .set('X-Organization-Id', agency.organizationId)
      .send({ name: 'Sneaky', url: 'https://sneaky.example.org' })
      .expect(403);
  });

  it('cannot edit the website they can see', async () => {
    await acmeContact.agent
      .patch(`/api/websites/${acmeWebsiteId}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ name: 'Renamed by client' })
      .expect(403);
  });

  it('cannot pause monitoring', async () => {
    await acmeContact.agent
      .post(`/api/websites/${acmeWebsiteId}/pause`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(403);
  });

  it('cannot invite anyone', async () => {
    await acmeContact.agent
      .post(`/api/organizations/${agency.organizationId}/members`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ email: 'someone@example.test', role: 'admin' })
      .expect(403);
  });

  it('cannot reach another organization at all', async () => {
    await acmeContact.agent
      .get('/api/websites')
      .set('X-Organization-Id', otherAgency.organizationId)
      .expect(404);
  });

  it('can read the incidents for their own website', async () => {
    await acmeContact.agent
      .get('/api/incidents')
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);
  });
});

/**
 * Everything a client contact can reach that is not a website itself.
 *
 * Websites were always narrowed to the contact's client. Incidents, website
 * statistics, the overview, monitors and reports were not — each read the whole
 * organization — so a contact could list every outage in the agency, take a
 * website id from it, and read that website's checks. Each case below is one of
 * those paths, asserted from the contact's own session.
 */
describe.skipIf(!available)('what a client contact can read', () => {
  let acmeIncidentId = '';
  let globexIncidentId = '';
  let acmeMonitorId = '';
  let globexMonitorId = '';
  const reportIds = { acme: '', globex: '', agencyWide: '', mixed: '' };

  function asAcme(path: string) {
    return acmeContact.agent.get(path).set('X-Organization-Id', agency.organizationId);
  }

  beforeAll(async () => {
    if (!available) return;
    const organizationId = new Types.ObjectId(agency.organizationId);

    const openIncident = async (websiteId: string): Promise<string> => {
      const created = await IncidentModel.create({
        organizationId,
        websiteId: new Types.ObjectId(websiteId),
        status: 'open',
        type: 'downtime',
        category: 'availability',
        startedAt: new Date(),
        failedCheckCount: 3,
      });
      return created._id.toHexString();
    };
    acmeIncidentId = await openIncident(acmeWebsiteId);
    globexIncidentId = await openIncident(globexWebsiteId);
    await openIncident(unassignedWebsiteId);

    const sslMonitor = async (websiteId: string, status: 'passing' | 'failing') => {
      const created = await WebsiteMonitorModel.create({
        organizationId,
        websiteId: new Types.ObjectId(websiteId),
        type: 'ssl',
        enabled: true,
        intervalSeconds: 86_400,
        status,
        config: { type: 'ssl', warningDays: 14 },
      });
      return created._id.toHexString();
    };
    acmeMonitorId = await sslMonitor(acmeWebsiteId, 'passing');
    globexMonitorId = await sslMonitor(globexWebsiteId, 'failing');

    const report = async (title: string, websiteIds: readonly string[]): Promise<string> => {
      const created = await ReportModel.create({
        organizationId,
        type: websiteIds.length === 1 ? 'website' : 'organization',
        title,
        status: 'ready',
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
        websiteIds: websiteIds.map((id) => new Types.ObjectId(id)),
      });
      return created._id.toHexString();
    };
    reportIds.acme = await report('Acme August', [acmeWebsiteId]);
    reportIds.globex = await report('Globex August', [globexWebsiteId]);
    reportIds.agencyWide = await report('Agency August', []);
    reportIds.mixed = await report('Acme and Globex', [acmeWebsiteId, globexWebsiteId]);
  });

  it('lists only incidents on its own websites', async () => {
    const response = await asAcme('/api/incidents?pageSize=100').expect(200);
    const items = (response.body as Envelope<CursorPaginatedResult<IncidentDto>>).data.items;

    expect(items.map((incident) => incident.id)).toContain(acmeIncidentId);
    expect(items.every((incident) => incident.websiteId === acmeWebsiteId)).toBe(true);
  });

  it("cannot filter its way into another client's incidents", async () => {
    const response = await asAcme(`/api/incidents?websiteId=${globexWebsiteId}`).expect(200);
    expect((response.body as Envelope<CursorPaginatedResult<IncidentDto>>).data.items).toEqual([]);
  });

  it("reads another client's incident as not found", async () => {
    await asAcme(`/api/incidents/${acmeIncidentId}`).expect(200);
    const response = await asAcme(`/api/incidents/${globexIncidentId}`).expect(404);
    expect((response.body as { error: { code: string } }).error.code).toBe('INCIDENT_NOT_FOUND');
  });

  it("reads another client's website statistics as not found", async () => {
    for (const path of ['stats?range=24h', 'uptime?range=24h', 'checks']) {
      await asAcme(`/api/websites/${acmeWebsiteId}/${path}`).expect(200);
      await asAcme(`/api/websites/${globexWebsiteId}/${path}`).expect(404);
      await asAcme(`/api/websites/${unassignedWebsiteId}/${path}`).expect(404);
    }
  });

  it("sees the overview of its own websites, not the agency's", async () => {
    const contact = await asAcme('/api/dashboard/stats').expect(200);
    expect((contact.body as Envelope<DashboardStatsDto>).data).toMatchObject({
      totalWebsites: 1,
      openIncidents: 1,
    });

    // The agency's own view is unchanged.
    const agencyView = await agency.agent
      .get('/api/dashboard/stats')
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);
    expect((agencyView.body as Envelope<DashboardStatsDto>).data.openIncidents).toBe(3);
  });

  it('sees monitors, and their results, for its own websites only', async () => {
    const summary = await asAcme('/api/monitors/summary').expect(200);
    const ssl = (summary.body as Envelope<{ items: readonly MonitorSummaryDto[] }>).data.items.find(
      (entry) => entry.type === 'ssl',
    );
    expect(ssl).toMatchObject({ passing: 1, failing: 0 });

    await asAcme(`/api/monitors/${acmeMonitorId}/results`).expect(200);
    const refused = await asAcme(`/api/monitors/${globexMonitorId}/results`).expect(404);
    expect((refused.body as { error: { code: string } }).error.code).toBe('MONITOR_NOT_FOUND');
  });

  it('reads only reports that cover nothing but its own websites', async () => {
    const list = await asAcme('/api/reports?pageSize=100').expect(200);
    const titles = (list.body as Envelope<CursorPaginatedResult<ReportDto>>).data.items.map(
      (report) => report.title,
    );
    expect(titles).toEqual(['Acme August']);

    await asAcme(`/api/reports/${reportIds.acme}`).expect(200);
    for (const id of [reportIds.globex, reportIds.agencyWide, reportIds.mixed]) {
      const response = await asAcme(`/api/reports/${id}`).expect(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('REPORT_NOT_FOUND');
      await asAcme(`/api/reports/${id}/download?format=json`).expect(404);
    }

    // The agency still sees every report.
    const agencyList = await agency.agent
      .get('/api/reports?pageSize=100')
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);
    expect(
      (agencyList.body as Envelope<CursorPaginatedResult<ReportDto>>).data.items.length,
    ).toBeGreaterThanOrEqual(4);
  });
});

describe.skipIf(!available)('portal access management', () => {
  it('invites a contact and shows the invitation as pending', async () => {
    await agency.agent
      .post(`/api/clients/${globexId}/contacts`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ email: 'globex-contact@example.test' })
      .expect(201);

    const response = await agency.agent
      .get(`/api/clients/${globexId}/contacts`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);

    const contacts = (response.body as Envelope<{ items: { email: string; status: string }[] }>)
      .data.items;
    const invited = contacts.find((entry) => entry.email === 'globex-contact@example.test');

    expect(invited?.status).toBe('invited');
  });

  it('refuses to invite somebody who already belongs to the agency', async () => {
    /*
     * The address may belong to an agency admin. Converting their membership
     * into a client-scoped one would lock them out of their own organization,
     * so this is refused rather than silently applied.
     */
    const response = await agency.agent
      .post(`/api/clients/${globexId}/contacts`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ email: agency.account.email })
      .expect(409);

    expect((response.body as { error: { code: string } }).error.code).toBe('ALREADY_A_MEMBER');
  });

  it('revokes access, and the contact immediately loses it', async () => {
    const contacts = await agency.agent
      .get(`/api/clients/${acmeId}/contacts`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);

    const active = (
      contacts.body as Envelope<{ items: { id: string; status: string }[] }>
    ).data.items.find((entry) => entry.status === 'active');
    expect(active).toBeDefined();

    await agency.agent
      .delete(`/api/clients/${acmeId}/contacts/${active?.id ?? ''}`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(204);

    // Revoking is removing the membership, so the next request resolves no
    // membership at all and reads as 404 like any other non-member.
    await acmeContact.agent
      .get('/api/websites')
      .set('X-Organization-Id', agency.organizationId)
      .expect(404);

    // Restore for the archive case below.
    await grantPortalAccess(acmeContact, acmeId);
  });

  it('cannot use the revoke route to remove an internal member', async () => {
    const members = await agency.agent
      .get(`/api/organizations/${agency.organizationId}/members`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);

    const owner = (members.body as Envelope<{ members: { id: string }[] }>).data.members[0];
    expect(owner).toBeDefined();

    // The repository filters on the client role, so an internal membership id
    // simply does not match. Removing a colleague goes through the members
    // routes, which enforce the last-owner rule.
    await agency.agent
      .delete(`/api/clients/${acmeId}/contacts/${owner?.id ?? ''}`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(404);
  });

  it('revokes every contact when the client is archived', async () => {
    await agency.agent
      .patch(`/api/clients/${acmeId}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ status: 'archived' })
      .expect(200);

    // An agency that archives a client expects the portal to close. Expecting
    // them to also remember each contact is how a former client keeps reading
    // a live dashboard for a year.
    await acmeContact.agent
      .get('/api/websites')
      .set('X-Organization-Id', agency.organizationId)
      .expect(404);
  });

  it('refuses to invite a contact to an archived client', async () => {
    await agency.agent
      .post(`/api/clients/${acmeId}/contacts`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ email: 'too-late@example.test' })
      .expect(409);
  });
});

describe.skipIf(!available)('client deletion', () => {
  it('keeps the websites and unassigns them', async () => {
    const doomed = await createClient('Doomed Client');
    const websiteId = await createWebsite(
      'Doomed Site',
      'https://doomed-site.example.org',
      doomed.id,
    );

    await agency.agent
      .delete(`/api/clients/${doomed.id}`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(204);

    // Deleting a client relationship is not asking to stop monitoring their
    // sites, and silently deleting the monitoring would destroy history.
    const response = await agency.agent
      .get(`/api/websites/${websiteId}`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);

    expect((response.body as Envelope<{ clientId: string | null }>).data.clientId).toBeNull();
  });
});

describe.skipIf(!available)('client plan gating and isolation', () => {
  it('refuses clients on a plan that does not include them', async () => {
    const response = await free.agent
      .get('/api/clients')
      .set('X-Organization-Id', free.organizationId)
      .expect(403);

    expect((response.body as { error: { code: string } }).error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it("does not list another organization's clients", async () => {
    const response = await otherAgency.agent
      .get('/api/clients')
      .set('X-Organization-Id', otherAgency.organizationId)
      .expect(200);

    const names = (response.body as Envelope<{ items: ClientDto[] }>).data.items.map(
      (entry) => entry.name,
    );
    expect(names).not.toContain('Globex');
  });

  it("cannot open another organization's client", async () => {
    await otherAgency.agent
      .get(`/api/clients/${globexId}`)
      .set('X-Organization-Id', otherAgency.organizationId)
      .expect(404);
  });

  it('refuses a forged organization header', async () => {
    await otherAgency.agent
      .get('/api/clients')
      .set('X-Organization-Id', agency.organizationId)
      .expect(404);
  });

  it('requires a session', async () => {
    await client().get('/api/clients').set('X-Organization-Id', agency.organizationId).expect(401);
  });
});

describe.skipIf(!available)('a client membership with no client', () => {
  it('is refused as not found rather than seeing the whole organization', async () => {
    const orphan = await signUpAndVerify('client-orphan');

    // A `client` row with no `clientId` would be a contact scoped to nothing.
    // The service refuses to create one; this proves the middleware refuses to
    // *use* one, which is the layer that holds if a row is ever written by
    // something other than the API.
    await OrganizationMemberModel.create({
      organizationId: new Types.ObjectId(agency.organizationId),
      userId: new Types.ObjectId(orphan.userId),
      role: 'client',
      clientId: null,
      joinedAt: new Date(),
    });

    await orphan.agent
      .get('/api/websites')
      .set('X-Organization-Id', agency.organizationId)
      .expect(404);
  });
});
