import PDFDocument from 'pdfkit';

import type { ReportData, ReportWebsiteSection } from '../../contracts/index.js';
import {
  formatDuration,
  formatResponseTime,
  formatUptimePercentage,
} from '../../contracts/index.js';
import { DEFAULT_BRANDING, safeHexColor, type Branding } from '../branding.js';

/**
 * Renders a report as a PDF.
 *
 * PDFKit rather than a headless browser. The alternative — render HTML and
 * print it with Chrome — produces prettier output and costs a browser in the
 * worker image, a gigabyte of RAM per concurrent render and a second thing to
 * patch. A monitoring summary is a title, some numbers and two tables; that
 * does not justify shipping a browser.
 *
 * The document is built into memory rather than streamed to the response.
 * A report is a few hundred kilobytes at most — bounded by the row caps below —
 * and buffering means a failure mid-render produces a clean error instead of a
 * truncated file the browser has already started downloading.
 */

const PAGE_MARGIN = 48;
const FONT = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

const TEXT = '#0f172a';
const MUTED = '#64748b';
const BORDER = '#e2e8f0';
const DOWN = '#dc2626';

/**
 * Rows rendered per table.
 *
 * The report *data* already caps incidents at 100. This is the rendering cap,
 * and it exists separately because a 200-website organization would otherwise
 * produce a document nobody opens.
 */
const MAX_WEBSITE_ROWS = 100;
const MAX_INCIDENT_ROWS = 50;

interface Column {
  readonly label: string;
  readonly width: number;
  readonly align?: 'left' | 'right';
}

const WEBSITE_COLUMNS: readonly Column[] = [
  { label: 'Website', width: 150 },
  { label: 'Uptime', width: 62, align: 'right' },
  { label: 'Avg', width: 62, align: 'right' },
  { label: 'Checks', width: 55, align: 'right' },
  { label: 'Incidents', width: 60, align: 'right' },
  { label: 'Downtime', width: 70, align: 'right' },
];

const INCIDENT_COLUMNS: readonly Column[] = [
  { label: 'Website', width: 120 },
  { label: 'Type', width: 95 },
  { label: 'Started', width: 115 },
  { label: 'Duration', width: 70, align: 'right' },
];

function formatDate(iso: string): string {
  // A fixed, unambiguous format. `toLocaleDateString` would render differently
  // depending on the server's locale, which is not something a document sent to
  // a client should depend on.
  return new Date(iso).toISOString().slice(0, 10);
}

function formatDateTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
}

/** Truncates to fit a column, since PDFKit will otherwise wrap and break the row. */
function fit(value: string, width: number, size: number): string {
  // Helvetica averages close to 0.5em per character at these sizes; the
  // estimate only has to be conservative, not exact.
  const maxChars = Math.floor(width / (size * 0.5));
  return value.length > maxChars ? `${value.slice(0, Math.max(1, maxChars - 1))}…` : value;
}

export interface RenderPdfOptions {
  readonly title: string;
  readonly data: ReportData;
  readonly branding?: Branding;
}

export async function renderReportPdf(options: RenderPdfOptions): Promise<Buffer> {
  const branding = options.branding ?? DEFAULT_BRANDING;
  const accent = safeHexColor(branding.primaryColor, DEFAULT_BRANDING.primaryColor);
  const { data } = options;

  const document = new PDFDocument({
    size: 'A4',
    margin: PAGE_MARGIN,
    info: {
      Title: options.title,
      Author: branding.brandName,
      Subject: `Monitoring report, ${formatDate(data.periodStart)} to ${formatDate(data.periodEnd)}`,
      CreationDate: new Date(data.generatedAt),
    },
    // Fonts are embedded by PDFKit's built-ins; nothing is fetched at render
    // time, so a render never depends on the network.
    autoFirstPage: true,
  });

  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    document.on('error', reject);
  });

  renderHeader(document, options.title, data, branding, accent);
  renderSummary(document, data, accent);

  if (data.narrative) renderNarrative(document, data.narrative, accent);

  renderWebsiteTable(document, data.websites, accent);
  if (data.incidents.length > 0) renderIncidentTable(document, data, accent);

  renderFooters(document, branding);

  document.end();
  return finished;
}

