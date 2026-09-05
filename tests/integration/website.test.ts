import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PLAN_LIMITS } from '../../src/contracts/index.js';
import { onboard, type SignedInAccount } from '../support/api.js';
import { databaseAvailable, disconnectTestDatabase } from '../support/test-db.js';

/**
 * Website management, end to end.
 *
 * The URL cases are the point of this file. A monitored URL is the one piece of
 * user input this product turns into an outbound request, so what is accepted
 * here is a security boundary and not just validation.
 */

const available = await databaseAvailable();

let account: SignedInAccount & { organizationId: string };

beforeAll(async () => {
  if (!available) return;
  account = await onboard('websites');
});

afterAll(async () => {
  await disconnectTestDatabase();
});

function api() {
  return account.agent;
}

function orgHeader(): [string, string] {
  return ['X-Organization-Id', account.organizationId];
}

describe.skipIf(!available)('websites', () => {
  it('creates a website with a normalized URL and monitoring defaults', async () => {
    const response = await api()
      .post('/api/websites')
      .set(...orgHeader())
      .send({ name: 'Acme', url: 'acme-test-site.example.org' })
      .expect(201);

    const website = response.body.data;
    // A scheme-less entry is treated as https and stored canonically, so the
    // stored URL and the duplicate-detection key cannot disagree.
    expect(website.url).toBe('https://acme-test-site.example.org/');
    expect(website.status).toBe('unknown');
    expect(website.monitoringEnabled).toBe(true);
    expect(website.monitoringIntervalSeconds).toBe(300);
    expect(website.failureThreshold).toBe(3);
    expect(website.recoveryThreshold).toBe(2);
    // Never 100% before anything has been measured.
    expect(website.lastCheckedAt).toBeNull();
  });

  it('refuses the same site twice within one organization', async () => {
    await api()
      .post('/api/websites')
      .set(...orgHeader())
      .send({ name: 'Dedupe', url: 'https://dedupe-test.example.org' })
      .expect(201);

    // Different scheme, `www.` and a trailing slash — the same website.
    const duplicate = await api()
      .post('/api/websites')
      .set(...orgHeader())
      .send({ name: 'Dedupe again', url: 'http://www.dedupe-test.example.org/' });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('WEBSITE_URL_ALREADY_MONITORED');
  });

  it.each([
    ['loopback by name', 'http://localhost:8080'],
    ['loopback by address', 'http://127.0.0.1/'],
    ['obfuscated loopback', 'http://127.1/'],
    ['private network', 'http://10.0.0.5/admin'],
    ['private network', 'http://192.168.1.1/'],
    ['carrier-grade NAT', 'http://100.64.0.1/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['cloud metadata by name', 'http://metadata.google.internal/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/'],
    ['unique local IPv6', 'http://[fd00::1]/'],
    ['internal suffix', 'https://intranet.corp/'],
    ['single-label host', 'https://router/'],
  ])('refuses %s', async (_label, url) => {
    const response = await api()
      .post('/api/websites')
      .set(...orgHeader())
      .send({ name: 'Blocked', url });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.fields?.[0]?.field).toBe('url');
  });

  it.each([
    ['a non-HTTP scheme', 'file:///etc/passwd'],
    ['a gopher URL', 'gopher://example.org/'],
    ['credentials in the URL', 'https://admin:secret@example.org/'],
    ['nonsense', 'not a url at all'],
  ])('refuses %s', async (_label, url) => {
    const response = await api()
      .post('/api/websites')
      .set(...orgHeader())
      .send({ name: 'Invalid', url });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('updates, pauses and resumes a website', async () => {
    const created = await api()
      .post('/api/websites')
      .set(...orgHeader())
      .send({ name: 'Toggle', url: 'https://toggle-test.example.org' })
      .expect(201);
    const websiteId = created.body.data.id as string;

    const renamed = await api()
      .patch(`/api/websites/${websiteId}`)
      .set(...orgHeader())
      .send({ name: 'Toggle Renamed', monitoringIntervalSeconds: 900 })
      .expect(200);
    expect(renamed.body.data.name).toBe('Toggle Renamed');
    expect(renamed.body.data.monitoringIntervalSeconds).toBe(900);

    const paused = await api()
      .post(`/api/websites/${websiteId}/pause`)
      .set(...orgHeader())
      .expect(200);
    expect(paused.body.data.monitoringEnabled).toBe(false);
    expect(paused.body.data.status).toBe('paused');

    const resumed = await api()
      .post(`/api/websites/${websiteId}/resume`)
      .set(...orgHeader())
      .expect(200);
    expect(resumed.body.data.monitoringEnabled).toBe(true);
    // Resuming starts from a clean slate rather than a stale failure streak.
    expect(resumed.body.data.status).toBe('unknown');

    await api()
      .delete(`/api/websites/${websiteId}`)
      .set(...orgHeader())
      .expect(204);

    await api()
      .get(`/api/websites/${websiteId}`)
      .set(...orgHeader())
      .expect(404);
  });

  it('paginates, filters and sorts newest first', async () => {
    const page = await api()
      .get('/api/websites')
      .query({ page: 1, pageSize: 2 })
      .set(...orgHeader())
      .expect(200);

    expect(page.body.data.items.length).toBeLessThanOrEqual(2);
    expect(page.body.data.pagination.pageSize).toBe(2);
    expect(page.body.data.pagination.page).toBe(1);
    expect(page.body.data.pagination.totalItems).toBeGreaterThan(0);

    const searched = await api()
      .get('/api/websites')
      .query({ search: 'Acme' })
      .set(...orgHeader())
      .expect(200);
    expect(searched.body.data.items.every((w: { name: string }) => w.name.includes('Acme'))).toBe(
      true,
    );

    const filtered = await api()
      .get('/api/websites')
      .query({ status: 'down' })
      .set(...orgHeader())
      .expect(200);
    expect(filtered.body.data.items).toHaveLength(0);
  });

  it('caps the page size rather than letting a caller ask for everything', async () => {
    const response = await api()
      .get('/api/websites')
      .query({ pageSize: 5000 })
      .set(...orgHeader());

    // An unbounded page is a denial-of-service vector on the largest tenant.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('enforces the plan website limit server-side', async () => {
    const limited = await onboard('plan-limit');
    const max = PLAN_LIMITS.free.maxWebsites;

    for (let index = 0; index < max; index += 1) {
      await limited.agent
        .post('/api/websites')
        .set('X-Organization-Id', limited.organizationId)
        .send({
          name: `Site ${String(index)}`,
          url: `https://plan-limit-${String(index)}.example.org`,
        })
        .expect(201);
    }

    const overLimit = await limited.agent
      .post('/api/websites')
      .set('X-Organization-Id', limited.organizationId)
      .send({ name: 'One too many', url: 'https://plan-limit-extra.example.org' });

    expect(overLimit.status).toBe(403);
    expect(overLimit.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('enforces the plan minimum monitoring interval', async () => {
    const response = await api()
      .post('/api/websites')
      .set(...orgHeader())
      .send({
        name: 'Too frequent',
        url: 'https://too-frequent.example.org',
        // A valid interval, but faster than the free plan allows.
        monitoringIntervalSeconds: 60,
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });
});
