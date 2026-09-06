import { describe, expect, it } from 'vitest';

import type { ReportData } from '../../contracts/index.js';
import { renderReport, reportFilename } from './index.js';
import { renderReportCsv } from './csv.renderer.js';

/**
 * Rendering stored report facts into downloadable files.
 *
 * Two things are being protected here. First, that an unmeasured value stays
 * unmeasured all the way to the page — a report is forwarded to a client, and a
 * fabricated 100% is the worst thing this product could print. Second, that a
 * website *name*, which is user input, cannot do anything hostile once it
 * reaches a spreadsheet or an HTTP header.
 */

const DATA: ReportData = {
  organizationName: 'Test Agency',
  periodStart: '2026-02-01T00:00:00.000Z',
  periodEnd: '2026-02-28T23:59:59.999Z',
  generatedAt: '2026-03-01T08:00:00.000Z',
  websiteCount: 2,
  totalChecks: 8064,
  overallUptimePercentage: 99.87,
  averageResponseTimeMs: 412,
  totalIncidents: 1,
  totalDowntimeSeconds: 630,
  websites: [
    {
      websiteId: '507f1f77bcf86cd799439011',
      name: 'Client Site',
      url: 'https://client.example.com',
      totalChecks: 4032,
      successfulChecks: 4025,
      uptimePercentage: 99.82,
      averageResponseTimeMs: 380,
      fastestResponseTimeMs: 120,
      slowestResponseTimeMs: 2400,
      incidentCount: 1,
      totalDowntimeSeconds: 630,
      longestIncidentSeconds: 630,
      monitors: [
        {
          type: 'ssl',
          status: 'passing',
          summary: 'Valid, 62 days remaining.',
          checkedAt: '2026-02-28T02:00:00.000Z',
          findingCount: 0,
        },
      ],
    },
    {
      websiteId: '507f1f77bcf86cd799439012',
      // Never checked in the period. Every figure must stay null.
      name: 'Newly Added',
      url: 'https://new.example.com',
      totalChecks: 0,
      successfulChecks: 0,
      uptimePercentage: null,
      averageResponseTimeMs: null,
      fastestResponseTimeMs: null,
      slowestResponseTimeMs: null,
      incidentCount: 0,
      totalDowntimeSeconds: 0,
      longestIncidentSeconds: null,
      monitors: [],
    },
  ],
  incidents: [
    {
      incidentId: '507f1f77bcf86cd799439021',
      websiteName: 'Client Site',
      type: 'downtime',
      category: 'availability',
      startedAt: '2026-02-14T03:12:00.000Z',
      resolvedAt: '2026-02-14T03:22:30.000Z',
      durationSeconds: 630,
      detail: null,
    },
  ],
  narrative: null,
};