function renderHeader(
  document: PDFKit.PDFDocument,
  title: string,
  data: ReportData,
  branding: Branding,
  accent: string,
): void {
  document.font(FONT_BOLD).fontSize(20).fillColor(accent).text(branding.brandName);
  document.moveDown(0.2);
  document.font(FONT_BOLD).fontSize(16).fillColor(TEXT).text(title);

  document
    .font(FONT)
    .fontSize(10)
    .fillColor(MUTED)
    .text(
      `${data.organizationName} · ${formatDate(data.periodStart)} to ${formatDate(data.periodEnd)}`,
    )
    .text(`Generated ${formatDateTime(data.generatedAt)} UTC`);

  document.moveDown(0.8);
  rule(document, accent);
  document.moveDown(0.8);
}

function rule(document: PDFKit.PDFDocument, color: string): void {
  const y = document.y;
  document
    .moveTo(PAGE_MARGIN, y)
    .lineTo(document.page.width - PAGE_MARGIN, y)
    .lineWidth(1)
    .strokeColor(color)
    .stroke();
}

function renderSummary(document: PDFKit.PDFDocument, data: ReportData, accent: string): void {
  document.font(FONT_BOLD).fontSize(12).fillColor(TEXT).text('Summary');
  document.moveDown(0.5);

  const cells: readonly (readonly [string, string])[] = [
    ['Websites', String(data.websiteCount)],
    // "—" rather than "100%" when nothing was measured. An unmeasured site is
    // not a healthy one, and this document may be forwarded to a client.
    ['Uptime', formatUptimePercentage(data.overallUptimePercentage)],
    ['Avg response', formatResponseTime(data.averageResponseTimeMs)],
    ['Checks', data.totalChecks.toLocaleString('en-GB')],
    ['Incidents', String(data.totalIncidents)],
    [
      'Total downtime',
      data.totalDowntimeSeconds > 0 ? formatDuration(data.totalDowntimeSeconds) : '—',
    ],
  ];

  const columnWidth = (document.page.width - PAGE_MARGIN * 2) / 3;
  const top = document.y;

  cells.forEach(([label, value], index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = PAGE_MARGIN + column * columnWidth;
    const y = top + row * 42;

    document.font(FONT).fontSize(9).fillColor(MUTED).text(label, x, y, { width: columnWidth });
    document
      .font(FONT_BOLD)
      .fontSize(14)
      .fillColor(accent)
      .text(value, x, y + 12, { width: columnWidth });
  });

  document.y = top + Math.ceil(cells.length / 3) * 42 + 12;
  document.x = PAGE_MARGIN;
}

function renderNarrative(document: PDFKit.PDFDocument, narrative: string, accent: string): void {
  ensureSpace(document, 120);
  document.font(FONT_BOLD).fontSize(12).fillColor(TEXT).text('Overview');
  document.moveDown(0.4);
  document
    .font(FONT)
    .fontSize(10)
    .fillColor(TEXT)
    .text(narrative, { width: document.page.width - PAGE_MARGIN * 2, align: 'left' });
  document.moveDown(0.8);
  rule(document, accent);
  document.moveDown(0.8);
}

function renderWebsiteTable(
  document: PDFKit.PDFDocument,
  websites: readonly ReportWebsiteSection[],
  accent: string,
): void {
  ensureSpace(document, 100);
  document.font(FONT_BOLD).fontSize(12).fillColor(TEXT).text('Websites');
  document.moveDown(0.5);

  if (websites.length === 0) {
    document
      .font(FONT)
      .fontSize(10)
      .fillColor(MUTED)
      .text('No websites were monitored during this period.');
    document.moveDown(1);
    return;
  }

  renderRow(
    document,
    WEBSITE_COLUMNS,
    WEBSITE_COLUMNS.map((column) => column.label),
    {
      bold: true,
      color: MUTED,
    },
  );
  rule(document, BORDER);
  document.moveDown(0.3);

  for (const website of websites.slice(0, MAX_WEBSITE_ROWS)) {
    ensureSpace(document, 24);
    renderRow(
      document,
      WEBSITE_COLUMNS,
      [
        website.name,
        formatUptimePercentage(website.uptimePercentage),
        formatResponseTime(website.averageResponseTimeMs),
        website.totalChecks.toLocaleString('en-GB'),
        String(website.incidentCount),
        website.totalDowntimeSeconds > 0 ? formatDuration(website.totalDowntimeSeconds) : '—',
      ],
      { color: website.incidentCount > 0 ? DOWN : TEXT },
    );
  }

  if (websites.length > MAX_WEBSITE_ROWS) {
    document.moveDown(0.4);
    document
      .font(FONT)
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `Showing ${String(MAX_WEBSITE_ROWS)} of ${String(websites.length)} websites. The CSV export contains all of them.`,
      );
  }

  document.moveDown(1);
  rule(document, accent);
  document.moveDown(0.8);
}

