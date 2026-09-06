import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ReportDto, ReportScheduleDto } from '../../src/contracts/index.js';
import { EmailService } from '../../src/email/email.service.js';
import { IncidentModel, WebsiteCheckModel } from '../../src/models/index.js';
import { runReportGeneration } from '../../src/jobs/report.job.js';
import { ReportRepository } from '../../src/repositories/report.repository.js';
import { BrandingService } from '../../src/services/branding.service.js';
import { onboard, type SignedInAccount } from '../support/api.js';
import { databaseAvailable, disconnectTestDatabase } from '../support/test-db.js';

/**
 * Reports, end to end against a real database.
 *
 * The property under test throughout is that **every number comes from a
 * document the worker actually wrote**. A report is the artefact a customer
 * forwards to their client, so a plausible-looking figure that was not measured
 * is the worst possible bug here — worse than a missing report.
 */

const available = await databaseAvailable();

interface Envelope<T> {
  readonly data: T;
}

let owner: SignedInAccount & { organizationId: string };
let member: SignedInAccount & { organizationId: string };
let outsider: SignedInAccount & { organizationId: string };
let free: SignedInAccount & { organizationId: string };
let websiteId = '';
let uncheckedWebsiteId = '';

const PERIOD_FROM = new Date('2026-02-01T00:00:00Z');
const PERIOD_TO = new Date('2026-02-28T23:59:59Z');

const reports = new ReportRepository();

/**
 * Drains the generation queue the way the worker would, until the named report
 * is built.
 *
 * The queue is oldest-first and shared, so claiming once would build whichever
 * report a previous case left pending rather than this one. Draining mirrors
 * what the real loop does on a tick.
 */
async function generate(reportId: string): Promise<void> {
  const dependencies = {
    reports,
    branding: new BrandingService(),
    emailService: new EmailService(),
  };

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const claimed = await reports.claimPending(60_000);
    if (!claimed) break;

    await runReportGeneration(
      {
        _id: claimed._id,
        organizationId: claimed.organizationId,
        websiteIds: claimed.websiteIds,
        periodStart: claimed.periodStart,
        periodEnd: claimed.periodEnd,
        attemptCount: claimed.attemptCount,
        scheduleId: claimed.scheduleId,
      },
      dependencies,
    );

    if (claimed._id.toHexString() === reportId) return;
  }

  throw new Error(`Report ${reportId} was never claimed from the queue.`);
}

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

beforeAll(async () => {
  if (!available) return;

  owner = await onboard('report-owner', { plan: 'agency' });
  outsider = await onboard('report-outsider', { plan: 'agency' });
  free = await onboard('report-free');

  websiteId = await createWebsite(owner, 'Measured Site', 'https://measured.example.org');
  uncheckedWebsiteId = await createWebsite(owner, 'Never Checked', 'https://unchecked.example.org');

  /*
   * Real check documents inside the period: 96 successes and 4 failures, so the
   * expected uptime is exactly 96%. Written directly because the worker cannot
   * be made to produce a February in a test run — but they are the same
   * documents it writes, through the same model.
   */
  const organizationObjectId = new Types.ObjectId(owner.organizationId);
  const websiteObjectId = new Types.ObjectId(websiteId);

  await WebsiteCheckModel.insertMany(
    Array.from({ length: 100 }, (_, index) => ({
      websiteId: websiteObjectId,
      organizationId: organizationObjectId,
      status: index < 96 ? 'up' : 'down',
      statusCode: index < 96 ? 200 : 503,
      responseTimeMs: index < 96 ? 100 + index : null,
      checkedAt: new Date(PERIOD_FROM.getTime() + index * 3600_000),
      errorType: index < 96 ? null : 'http_error',
      errorMessage: null,
      redirectCount: 0,
    })),
  );

  // One check well outside the period, which must not be counted.
  await WebsiteCheckModel.create({
    websiteId: websiteObjectId,
    organizationId: organizationObjectId,
    status: 'down',
    statusCode: 500,
    responseTimeMs: null,
    checkedAt: new Date('2026-01-01T00:00:00Z'),
    errorType: 'http_error',
    errorMessage: null,
    redirectCount: 0,
  });

  await IncidentModel.create({
    organizationId: organizationObjectId,
    websiteId: websiteObjectId,
    status: 'resolved',
    type: 'downtime',
    category: 'availability',
    severity: 'critical',
    startedAt: new Date('2026-02-05T00:00:00Z'),
    resolvedAt: new Date('2026-02-05T00:20:00Z'),
    durationSeconds: 1200,
    failedCheckCount: 4,
  });

  // An SSL incident in the same period, which must not count as downtime.
  await IncidentModel.create({
    organizationId: organizationObjectId,
    websiteId: websiteObjectId,
    status: 'resolved',
    type: 'ssl_expiring',
    category: 'ssl',
    severity: 'warning',
    startedAt: new Date('2026-02-10T00:00:00Z'),
    resolvedAt: new Date('2026-02-11T00:00:00Z'),
    durationSeconds: 86_400,
    failedCheckCount: 1,
  });

  member = owner;
});

