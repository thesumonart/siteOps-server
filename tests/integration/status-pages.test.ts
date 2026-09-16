import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CUSTOM_DOMAIN_CHALLENGE_PREFIX,
  type PublicStatusPageDto,
  type StatusPageDto,
} from '../../src/contracts/index.js';
import type { TxtLookupResult } from '../../src/integrations/dns-txt.js';
import { resetRateLimiter } from '../../src/middlewares/rate-limit.middleware.js';
import {
  AuditLogModel,
  IncidentModel,
  OrganizationMemberModel,
  StatusPageModel,
  WebsiteCheckModel,
  WebsiteModel,
} from '../../src/models/index.js';
import { AuditLogRepository } from '../../src/repositories/audit-log.repository.js';
import { StatusPageRepository } from '../../src/repositories/status-page.repository.js';
import { AuditService } from '../../src/services/audit.service.js';
import { CustomDomainResolver } from '../../src/services/custom-domain-resolver.js';
import { EntitlementService } from '../../src/services/entitlement.service.js';
import { PublicStatusCache } from '../../src/services/public-status-cache.js';
import { StatusPageService } from '../../src/services/status-page.service.js';
import type { OrganizationContext } from '../../src/types/common.types.js';
import {
  client,
  onboard,
  setOrganizationPlan,
  signUpAndVerify,
  type SignedInAccount,
} from '../support/api.js';
import {
  clearTestDatabase,
  databaseAvailable,
  disconnectTestDatabase,
} from '../support/test-db.js';