function renderIncidentTable(document: PDFKit.PDFDocument, data: ReportData, accent: string): void {
  ensureSpace(document, 100);
  document.font(FONT_BOLD).fontSize(12).fillColor(TEXT).text('Incidents');
  document.moveDown(0.5);

  renderRow(
    document,
    INCIDENT_COLUMNS,
    INCIDENT_COLUMNS.map((column) => column.label),
    {
      bold: true,
      color: MUTED,
    },
  );
  rule(document, BORDER);
  document.moveDown(0.3);

  for (const incident of data.incidents.slice(0, MAX_INCIDENT_ROWS)) {
    ensureSpace(document, 24);
    renderRow(document, INCIDENT_COLUMNS, [
      incident.websiteName,
      incident.type.replace(/_/g, ' '),
      formatDateTime(incident.startedAt),
      incident.durationSeconds === null ? 'Ongoing' : formatDuration(incident.durationSeconds),
    ]);
  }

  if (data.incidents.length > MAX_INCIDENT_ROWS) {
    document.moveDown(0.4);
    document
      .font(FONT)
      .fontSize(9)
      .fillColor(MUTED)
      .text(`Showing ${String(MAX_INCIDENT_ROWS)} of ${String(data.incidents.length)} incidents.`);
  }

  document.moveDown(1);
  rule(document, accent);
}

function renderRow(
  document: PDFKit.PDFDocument,
  columns: readonly Column[],
  values: readonly string[],
  options: { readonly bold?: boolean; readonly color?: string } = {},
): void {
  const size = 9;
  const y = document.y;
  let x = PAGE_MARGIN;

  document
    .font(options.bold ? FONT_BOLD : FONT)
    .fontSize(size)
    .fillColor(options.color ?? TEXT);

  columns.forEach((column, index) => {
    document.text(fit(values[index] ?? '', column.width, size), x, y, {
      width: column.width,
      align: column.align ?? 'left',
      lineBreak: false,
    });
    x += column.width;
  });

  document.x = PAGE_MARGIN;
  document.y = y + size + 6;
}

/** Starts a new page when the remaining space is too small for what follows. */
function ensureSpace(document: PDFKit.PDFDocument, needed: number): void {
  if (document.y + needed > document.page.height - PAGE_MARGIN - 30) {
    document.addPage();
  }
}

/**
 * Page numbers and the footer line, added after the content exists.
 *
 * Done in a second pass over `bufferedPageRange` because "page 2 of 5" cannot
 * be written until the document knows there are five pages. PDFKit only allows
 * this when pages are buffered, which is why the render is not streamed.
 */
function renderFooters(document: PDFKit.PDFDocument, branding: Branding): void {
  const range = document.bufferedPageRange();

  for (let index = range.start; index < range.start + range.count; index += 1) {
    document.switchToPage(index);

    const y = document.page.height - PAGE_MARGIN + 8;
    const width = document.page.width - PAGE_MARGIN * 2;

    document.font(FONT).fontSize(8).fillColor(MUTED);

    if (branding.footerText) {
      document.text(branding.footerText, PAGE_MARGIN, y, {
        width,
        align: 'left',
        lineBreak: false,
      });
    } else if (branding.showPoweredBy) {
      document.text('Generated by SiteOps', PAGE_MARGIN, y, {
        width,
        align: 'left',
        lineBreak: false,
      });
    }

    document.text(
      `Page ${String(index - range.start + 1)} of ${String(range.count)}`,
      PAGE_MARGIN,
      y,
      {
        width,
        align: 'right',
        lineBreak: false,
      },
    );
  }
}