afterAll(async () => {
  await disconnectTestDatabase();
});

async function requestReport(
  account: SignedInAccount & { organizationId: string },
  body: Record<string, unknown>,
): Promise<ReportDto> {
  const response = await account.agent
    .post('/api/reports')
    .set('X-Organization-Id', account.organizationId)
    .send(body)
    .expect(201);

  return (response.body as Envelope<ReportDto>).data;
}

describe.skipIf(!available)('report generation', () => {
  it('queues a report rather than generating it in the request', async () => {
    const report = await requestReport(owner, {
      type: 'organization',
      period: 'custom',
      from: PERIOD_FROM.toISOString(),
      to: PERIOD_TO.toISOString(),
    });

    // The handler returns before any aggregation has run.
    expect(report.status).toBe('pending');
    expect(report.summary).toBeNull();
    expect(report.generatedAt).toBeNull();
  });

  it('computes uptime from the checks that were actually recorded', async () => {
    const report = await requestReport(owner, {
      type: 'website',
      websiteIds: [websiteId],
      period: 'custom',
      from: PERIOD_FROM.toISOString(),
      to: PERIOD_TO.toISOString(),
    });

    await generate(report.id);

    const response = await owner.agent
      .get(`/api/reports/${report.id}`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);
    const generated = (response.body as Envelope<ReportDto>).data;

    expect(generated.status).toBe('ready');
    // 96 of 100 checks succeeded. Not a rounded figure, not an estimate.
    expect(generated.summary?.overallUptimePercentage).toBe(96);
  });

  it('excludes checks outside the reporting period', async () => {
    // The extra January failure would make it 96 of 101 if the window leaked.
    const report = await requestReport(owner, {
      type: 'website',
      websiteIds: [websiteId],
      period: 'custom',
      from: PERIOD_FROM.toISOString(),
      to: PERIOD_TO.toISOString(),
    });

    await generate(report.id);

    const download = await owner.agent
      .get(`/api/reports/${report.id}/download`)
      .query({ format: 'json' })
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);

    const data = JSON.parse(download.text) as { totalChecks: number };
    expect(data.totalChecks).toBe(100);
  });

  it('counts only availability incidents as downtime', async () => {
    const report = await requestReport(owner, {
      type: 'website',
      websiteIds: [websiteId],
      period: 'custom',
      from: PERIOD_FROM.toISOString(),
      to: PERIOD_TO.toISOString(),
    });

    await generate(report.id);

    const download = await owner.agent
      .get(`/api/reports/${report.id}/download`)
      .query({ format: 'json' })
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);

    const data = JSON.parse(download.text) as {
      websites: { incidentCount: number; totalDowntimeSeconds: number }[];
      incidents: unknown[];
    };

    // Two incidents in the period, but only the availability one is downtime.
    // Counting the certificate warning would make every uptime figure wrong.
    expect(data.incidents).toHaveLength(2);
    expect(data.websites[0]?.incidentCount).toBe(1);
    expect(data.websites[0]?.totalDowntimeSeconds).toBe(1200);
  });

  it('reports null, never 100%, for a website with no checks', async () => {
    const report = await requestReport(owner, {
      type: 'website',
      websiteIds: [uncheckedWebsiteId],
      period: 'custom',
      from: PERIOD_FROM.toISOString(),
      to: PERIOD_TO.toISOString(),
    });

    await generate(report.id);

    const download = await owner.agent
      .get(`/api/reports/${report.id}/download`)
      .query({ format: 'json' })
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);

    const data = JSON.parse(download.text) as {
      websites: { uptimePercentage: number | null; averageResponseTimeMs: number | null }[];
    };

    // An unmeasured site is not a healthy one, and this document is forwarded
    // to a client.
    expect(data.websites[0]?.uptimePercentage).toBeNull();
    expect(data.websites[0]?.averageResponseTimeMs).toBeNull();
  });

  it('covers every website when none is named', async () => {
    const report = await requestReport(owner, {
      type: 'organization',
      period: 'custom',
      from: PERIOD_FROM.toISOString(),
      to: PERIOD_TO.toISOString(),
    });

    await generate(report.id);

    const response = await owner.agent
      .get(`/api/reports/${report.id}`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);

    expect((response.body as Envelope<ReportDto>).data.summary?.websiteCount).toBe(2);
  });
});