describe('reportFilename', () => {
  it('slugifies the title and dates the file', () => {
    expect(reportFilename('February report', '2026-02-28T23:59:59.999Z', 'pdf')).toBe(
      'february-report-2026-02-28.pdf',
    );
  });

  it('strips everything that could break a Content-Disposition header', () => {
    /*
     * The title is user input and lands in a response header. A quote or a
     * newline there is header injection or a spoofed filename, so everything
     * outside `[a-z0-9-]` is replaced rather than escaped.
     */
    const filename = reportFilename('Report" ;\r\nX-Evil: 1', '2026-02-28T00:00:00.000Z', 'csv');

    expect(filename).not.toMatch(/["\r\n;]/);
    expect(filename.endsWith('.csv')).toBe(true);
  });

  it('falls back to a usable name when the title has nothing to slugify', () => {
    expect(reportFilename('日本語', '2026-02-28T00:00:00.000Z', 'json')).toBe(
      'report-2026-02-28.json',
    );
  });
});

describe('renderReportCsv', () => {
  it('includes the summary, every website and every incident', () => {
    const csv = renderReportCsv(DATA);

    expect(csv).toContain('Test Agency');
    expect(csv).toContain('Client Site');
    expect(csv).toContain('Newly Added');
    expect(csv).toContain('downtime');
  });

  it('leaves an unmeasured value empty rather than writing a zero', () => {
    const csv = renderReportCsv(DATA);
    const row = csv.split('\r\n').find((line) => line.startsWith('Newly Added'));

    expect(row).toBeDefined();
    // Uptime is the third column and must be blank, not `0.00` — a zero would
    // read as "this site was down all month".
    expect(row?.split(',')[2]).toBe('');
  });

  it('neutralises a formula so a spreadsheet does not execute it', () => {
    /*
     * A website named `=HYPERLINK(...)` becomes a live link in the recipient's
     * spreadsheet. This export is designed to be forwarded to a client, so the
     * risk is not theoretical.
     */
    const csv = renderReportCsv({
      ...DATA,
      websites: [
        {
          ...DATA.websites[0]!,
          name: '=HYPERLINK("http://evil.test","Click")',
        },
      ],
    });

    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/^=HYPERLINK/m);
  });

  it('guards every dangerous leading character', () => {
    for (const prefix of ['=', '+', '-', '@']) {
      const csv = renderReportCsv({
        ...DATA,
        websites: [{ ...DATA.websites[0]!, name: `${prefix}cmd` }],
      });

      expect(csv).toContain(`'${prefix}cmd`);
    }
  });

  it('quotes and escapes a field containing a comma or a quote', () => {
    const csv = renderReportCsv({
      ...DATA,
      websites: [{ ...DATA.websites[0]!, name: 'Acme, "The" Agency' }],
    });

    expect(csv).toContain('"Acme, ""The"" Agency"');
  });

  it('uses CRLF line endings, as RFC 4180 specifies', () => {
    expect(renderReportCsv(DATA)).toContain('\r\n');
  });
});

describe('renderReport', () => {
  it('produces a real PDF', async () => {
    const rendered = await renderReport({ title: 'February report', data: DATA, format: 'pdf' });

    expect(rendered.contentType).toBe('application/pdf');
    // The magic number, so this asserts a genuine PDF rather than any bytes.
    expect(rendered.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(rendered.body.byteLength).toBeGreaterThan(1000);
    expect(rendered.filename).toBe('february-report-2026-02-28.pdf');
  });

  it('renders a PDF for an empty report without failing', async () => {
    const empty: ReportData = {
      ...DATA,
      websiteCount: 0,
      totalChecks: 0,
      overallUptimePercentage: null,
      averageResponseTimeMs: null,
      totalIncidents: 0,
      totalDowntimeSeconds: 0,
      websites: [],
      incidents: [],
    };

    const rendered = await renderReport({ title: 'Empty', data: empty, format: 'pdf' });

    expect(rendered.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders a PDF for a large report without failing', async () => {
    // Two hundred websites is the largest any plan allows; the renderer must
    // paginate rather than overflow one page.
    const many: ReportData = {
      ...DATA,
      websiteCount: 200,
      websites: Array.from({ length: 200 }, (_, index) => ({
        ...DATA.websites[0]!,
        websiteId: `5${String(index).padStart(23, '0')}`,
        name: `Website number ${String(index)}`,
      })),
    };

    const rendered = await renderReport({ title: 'Large', data: many, format: 'pdf' });

    expect(rendered.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('produces valid JSON that round-trips', async () => {
    const rendered = await renderReport({ title: 'February', data: DATA, format: 'json' });

    expect(rendered.contentType).toContain('application/json');
    expect(JSON.parse(rendered.body.toString('utf8'))).toEqual(DATA);
  });

  it('names the file for the format requested', async () => {
    const csv = await renderReport({ title: 'February', data: DATA, format: 'csv' });

    expect(csv.filename.endsWith('.csv')).toBe(true);
    expect(csv.contentType).toContain('text/csv');
  });

  it('applies branding without failing on a hostile colour', async () => {
    // The colour reaches a PDF renderer and, elsewhere, a style attribute.
    // An invalid one falls back rather than being passed through.
    const rendered = await renderReport({
      title: 'Branded',
      data: DATA,
      format: 'pdf',
      branding: {
        brandName: 'Acme Digital',
        logoUrl: null,
        primaryColor: 'red;}</style><script>alert(1)</script>',
        footerText: 'Acme Digital · hello@acme.test',
        showPoweredBy: false,
      },
    });

    expect(rendered.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