/**
 * Status pages, public rendering and custom domains, through the real
 * application.
 *
 * The cases that matter most are about what a stranger must not get: a page
 * before it is published, a page after the plan lapses, anything that
 * identifies or measures the agency's infrastructure, another tenant's
 * website on someone's page, and the dashboard reachable on a customer's
 * domain.
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

beforeEach(() => {
  resetRateLimiter();
});

function uniqueSlug(label: string): string {
  return `${label}-${new Types.ObjectId().toHexString().slice(-8)}`;
}

function uniqueDomain(label: string): string {
  return `${label}-${new Types.ObjectId().toHexString().slice(-8)}.acme-status.com`;
}

async function createWebsite(account: Onboarded, name: string, url: string): Promise<string> {
  const response = await account.agent
    .post('/api/websites')
    .set('X-Organization-Id', account.organizationId)
    .send({ name, url })
    .expect(201);
  return (response.body as Envelope<{ id: string }>).data.id;
}

async function createPage(
  account: Onboarded,
  body: Record<string, unknown>,
  expected = 201,
): Promise<StatusPageDto> {
  const response = await account.agent
    .post('/api/status-pages')
    .set('X-Organization-Id', account.organizationId)
    .send(body)
    .expect(expected);
  return (response.body as Envelope<StatusPageDto>).data;
}

async function readPublic(slug: string, query = ''): Promise<PublicStatusPageDto> {
  const response = await client().get(`/api/public/status-pages/${slug}${query}`).expect(200);
  return (response.body as Envelope<PublicStatusPageDto>).data;
}

function check(websiteId: string, organizationId: string, status: 'up' | 'down', checkedAt: Date) {
  return {
    websiteId: new Types.ObjectId(websiteId),
    organizationId: new Types.ObjectId(organizationId),
    status,
    statusCode: status === 'up' ? 200 : 503,
    responseTimeMs: status === 'up' ? 123 : null,
    checkedAt,
    errorType: status === 'up' ? null : ('http_error' as const),
    errorMessage: status === 'up' ? null : 'Service Unavailable from origin-7.internal',
    redirectCount: 0,
  };
}

beforeAll(async () => {
  if (!available) return;

  // Pro, because these two accumulate more pages and domains across the file
  // than the agency plan allows. Plan limits are exercised on their own accounts.
  agency = await onboard('sp-agency', { plan: 'pro' });
  outsider = await onboard('sp-outsider', { plan: 'pro' });

  agencyWebsiteId = await createWebsite(
    agency,
    'Acme prod (old host)',
    'https://sp-agency.example.org',
  );
  outsiderWebsiteId = await createWebsite(outsider, 'Outsider', 'https://sp-outsider.example.org');
});

afterAll(async () => {
  // The websites made here are due for checking; left behind, a later file's
  // queue claim could pick them up instead of its own.
  if (available) await clearTestDatabase();
  await disconnectTestDatabase();
});

describe.skipIf(!available)('managing a status page', () => {
  it('creates a page unpublished, and records who did', async () => {
    const page = await createPage(agency, {
      title: 'Acme status',
      slug: uniqueSlug('acme'),
      components: [{ websiteId: agencyWebsiteId, displayName: 'Website' }],
    });

    expect(page).toMatchObject({
      published: false,
      customDomain: null,
      components: [{ websiteId: agencyWebsiteId, displayName: 'Website' }],
    });

    const entry = await AuditLogModel.findOne({
      action: 'status_page.created',
      targetId: new Types.ObjectId(page.id),
    })
      .lean()
      .exec();
    expect(entry?.actorName).toBe(agency.account.name);
  });

  it("refuses another organization's website as a component, as not found", async () => {
    const response = await agency.agent
      .post('/api/status-pages')
      .set('X-Organization-Id', agency.organizationId)
      .send({
        title: 'Borrowed',
        slug: uniqueSlug('borrowed'),
        components: [{ websiteId: outsiderWebsiteId, displayName: 'Not mine' }],
      })
      .expect(404);
    expect(response.body.error.code).toBe('WEBSITE_NOT_FOUND');
  });

  it('keeps slugs unique across organizations', async () => {
    const slug = uniqueSlug('shared');
    await createPage(agency, { title: 'First', slug });

    const response = await outsider.agent
      .post('/api/status-pages')
      .set('X-Organization-Id', outsider.organizationId)
      .send({ title: 'Second', slug })
      .expect(409);
    expect(response.body.error.code).toBe('STATUS_PAGE_SLUG_TAKEN');
  });

  it("answers another organization's page as not found", async () => {
    const page = await createPage(agency, { title: 'Private', slug: uniqueSlug('private') });

    const path = `/api/status-pages/${page.id}`;
    for (const send of [
      () => outsider.agent.get(path),
      () => outsider.agent.patch(path).send({ published: true }),
      () => outsider.agent.delete(path),
    ]) {
      const response = await send().set('X-Organization-Id', outsider.organizationId).expect(404);
      expect(response.body.error.code).toBe('STATUS_PAGE_NOT_FOUND');
    }
  });

  it('is not available on the free plan', async () => {
    const free = await onboard('sp-free');
    const response = await free.agent
      .post('/api/status-pages')
      .set('X-Organization-Id', free.organizationId)
      .send({ title: 'Free', slug: uniqueSlug('free') })
      .expect(403);
    expect(response.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it("enforces the plan's page limit", async () => {
    // Starter allows one.
    const starter = await onboard('sp-starter', { plan: 'starter' });
    await createPage(starter, { title: 'One', slug: uniqueSlug('one') });

    const response = await starter.agent
      .post('/api/status-pages')
      .set('X-Organization-Id', starter.organizationId)
      .send({ title: 'Two', slug: uniqueSlug('two') })
      .expect(403);
    expect(response.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('lets members read pages but not change them', async () => {
    const page = await createPage(agency, { title: 'Team', slug: uniqueSlug('team') });
    const member = await signUpAndVerify('sp-member');
    await OrganizationMemberModel.create({
      organizationId: new Types.ObjectId(agency.organizationId),
      userId: new Types.ObjectId(member.userId),
      role: 'member',
      joinedAt: new Date(),
    });

    await member.agent
      .get(`/api/status-pages/${page.id}`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);

    const response = await member.agent
      .patch(`/api/status-pages/${page.id}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ published: true })
      .expect(403);
    expect(response.body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('removes a deleted website from every page that showed it', async () => {
    const websiteId = await createWebsite(agency, 'Short-lived', 'https://sp-short.example.org');
    const page = await createPage(agency, {
      title: 'Cascade',
      slug: uniqueSlug('cascade'),
      components: [
        { websiteId: agencyWebsiteId, displayName: 'Stays' },
        { websiteId, displayName: 'Goes' },
      ],
    });

    await agency.agent
      .delete(`/api/websites/${websiteId}`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(204);

    const stored = await StatusPageModel.findById(page.id).lean().exec();
    expect(stored?.components.map((component) => component.displayName)).toEqual(['Stays']);
  });

  it('can still be unpublished and deleted after the plan lapses', async () => {
    const lapsing = await onboard('sp-lapsing', { plan: 'starter' });
    const page = await createPage(lapsing, {
      title: 'Lapsing',
      slug: uniqueSlug('lapsing'),
      published: true,
    });
    await setOrganizationPlan(lapsing.organizationId, 'free');

    await lapsing.agent
      .patch(`/api/status-pages/${page.id}`)
      .set('X-Organization-Id', lapsing.organizationId)
      .send({ title: 'Renamed' })
      .expect(403);
    await lapsing.agent
      .patch(`/api/status-pages/${page.id}`)
      .set('X-Organization-Id', lapsing.organizationId)
      .send({ published: false })
      .expect(200);
    await lapsing.agent
      .delete(`/api/status-pages/${page.id}`)
      .set('X-Organization-Id', lapsing.organizationId)
      .expect(204);
  });
});

describe.skipIf(!available)('the public page', () => {
  it('does not exist until it is published', async () => {
    const slug = uniqueSlug('draft');
    const page = await createPage(agency, { title: 'Draft', slug });

    const hidden = await client().get(`/api/public/status-pages/${slug}`).expect(404);
    expect(hidden.body.error.code).toBe('STATUS_PAGE_NOT_FOUND');

    await agency.agent
      .patch(`/api/status-pages/${page.id}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ published: true })
      .expect(200);

    await client().get(`/api/public/status-pages/${slug}`).expect(200);
  });

  it('needs no session, and may be read from any origin without credentials', async () => {
    const slug = uniqueSlug('cors');
    await createPage(agency, { title: 'CORS', slug, published: true });

    const response = await client()
      .get(`/api/public/status-pages/${slug}`)
      .set('Origin', 'https://status.some-customer.com')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('reports daily uptime from real checks, floored, with gaps as no data', async () => {
    const websiteId = await createWebsite(agency, 'Uptime', 'https://sp-uptime.example.org');
    const slug = uniqueSlug('uptime');
    await createPage(agency, {
      title: 'Uptime',
      slug,
      published: true,
      components: [{ websiteId, displayName: 'Storefront' }],
    });

    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const twoDaysAgo = new Date(today.getTime() - 2 * 86_400_000);
    await WebsiteCheckModel.insertMany([
      // Two days ago: 2 of 3 up.
      check(websiteId, agency.organizationId, 'up', new Date(twoDaysAgo.getTime() + 60_000)),
      check(websiteId, agency.organizationId, 'up', new Date(twoDaysAgo.getTime() + 120_000)),
      check(websiteId, agency.organizationId, 'down', new Date(twoDaysAgo.getTime() + 180_000)),
      // Today: all up.
      check(websiteId, agency.organizationId, 'up', new Date(today.getTime() + 1_000)),
      // Before the window: must not count.
      check(websiteId, agency.organizationId, 'down', new Date(today.getTime() - 40 * 86_400_000)),
    ]);

    const page = await readPublic(slug, '?days=30');
    expect(page.historyDays).toBe(30);

    const [component] = page.components;
    expect(component?.name).toBe('Storefront');
    expect(component?.history).toHaveLength(30);

    const byDate = new Map(component?.history.map((day) => [day.date, day.uptimePercentage]));
    expect(byDate.get(today.toISOString().slice(0, 10))).toBe(100);
    expect(byDate.get(twoDaysAgo.toISOString().slice(0, 10))).toBe(66.66);
    expect(
      byDate.get(new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10)),
    ).toBeNull();
    expect(component?.history.at(-1)?.date).toBe(today.toISOString().slice(0, 10));

    // 3 of 4 inside the window.
    expect(component?.uptimePercentage).toBe(75);
  });

  it("caps the history at how long the organization's plan keeps checks", async () => {
    const starter = await onboard('sp-retention', { plan: 'starter' });
    const slug = uniqueSlug('retention');
    await createPage(starter, { title: 'Retention', slug, published: true });

    const page = await readPublic(slug, '?days=90');
    expect(page.historyDays).toBe(60);
  });

  it('refuses a history window it does not offer', async () => {
    const slug = uniqueSlug('window');
    await createPage(agency, { title: 'Window', slug, published: true });

    const response = await client().get(`/api/public/status-pages/${slug}?days=45`).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('lists open outages and slowdowns, and keeps every other incident private', async () => {
    const websiteId = await createWebsite(agency, 'Incidents', 'https://sp-incidents.example.org');
    const slug = uniqueSlug('incidents');
    await createPage(agency, {
      title: 'Incidents',
      slug,
      published: true,
      components: [{ websiteId, displayName: 'API' }],
    });
    await WebsiteModel.updateOne({ _id: new Types.ObjectId(websiteId) }, { status: 'down' }).exec();

    const base = {
      organizationId: new Types.ObjectId(agency.organizationId),
      websiteId: new Types.ObjectId(websiteId),
      status: 'open' as const,
      startedAt: new Date(),
    };
    await IncidentModel.create({
      ...base,
      type: 'downtime',
      category: 'availability',
      failedCheckCount: 3,
    });
    await IncidentModel.create({
      ...base,
      type: 'response_time_anomaly',
      category: 'anomaly',
      severity: 'warning',
    });
    await IncidentModel.create({
      ...base,
      type: 'ssl_expiring',
      category: 'ssl',
      severity: 'warning',
    });
    await IncidentModel.create({
      ...base,
      type: 'seo_regression',
      category: 'seo',
      severity: 'info',
    });

    const page = await readPublic(slug);
    expect(page.status).toBe('down');
    expect(page.activeIncidents.map((incident) => incident.kind).sort()).toEqual([
      'degraded',
      'outage',
    ]);
    expect(page.activeIncidents.every((incident) => incident.componentName === 'API')).toBe(true);
  });

  it('never says a website is paused', async () => {
    const websiteId = await createWebsite(agency, 'Paused', 'https://sp-paused.example.org');
    await WebsiteModel.updateOne(
      { _id: new Types.ObjectId(websiteId) },
      { status: 'paused' },
    ).exec();
    const slug = uniqueSlug('blog');
    await createPage(agency, {
      title: 'Blog status',
      slug,
      published: true,
      components: [{ websiteId, displayName: 'Blog' }],
    });

    const page = await readPublic(slug);
    expect(page.components[0]?.status).toBe('unknown');
    expect(JSON.stringify(page)).not.toContain('"paused"');
  });

  it('says nothing that identifies or measures the infrastructure behind it', async () => {
    const slug = uniqueSlug('leak');
    const page = await createPage(agency, {
      title: 'Leak check',
      slug,
      published: true,
      components: [{ websiteId: agencyWebsiteId, displayName: 'Website' }],
    });
    await WebsiteCheckModel.create(
      check(agencyWebsiteId, agency.organizationId, 'down', new Date()),
    );

    const response = await client().get(`/api/public/status-pages/${slug}`).expect(200);
    const body = JSON.stringify(response.body);

    for (const secret of [
      agencyWebsiteId,
      agency.organizationId,
      page.id,
      'sp-agency.example.org',
      'Acme prod (old host)',
      'origin-7.internal',
      'responseTime',
      'statusCode',
      'errorMessage',
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it('comes down when the plan no longer includes status pages', async () => {
    const lapsed = await onboard('sp-lapsed', { plan: 'starter' });
    const slug = uniqueSlug('lapsed');
    await createPage(lapsed, { title: 'Lapsed', slug, published: true });
    await readPublic(slug);

    await setOrganizationPlan(lapsed.organizationId, 'free');

    const response = await client().get(`/api/public/status-pages/${slug}`).expect(404);
    expect(response.body.error.code).toBe('STATUS_PAGE_NOT_FOUND');
  });
});

describe.skipIf(!available)('custom domains', () => {
  async function claim(account: Onboarded, pageId: string, domain: string, expected = 200) {
    return account.agent
      .put(`/api/status-pages/${pageId}/custom-domain`)
      .set('X-Organization-Id', account.organizationId)
      .send({ domain })
      .expect(expected);
  }

  async function markVerified(pageId: string): Promise<void> {
    await StatusPageModel.updateOne(
      { _id: new Types.ObjectId(pageId) },
      { $set: { 'customDomain.verifiedAt': new Date() } },
    ).exec();
  }

  it('issues a pending claim with the DNS record that proves it', async () => {
    const page = await createPage(agency, { title: 'Domain', slug: uniqueSlug('domain') });
    const domain = uniqueDomain('status');

    const response = await claim(agency, page.id, domain.toUpperCase());
    const dto = (response.body as Envelope<StatusPageDto>).data;

    expect(dto.customDomain).toMatchObject({
      domain,
      status: 'pending',
      verifiedAt: null,
      cnameTarget: 'localhost',
      verificationRecord: { type: 'TXT', name: `_siteops-challenge.${domain}` },
    });
    expect(dto.customDomain?.verificationRecord.value).toMatch(
      new RegExp(`^${CUSTOM_DOMAIN_CHALLENGE_PREFIX}[A-Za-z0-9_-]{43}$`),
    );

    // Claiming the same domain again keeps the token the customer may have published.
    const again = await claim(agency, page.id, domain);
    expect((again.body as Envelope<StatusPageDto>).data.customDomain?.verificationRecord).toEqual(
      dto.customDomain?.verificationRecord,
    );
  });

  it('is not available below the agency plan', async () => {
    const starter = await onboard('sp-domain-starter', { plan: 'starter' });
    const page = await createPage(starter, { title: 'Starter', slug: uniqueSlug('starter') });

    const response = await claim(starter, page.id, uniqueDomain('starter'), 403);
    expect(response.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it("refuses one of SiteOps's own hosts", async () => {
    const page = await createPage(agency, { title: 'Own host', slug: uniqueSlug('own') });
    await claim(agency, page.id, 'localhost', 400);
  });

  it('routes nothing until verified, then serves only the public page', async () => {
    const slug = uniqueSlug('routed');
    const page = await createPage(agency, {
      title: 'Routed',
      slug,
      published: true,
      components: [{ websiteId: agencyWebsiteId, displayName: 'Website' }],
    });
    const domain = uniqueDomain('routed');
    await claim(agency, page.id, domain);

    // Pending: the host means nothing.
    const pending = await client().get('/api/public/status-page').set('Host', domain).expect(404);
    expect(pending.body.error.code).toBe('STATUS_PAGE_NOT_FOUND');

    await markVerified(page.id);

    const served = await client().get('/api/public/status-page').set('Host', domain).expect(200);
    expect((served.body as Envelope<PublicStatusPageDto>).data.slug).toBe(slug);

    // The dashboard API and authentication do not exist on a customer's domain.
    for (const path of [
      '/api/session',
      '/api/auth/get-session',
      '/api/status-pages',
      '/api/v1/monitors',
    ]) {
      const refused = await client().get(path).set('Host', domain).expect(404);
      expect(refused.body.error.code).toBe('NOT_FOUND');
    }
    await client()
      .post('/api/auth/sign-in/email')
      .set('Host', domain)
      .send({ email: agency.account.email, password: agency.account.password })
      .expect(404);

    // Nor does the host-routed endpoint name a page anywhere else.
    await client().get('/api/public/status-page').expect(404);
  });

  it('stops routing when the domain is removed or the page unpublished', async () => {
    const page = await createPage(agency, {
      title: 'Removed',
      slug: uniqueSlug('removed'),
      published: true,
    });
    const domain = uniqueDomain('removed');
    await claim(agency, page.id, domain);
    await markVerified(page.id);
    await client().get('/api/public/status-page').set('Host', domain).expect(200);

    await agency.agent
      .patch(`/api/status-pages/${page.id}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ published: false })
      .expect(200);
    await client().get('/api/public/status-page').set('Host', domain).expect(404);

    const removed = await agency.agent
      .delete(`/api/status-pages/${page.id}/custom-domain`)
      .set('X-Organization-Id', agency.organizationId)
      .expect(200);
    expect((removed.body as Envelope<StatusPageDto>).data.customDomain).toBeNull();

    // No longer a custom domain at all, so the dashboard's routes answer as usual.
    await client().get('/api/session').set('Host', domain).expect(200);
  });

  it('stops serving the domain, but not the slug, when the plan drops custom domains', async () => {
    const downgrading = await onboard('sp-domain-downgrade', { plan: 'agency' });
    const slug = uniqueSlug('downgrade');
    const page = await createPage(downgrading, { title: 'Downgrade', slug, published: true });
    const domain = uniqueDomain('downgrade');
    await claim(downgrading, page.id, domain);
    await markVerified(page.id);

    await setOrganizationPlan(downgrading.organizationId, 'starter');

    await client().get('/api/public/status-page').set('Host', domain).expect(404);
    await readPublic(slug);
  });

  it('refuses a domain another organization has already verified', async () => {
    const domain = uniqueDomain('taken');
    const owned = await createPage(outsider, { title: 'Owner', slug: uniqueSlug('owner') });
    await claim(outsider, owned.id, domain);
    await markVerified(owned.id);

    const page = await createPage(agency, { title: 'Latecomer', slug: uniqueSlug('late') });
    const response = await claim(agency, page.id, domain, 409);
    expect(response.body.error.code).toBe('CUSTOM_DOMAIN_TAKEN');
  });
});

describe.skipIf(!available)('verifying a custom domain', () => {
  let answer: TxtLookupResult = { outcome: 'missing' };
  const lookedUp: string[] = [];

  function service(): StatusPageService {
    const repository = new StatusPageRepository();
    const cache = new PublicStatusCache(0);
    return new StatusPageService({
      repository,
      entitlements: new EntitlementService({
        websites: () => Promise.resolve(0),
        members: () => Promise.resolve(0),
        clients: () => Promise.resolve(0),
        statusPages: (organizationId) => repository.countForOrganization(organizationId),
        apiKeys: () => Promise.resolve(0),
        integrations: () => Promise.resolve(0),
        reportSchedules: () => Promise.resolve(0),
        customDomains: (organizationId) => repository.countCustomDomains(organizationId),
        apiRequestsToday: () => Promise.resolve(0),
        aiGenerationsThisMonth: () => Promise.resolve(0),
      }),
      audit: new AuditService(new AuditLogRepository()),
      cache,
      domains: new CustomDomainResolver(repository, cache, ['http://localhost:3000']),
      txtLookup: (name) => {
        lookedUp.push(name);
        return Promise.resolve(answer);
      },
      cnameTarget: 'status.siteops.example',
    });
  }

  function context(account: Onboarded): OrganizationContext {
    return {
      id: account.organizationId,
      objectId: new Types.ObjectId(account.organizationId),
      name: 'Org',
      slug: 'org',
      plan: 'pro',
      role: 'owner',
      permissions: [],
      clientScope: null,
    };
  }

  function actor(account: Onboarded) {
    return { id: account.userId, name: account.account.name, role: 'owner' as const };
  }

  async function pendingPage(account: Onboarded, domain: string): Promise<StatusPageDto> {
    const page = await createPage(account, { title: 'Verify', slug: uniqueSlug('verify') });
    const response = await account.agent
      .put(`/api/status-pages/${page.id}/custom-domain`)
      .set('X-Organization-Id', account.organizationId)
      .send({ domain })
      .expect(200);
    return (response.body as Envelope<StatusPageDto>).data;
  }

  it('verifies when the TXT record carries the token, and records it', async () => {
    const domain = uniqueDomain('verify');
    const page = await pendingPage(agency, domain);
    const expected = page.customDomain?.verificationRecord.value ?? '';

    answer = { outcome: 'found', values: ['v=spf1 -all', expected] };
    const verified = await service().verifyCustomDomain(context(agency), page.id, actor(agency));

    expect(lookedUp.at(-1)).toBe(`_siteops-challenge.${domain}`);
    expect(verified.customDomain?.status).toBe('verified');

    const entry = await AuditLogModel.findOne({
      action: 'custom_domain.verified',
      targetId: new Types.ObjectId(page.id),
    })
      .lean()
      .exec();
    expect(entry?.targetLabel).toBe(domain);

    // Now it routes.
    await agency.agent
      .patch(`/api/status-pages/${page.id}`)
      .set('X-Organization-Id', agency.organizationId)
      .send({ published: true })
      .expect(200);
    await client().get('/api/public/status-page').set('Host', domain).expect(200);
  });

  it("refuses a record carrying some other claim's token", async () => {
    const page = await pendingPage(agency, uniqueDomain('wrong'));

    answer = { outcome: 'found', values: [`${CUSTOM_DOMAIN_CHALLENGE_PREFIX}not-the-token`] };
    await expect(
      service().verifyCustomDomain(context(agency), page.id, actor(agency)),
    ).rejects.toMatchObject({ code: 'CUSTOM_DOMAIN_NOT_VERIFIED' });

    const stored = await StatusPageModel.findById(page.id).lean().exec();
    expect(stored?.customDomain?.verifiedAt).toBeNull();
  });

  it('says so when DNS did not answer, rather than that the record is missing', async () => {
    const page = await pendingPage(agency, uniqueDomain('servfail'));

    answer = { outcome: 'failed' };
    await expect(
      service().verifyCustomDomain(context(agency), page.id, actor(agency)),
    ).rejects.toMatchObject({
      code: 'CUSTOM_DOMAIN_NOT_VERIFIED',
      message: expect.stringContaining('DNS did not answer'),
    });
  });

  it('lets the first organization to prove a contested domain keep it', async () => {
    const domain = uniqueDomain('contested');
    const first = await pendingPage(agency, domain);
    const second = await pendingPage(outsider, domain);

    answer = {
      outcome: 'found',
      values: [
        first.customDomain?.verificationRecord.value ?? '',
        second.customDomain?.verificationRecord.value ?? '',
      ],
    };

    await service().verifyCustomDomain(context(agency), first.id, actor(agency));
    await expect(
      service().verifyCustomDomain(context(outsider), second.id, actor(outsider)),
    ).rejects.toMatchObject({ code: 'CUSTOM_DOMAIN_TAKEN' });
  });
});
