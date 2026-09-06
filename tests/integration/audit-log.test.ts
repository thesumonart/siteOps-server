import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditLogDto, CursorPaginatedResult } from '../../src/contracts/index.js';
import { onboard, type SignedInAccount } from '../support/api.js';
import { databaseAvailable, disconnectTestDatabase } from '../support/test-db.js';

/**
 * The organization activity feed.
 *
 * These cases assert behaviour rather than rendering: that the log records what
 * actually happened, that a filter narrows it, that the cursor pages without
 * skipping or repeating, and — most importantly — that one organization's
 * history is invisible to another and that the API offers no way to alter it.
 */

const available = await databaseAvailable();

interface Envelope<T> {
  readonly data: T;
}

let owner: SignedInAccount & { organizationId: string };
let outsider: SignedInAccount & { organizationId: string };
let websiteId = '';

async function readLogs(
  account: SignedInAccount & { organizationId: string },
  query: Record<string, string> = {},
): Promise<CursorPaginatedResult<AuditLogDto>> {
  const response = await account.agent
    .get('/api/audit-logs')
    .set('X-Organization-Id', account.organizationId)
    .query(query)
    .expect(200);

  return (response.body as Envelope<CursorPaginatedResult<AuditLogDto>>).data;
}

beforeAll(async () => {
  if (!available) return;

  // Audit logs are a paid feature; the plan gate is exercised separately below.
  owner = await onboard('audit-owner', { plan: 'agency' });
  outsider = await onboard('audit-outsider', { plan: 'agency' });

  // Three distinct auditable actions, so filters have something to separate.
  const created = await owner.agent
    .post('/api/websites')
    .set('X-Organization-Id', owner.organizationId)
    .send({ name: 'Audited Site', url: 'https://audited-site.example.org' })
    .expect(201);
  websiteId = (created.body as Envelope<{ id: string }>).data.id;

  await owner.agent
    .patch(`/api/websites/${websiteId}`)
    .set('X-Organization-Id', owner.organizationId)
    .send({ name: 'Audited Site Renamed' })
    .expect(200);

  await owner.agent
    .post(`/api/websites/${websiteId}/pause`)
    .set('X-Organization-Id', owner.organizationId)
    .expect(200);
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe.skipIf(!available)('audit log recording', () => {
  it('records the organization being created, and every website change since', async () => {
    const page = await readLogs(owner);
    const actions = page.items.map((entry) => entry.action);

    expect(actions).toContain('organization.created');
    expect(actions).toContain('website.created');
    expect(actions).toContain('website.updated');
    expect(actions).toContain('website.monitoring_paused');
  });

  it('names the person who acted and the thing they acted on', async () => {
    const page = await readLogs(owner, { action: 'website.created' });
    const [entry] = page.items;

    expect(entry).toBeDefined();
    expect(entry?.actorName).toBe(owner.account.name);
    expect(entry?.actorId).toBe(owner.userId);
    expect(entry?.targetType).toBe('website');
    expect(entry?.targetId).toBe(websiteId);
    expect(entry?.targetLabel).toBe('Audited Site');
  });

  it('keeps the label the target had at the time, not the one it has now', async () => {
    // The website was renamed after creation. The creation entry must still say
    // what it was called then, or the feed rewrites its own history.
    const page = await readLogs(owner, { action: 'website.created' });
    expect(page.items[0]?.targetLabel).toBe('Audited Site');

    const renamed = await readLogs(owner, { action: 'website.updated' });
    expect(renamed.items[0]?.targetLabel).toBe('Audited Site Renamed');
  });

  it('derives the area from the action', async () => {
    const page = await readLogs(owner, { area: 'website' });

    expect(page.items.length).toBeGreaterThan(0);
    for (const entry of page.items) {
      expect(entry.area).toBe('website');
      expect(entry.action.startsWith('website.')).toBe(true);
    }
  });
});

describe.skipIf(!available)('audit log filtering', () => {
  it('narrows to one area', async () => {
    const all = await readLogs(owner);
    const websites = await readLogs(owner, { area: 'website' });

    expect(websites.items.length).toBeGreaterThan(0);
    expect(websites.items.length).toBeLessThan(all.items.length);
  });

  it('narrows to one actor', async () => {
    const mine = await readLogs(owner, { actorUserId: owner.userId });
    expect(mine.items.length).toBeGreaterThan(0);

    // Another organization's owner never acted here, so filtering by them
    // returns nothing rather than leaking that they exist.
    const theirs = await readLogs(owner, { actorUserId: outsider.userId });
    expect(theirs.items).toHaveLength(0);
  });

  it('matches the target label with free text, case-insensitively', async () => {
    const found = await readLogs(owner, { search: 'audited site' });
    expect(found.items.length).toBeGreaterThan(0);

    const absent = await readLogs(owner, { search: 'nothing-by-this-name' });
    expect(absent.items).toHaveLength(0);
  });

  it('treats a search term as literal text, not as a pattern', async () => {
    // `.*` would match everything if the term reached the regex engine raw.
    const page = await readLogs(owner, { search: '.*' });
    expect(page.items).toHaveLength(0);
  });

  it('excludes entries outside the date range', async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const dayAfter = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    const future = await readLogs(owner, { from: tomorrow, to: dayAfter });
    expect(future.items).toHaveLength(0);

    const past = await readLogs(owner, {
      from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    expect(past.items.length).toBeGreaterThan(0);
  });

  it('rejects an inverted date range as a field error', async () => {
    const response = await owner.agent
      .get('/api/audit-logs')
      .set('X-Organization-Id', owner.organizationId)
      .query({
        from: new Date(Date.now()).toISOString(),
        to: new Date(Date.now() - 60_000).toISOString(),
      })
      .expect(400);

    const body = response.body as { error: { code: string; fields?: { field: string }[] } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields?.some((field) => field.field === 'query.from')).toBe(true);
  });

  it('rejects an unknown area rather than ignoring it', async () => {
    await owner.agent
      .get('/api/audit-logs')
      .set('X-Organization-Id', owner.organizationId)
      .query({ area: 'not-an-area' })
      .expect(400);
  });
});

describe.skipIf(!available)('audit log paging', () => {
  it('pages by cursor without repeating an entry', async () => {
    const first = await readLogs(owner, { pageSize: '2' });
    expect(first.items).toHaveLength(2);
    expect(first.pagination.hasNextPage).toBe(true);
    expect(first.pagination.nextCursor).not.toBeNull();

    const second = await readLogs(owner, {
      pageSize: '2',
      cursor: first.pagination.nextCursor ?? '',
    });

    const firstIds = new Set(first.items.map((entry) => entry.id));
    for (const entry of second.items) {
      expect(firstIds.has(entry.id)).toBe(false);
    }
  });

  it('refuses a malformed cursor rather than silently restarting', async () => {
    await owner.agent
      .get('/api/audit-logs')
      .set('X-Organization-Id', owner.organizationId)
      .query({ cursor: 'not-a-cursor' })
      .expect(400);
  });
});

describe.skipIf(!available)('audit log actors', () => {
  it('lists the people who appear in this organization only', async () => {
    const response = await owner.agent
      .get('/api/audit-logs/actors')
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);

    const { items } = (response.body as Envelope<{ items: { id: string | null }[] }>).data;
    const ids = items.map((actor) => actor.id);

    expect(ids).toContain(owner.userId);
    expect(ids).not.toContain(outsider.userId);
  });
});

describe.skipIf(!available)('audit log plan gating', () => {
  it('refuses the feed on a plan that does not include it', async () => {
    const free = await onboard('audit-free');

    const response = await free.agent
      .get('/api/audit-logs')
      .set('X-Organization-Id', free.organizationId)
      .expect(403);

    const body = response.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('PLAN_LIMIT_REACHED');
    // The message must name the plan that would allow it, so the dashboard can
    // offer the right upgrade rather than a generic one.
    expect(body.error.message).toContain('Professional');
  });
});

describe.skipIf(!available)('audit log isolation and immutability', () => {
  it("does not return another organization's entries", async () => {
    const theirs = await readLogs(outsider);
    const labels = theirs.items.map((entry) => entry.targetLabel);

    expect(labels).not.toContain('Audited Site');
    expect(labels).not.toContain('Audited Site Renamed');
  });

  it('answers 404 for an organization the caller does not belong to', async () => {
    await outsider.agent
      .get('/api/audit-logs')
      .set('X-Organization-Id', owner.organizationId)
      .expect(404);
  });

  it('requires a session', async () => {
    const { client } = await import('../support/api.js');
    await client()
      .get('/api/audit-logs')
      .set('X-Organization-Id', owner.organizationId)
      .expect(401);
  });

  it('offers no route that writes, edits or deletes an entry', async () => {
    const page = await readLogs(owner);
    const target = page.items[0];
    expect(target).toBeDefined();

    for (const method of ['post', 'patch', 'put', 'delete'] as const) {
      const response = await owner.agent[method](`/api/audit-logs/${target?.id ?? ''}`)
        .set('X-Organization-Id', owner.organizationId)
        .send({});

      // 404 from the not-found handler: the route table has no such endpoint.
      expect(response.status).toBe(404);
    }

    // And nothing was removed by trying.
    const after = await readLogs(owner);
    expect(after.items.length).toBe(page.items.length);
  });
});
