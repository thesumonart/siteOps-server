import type { ReportData } from '../../contracts/index.js';

/**
 * Renders a report as CSV.
 *
 * The export people actually use: it goes into a spreadsheet, gets a column
 * added, and is sent to a client. So it carries **every** website, where the
 * PDF caps its table at a hundred rows for readability.
 *
 * Two sections in one file — websites, then incidents — separated by a blank
 * line and a new header row. Spreadsheets handle that; a second download would
 * be worse for the person who wants both.
 */

/**
 * Escapes one field.
 *
 * The leading-character guard is the part that matters. A field beginning with
 * `=`, `+`, `-` or `@` is interpreted as a *formula* by Excel, Google Sheets and
 * LibreOffice — a website named `=HYPERLINK("http://evil.test","Click")` becomes
 * a live link in the recipient's spreadsheet, and `=cmd|...` has historically
 * been worse than that. Website names and incident details come from user
 * input, and this export is designed to be forwarded to a third party, so the
 * risk is not theoretical.
 *
 * Prefixing with an apostrophe is the standard mitigation: it renders as the
 * literal text and is not treated as a formula.
 */
function escapeField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;

  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function row(values: readonly (string | number | null)[]): string {
  return values.map((value) => (value === null ? '' : escapeField(String(value)))).join(',');
}

/** A percentage with two decimals, or empty when nothing was measured. */
function percentage(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}

export function renderReportCsv(data: ReportData): string {
  const lines: string[] = [];

  lines.push(row(['Report', data.organizationName]));
  lines.push(row(['Period start', data.periodStart]));
  lines.push(row(['Period end', data.periodEnd]));
  lines.push(row(['Generated', data.generatedAt]));
  lines.push(row(['Websites', data.websiteCount]));
  lines.push(row(['Overall uptime %', percentage(data.overallUptimePercentage)]));
  lines.push(row(['Average response time (ms)', data.averageResponseTimeMs]));
  lines.push(row(['Incidents', data.totalIncidents]));
  lines.push(row(['Total downtime (s)', data.totalDowntimeSeconds]));
  lines.push('');

  lines.push(
    row([
      'Website',
      'URL',
      'Uptime %',
      'Total checks',
      'Successful checks',
      'Avg response (ms)',
      'Fastest (ms)',
      'Slowest (ms)',
      'Incidents',
      'Downtime (s)',
      'Longest incident (s)',
    ]),
  );

  for (const website of data.websites) {
    lines.push(
      row([
        website.name,
        website.url,
        percentage(website.uptimePercentage),
        website.totalChecks,
        website.successfulChecks,
        website.averageResponseTimeMs,
        website.fastestResponseTimeMs,
        website.slowestResponseTimeMs,
        website.incidentCount,
        website.totalDowntimeSeconds,
        website.longestIncidentSeconds,
      ]),
    );
  }

  if (data.incidents.length > 0) {
    lines.push('');
    lines.push(
      row(['Website', 'Type', 'Category', 'Started', 'Resolved', 'Duration (s)', 'Detail']),
    );

    for (const incident of data.incidents) {
      lines.push(
        row([
          incident.websiteName,
          incident.type,
          incident.category,
          incident.startedAt,
          incident.resolvedAt,
          incident.durationSeconds,
          incident.detail,
        ]),
      );
    }
  }

  // CRLF, which is what RFC 4180 specifies and what Excel expects; a trailing
  // newline so a shell `cat` of two exports does not join their last rows.
  return `${lines.join('\r\n')}\r\n`;
}
