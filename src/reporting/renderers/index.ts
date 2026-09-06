import type { ReportData, ReportFormat } from '../../contracts/index.js';
import { REPORT_CONTENT_TYPES } from '../../contracts/index.js';
import type { Branding } from '../branding.js';
import { renderReportCsv } from './csv.renderer.js';
import { renderReportPdf } from './pdf.renderer.js';

/**
 * Turning stored report facts into a downloadable file.
 *
 * Every format renders from the same `ReportData`, which is what guarantees a
 * CSV and a PDF of one report cannot disagree with each other. Adding a format
 * is a renderer and a line here; it never touches how a report is produced.
 */

export interface RenderedReport {
  readonly body: Buffer;
  readonly contentType: string;
  readonly filename: string;
}

export interface RenderOptions {
  readonly title: string;
  readonly data: ReportData;
  readonly format: ReportFormat;
  readonly branding?: Branding;
}

/**
 * A filesystem-safe filename derived from the report's title and period.
 *
 * The title is user input and ends up in a `Content-Disposition` header, so
 * everything outside a conservative set is replaced rather than escaped: a
 * newline or a quote in that header is a response-splitting or
 * filename-spoofing problem, and there is no legitimate title that needs them.
 */
export function reportFilename(title: string, periodEnd: string, format: ReportFormat): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report';

  const date = periodEnd.slice(0, 10);
  return `${slug}-${date}.${format}`;
}

export async function renderReport(options: RenderOptions): Promise<RenderedReport> {
  const filename = reportFilename(options.title, options.data.periodEnd, options.format);
  const contentType = REPORT_CONTENT_TYPES[options.format];

  switch (options.format) {
    case 'pdf':
      return {
        body: await renderReportPdf({
          title: options.title,
          data: options.data,
          ...(options.branding ? { branding: options.branding } : {}),
        }),
        contentType,
        filename,
      };

    case 'csv':
      return { body: Buffer.from(renderReportCsv(options.data), 'utf8'), contentType, filename };

    case 'json':
      // Pretty-printed: a JSON export is read by a person or diffed in a repo
      // far more often than it is parsed by a machine that would mind.
      return {
        body: Buffer.from(JSON.stringify(options.data, null, 2), 'utf8'),
        contentType,
        filename,
      };
  }
}

export { renderReportCsv, renderReportPdf };