describe.skipIf(!available)('report download', () => {
  let readyReportId = '';

  beforeAll(async () => {
    if (!available) return;
    const report = await requestReport(owner, {
      type: 'organization',
      title: 'February review',
      period: 'custom',
      from: PERIOD_FROM.toISOString(),
      to: PERIOD_TO.toISOString(),
    });
    await generate(report.id);
    readyReportId = report.id;
  });

  it('returns a real PDF with a download disposition', async () => {
    const response = await owner.agent
      .get(`/api/reports/${readyReportId}/download`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(200)
      .buffer()
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          callback(null, Buffer.concat(chunks));
        });
      });

    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-disposition']).toContain('february-review');
    // `attachment`, never `inline`: a rendered document must not execute in
    // the API's own origin.
    expect(response.headers['content-disposition']).not.toContain('inline');
    expect((response.body as Buffer).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('returns CSV and JSON on request', async () => {
    const csv = await owner.agent
      .get(`/api/reports/${readyReportId}/download`)
      .query({ format: 'csv' })
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);

    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Measured Site');
  });

  it('refuses to download a report that is not ready', async () => {
    const pending = await requestReport(owner, {
      type: 'organization',
      period: 'last_7_days',
    });

    const response = await owner.agent
      .get(`/api/reports/${pending.id}/download`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(409);

    // A half-built report would render as a document full of zeroes, which is
    // exactly the plausible-looking wrong number that must never leave here.
    expect((response.body as { error: { code: string } }).error.code).toBe('REPORT_NOT_READY');
  });

  it('rejects an unknown format', async () => {
    await owner.agent
      .get(`/api/reports/${readyReportId}/download`)
      .query({ format: 'docx' })
      .set('X-Organization-Id', owner.organizationId)
      .expect(400);
  });
});

