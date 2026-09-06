/**
 * Monitoring reports: what they cover, how they are produced and how they are
 * delivered.
 *
 * A report in SiteOps is **a stored set of facts, not a stored file**. Producing
 * one runs the aggregations once and writes the numbers; the PDF, CSV or JSON is
 * rendered from those numbers on download. That decision is worth stating,
 * because it is the one that shapes everything else here:
 *
 *  - No blob storage. There is no bucket to provision, secure, expire or pay
 *    for, and no second place a customer's data lives.
 *  - Re-rendering is free and always current. A branding change or a fixed
 *    layout bug applies to every past report without regenerating anything.
 *  - The same facts serve every format, so a CSV and a PDF of one report can
 *    never disagree.
 *
 * The cost is that a report cannot be a frozen artifact byte-for-byte. That is
 * the right trade for a monitoring summary, and would be the wrong one for an
 * invoice.
 */
export const REPORT_TYPES = ['website', 'organization'] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  website: 'Single website',
  organization: 'All websites',
};

export const REPORT_FORMATS = ['pdf', 'csv', 'json'] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_FORMAT_LABELS: Record<ReportFormat, string> = {
  pdf: 'PDF',
  csv: 'CSV',
  json: 'JSON',
};

export const REPORT_CONTENT_TYPES: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/**
 * Where a report is in its life.
 *
 * `generating` exists because the aggregations run on the worker rather than in
 * the request that asked for them: a month of checks across fifty websites is
 * not something to do while an HTTP connection waits.
 */
export const REPORT_STATUSES = ['pending', 'generating', 'ready', 'failed'] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  pending: 'Queued',
  generating: 'Generating',
  ready: 'Ready',
  failed: 'Failed',
};

/**
 * The period a report covers.
 *
 * A closed list rather than an arbitrary range, and `custom` is bounded to a
 * year. An open-ended window would let a caller ask the API to aggregate an
 * organization's entire check history, which is the largest collection in the
 * product.
 */
export const REPORT_PERIODS = [
  'last_7_days',
  'last_30_days',
  'last_month',
  'last_quarter',
  'custom',
] as const;

export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const REPORT_PERIOD_LABELS: Record<ReportPeriod, string> = {
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  last_month: 'Last calendar month',
  last_quarter: 'Last quarter',
  custom: 'Custom range',
};

/** Longest custom range, in days. Bounds the heaviest aggregation the API runs. */
export const MAX_REPORT_RANGE_DAYS = 366;

/**
 * Resolves a named period to an absolute window.
 *
 * `last_month` and `last_quarter` are *calendar* periods, not rolling ones: a
 * monthly report sent on the 1st should cover the month that just ended, not
 * the thirty days before it. Computed in UTC, which is also how every timestamp
 * in the product is stored.
 */
export function resolveReportPeriod(
  period: Exclude<ReportPeriod, 'custom'>,
  now: Date,
): { from: Date; to: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  switch (period) {
    case 'last_7_days':
      return { from: new Date(now.getTime() - 7 * 86_400_000), to: now };
    case 'last_30_days':
      return { from: new Date(now.getTime() - 30 * 86_400_000), to: now };
    case 'last_month':
      return {
        from: new Date(Date.UTC(year, month - 1, 1)),
        // Day 0 of this month is the last day of the previous one.
        to: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
      };
    case 'last_quarter': {
      const quarterStartMonth = Math.floor(month / 3) * 3;
      return {
        from: new Date(Date.UTC(year, quarterStartMonth - 3, 1)),
        to: new Date(Date.UTC(year, quarterStartMonth, 0, 23, 59, 59, 999)),
      };
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Report contents                                                           */
/* ------------------------------------------------------------------------ */

/** One website's figures for the reporting period. */
export interface ReportWebsiteSection {
  readonly websiteId: string;
  readonly name: string;
  readonly url: string;
  readonly totalChecks: number;
  readonly successfulChecks: number;
  /** Null when nothing was measured. Never 100% for an unchecked website. */
  readonly uptimePercentage: number | null;
  readonly averageResponseTimeMs: number | null;
  readonly fastestResponseTimeMs: number | null;
  readonly slowestResponseTimeMs: number | null;
  readonly incidentCount: number;
  readonly totalDowntimeSeconds: number;
  readonly longestIncidentSeconds: number | null;
  /** The state of each auxiliary monitor at the end of the period. */
  readonly monitors: readonly ReportMonitorSummary[];
}

export interface ReportMonitorSummary {
  readonly type: string;
  readonly status: string;
  readonly summary: string;
  readonly checkedAt: string | null;
  readonly findingCount: number;
}

export interface ReportIncidentSummary {
  readonly incidentId: string;
  readonly websiteName: string;
  readonly type: string;
  readonly category: string;
  readonly startedAt: string;
  readonly resolvedAt: string | null;
  readonly durationSeconds: number | null;
  readonly detail: string | null;
}

/**
 * Everything a report knows.
 *
 * Stored on the report document and rendered into each format on download. A
 * field that could not be measured is null rather than zero, all the way
 * through — the renderers show "—" for it, which is the honest rendering of "we
 * did not measure this".
 */
export interface ReportData {
  readonly organizationName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly generatedAt: string;
  readonly websiteCount: number;
  readonly totalChecks: number;
  readonly overallUptimePercentage: number | null;
  readonly averageResponseTimeMs: number | null;
  readonly totalIncidents: number;
  readonly totalDowntimeSeconds: number;
  readonly websites: readonly ReportWebsiteSection[];
  readonly incidents: readonly ReportIncidentSummary[];
  /** Optional narrative, written by the AI summary feature when it is used. */
  readonly narrative: string | null;
}

/* ------------------------------------------------------------------------ */
/* Scheduling                                                                */
/* ------------------------------------------------------------------------ */

export const SCHEDULE_FREQUENCIES = ['weekly', 'monthly'] as const;

export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export const SCHEDULE_FREQUENCY_LABELS: Record<ScheduleFrequency, string> = {
  weekly: 'Every week',
  monthly: 'Every month',
};

/** Recipients per schedule. Enough for a team; not a mailing list. */
export const MAX_SCHEDULE_RECIPIENTS = 20;

/**
 * The next time a schedule should run, in UTC.
 *
 * Weekly runs on the chosen weekday, monthly on the 1st, both at the chosen
 * hour. A monthly report is generated on the 1st precisely so `last_month`
 * resolves to the month that just ended.
 *
 * Always strictly in the future: computing a time that has already passed would
 * make the scheduler claim the job again immediately and mail the same report
 * in a loop.
 */
export function nextScheduleRun(
  frequency: ScheduleFrequency,
  hourUtc: number,
  dayOfWeek: number,
  after: Date,
): Date {
  if (frequency === 'monthly') {
    const candidate = new Date(
      Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), 1, hourUtc, 0, 0, 0),
    );
    if (candidate > after) return candidate;
    return new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth() + 1, 1, hourUtc, 0, 0, 0));
  }

  const candidate = new Date(
    Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), hourUtc, 0, 0, 0),
  );
  // Days forward to the target weekday, then a full week if that lands in the past.
  const daysAhead = (dayOfWeek - candidate.getUTCDay() + 7) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysAhead);

  if (candidate <= after) candidate.setUTCDate(candidate.getUTCDate() + 7);
  return candidate;
}

export const WEEKDAY_LABELS: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