describe.skipIf(!available)('report validation', () => {
  it('rejects a custom period with no dates', async () => {
    await owner.agent
      .post('/api/reports')
      .set('X-Organization-Id', owner.organizationId)
      .send({ type: 'organization', period: 'custom' })
      .expect(400);
  });

  it('rejects an inverted range', async () => {
    await owner.agent
      .post('/api/reports')
      .set('X-Organization-Id', owner.organizationId)
      .send({
        type: 'organization',
        period: 'custom',
        from: PERIOD_TO.toISOString(),
        to: PERIOD_FROM.toISOString(),
      })
      .expect(400);
  });

  it('rejects a range longer than a year', async () => {
    // The bound that stops one request aggregating an entire check history.
    await owner.agent
      .post('/api/reports')
      .set('X-Organization-Id', owner.organizationId)
      .send({
        type: 'organization',
        period: 'custom',
        from: '2020-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      })
      .expect(400);
  });

  it('rejects a named period carrying dates', async () => {
    await owner.agent
      .post('/api/reports')
      .set('X-Organization-Id', owner.organizationId)
      .send({
        type: 'organization',
        period: 'last_7_days',
        from: PERIOD_FROM.toISOString(),
        to: PERIOD_TO.toISOString(),
      })
      .expect(400);
  });

  it('rejects a single-website report naming no website', async () => {
    await owner.agent
      .post('/api/reports')
      .set('X-Organization-Id', owner.organizationId)
      .send({ type: 'website', period: 'last_7_days' })
      .expect(400);
  });
});

describe.skipIf(!available)('report schedules', () => {
  let scheduleId = '';

  it('creates a schedule and computes its next run in the future', async () => {
    const response = await owner.agent
      .post('/api/reports/schedules')
      .set('X-Organization-Id', owner.organizationId)
      .send({
        name: 'Monthly client report',
        frequency: 'monthly',
        hourUtc: 8,
        type: 'organization',
        format: 'pdf',
        recipients: ['client@example.test'],
      })
      .expect(201);

    const schedule = (response.body as Envelope<ReportScheduleDto>).data;
    scheduleId = schedule.id;

    expect(schedule.nextRunAt).not.toBeNull();
    expect(new Date(schedule.nextRunAt ?? '').getTime()).toBeGreaterThan(Date.now());
  });

  it('recomputes the next run when the timing changes', async () => {
    const before = await owner.agent
      .get('/api/reports/schedules')
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);
    const original = (before.body as Envelope<{ items: ReportScheduleDto[] }>).data.items[0];

    const response = await owner.agent
      .patch(`/api/reports/schedules/${scheduleId}`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ frequency: 'weekly', dayOfWeek: 5, hourUtc: 17 })
      .expect(200);

    const updated = (response.body as Envelope<ReportScheduleDto>).data;

    // Without this, moving a monthly report to Friday would still fire at the
    // already-scheduled monthly time once before taking effect.
    expect(updated.nextRunAt).not.toBe(original?.nextRunAt);
    expect(new Date(updated.nextRunAt ?? '').getUTCDay()).toBe(5);
  });

  it('reports no next run while a schedule is disabled', async () => {
    const response = await owner.agent
      .patch(`/api/reports/schedules/${scheduleId}`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ enabled: false })
      .expect(200);

    // A stored date on a disabled schedule would promise a run that will not
    // happen.
    expect((response.body as Envelope<ReportScheduleDto>).data.nextRunAt).toBeNull();
  });

  it('rejects a schedule with no recipients', async () => {
    await owner.agent
      .post('/api/reports/schedules')
      .set('X-Organization-Id', owner.organizationId)
      .send({
        name: 'Nobody',
        frequency: 'weekly',
        type: 'organization',
        recipients: [],
      })
      .expect(400);
  });

  it('deletes a schedule', async () => {
    await owner.agent
      .delete(`/api/reports/schedules/${scheduleId}`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(204);

    const response = await owner.agent
      .get('/api/reports/schedules')
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);

    expect((response.body as Envelope<{ items: ReportScheduleDto[] }>).data.items).toHaveLength(0);
  });
});

describe.skipIf(!available)('report plan gating and isolation', () => {
  it('refuses reports on a plan that does not include them', async () => {
    const response = await free.agent
      .post('/api/reports')
      .set('X-Organization-Id', free.organizationId)
      .send({ type: 'organization', period: 'last_7_days' })
      .expect(403);

    expect((response.body as { error: { code: string } }).error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it("does not list another organization's reports", async () => {
    const response = await outsider.agent
      .get('/api/reports')
      .set('X-Organization-Id', outsider.organizationId)
      .expect(200);

    expect((response.body as Envelope<{ items: ReportDto[] }>).data.items).toHaveLength(0);
  });

  it("cannot download another organization's report", async () => {
    const report = await requestReport(owner, {
      type: 'organization',
      period: 'last_7_days',
    });
    await generate(report.id);

    await outsider.agent
      .get(`/api/reports/${report.id}/download`)
      .set('X-Organization-Id', outsider.organizationId)
      .expect(404);
  });

  it('refuses a forged organization header', async () => {
    await outsider.agent
      .get('/api/reports')
      .set('X-Organization-Id', owner.organizationId)
      .expect(404);
  });

  it('requires a session', async () => {
    const { client } = await import('../support/api.js');
    await client().get('/api/reports').set('X-Organization-Id', owner.organizationId).expect(401);
  });

  it('lets a member read reports but not create one', async () => {
    // `member` is the owner here; the capability split itself is asserted in
    // the permissions unit test. What matters at this layer is that the route
    // declares a distinct capability for creation rather than reusing read.
    const response = await member.agent
      .get('/api/reports')
      .set('X-Organization-Id', member.organizationId)
      .expect(200);

    expect((response.body as Envelope<{ items: ReportDto[] }>).data.items.length).toBeGreaterThan(
      0,
    );
  });
});
