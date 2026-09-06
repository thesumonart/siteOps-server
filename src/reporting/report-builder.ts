import type { Types } from 'mongoose';

import type {
  ReportData,
  ReportIncidentSummary,
  ReportMonitorSummary,
  ReportWebsiteSection,
} from '../contracts/index.js';
import { calculateUptimePercentage, estimateDowntimeSeconds } from '../contracts/index.js';
import { IncidentModel, MonitorResultModel, WebsiteModel } from '../models/index.js';
import { WebsiteCheckModel } from '../models/index.js';

/**
 * Assembles a report from recorded monitoring data.
 *
 * **Every number here is aggregated from documents the worker actually wrote.**
 * There is no sampling, no extrapolation and no placeholder. A website with no
 * checks in the period reports `null` uptime, not `100%` — an unmeasured site is
 * not a healthy one, and a plausible figure on a report a customer forwards to
 * their client is worse than an empty cell.
 *
 * Three aggregations run for the whole report rather than per website: one over
 * checks, one over incidents, one over monitor results. A fifty-site report is
 * three queries, not a hundred and fifty.
 */

export interface BuildReportInput {
  readonly organizationId: Types.ObjectId;
  readonly organizationName: string;
  readonly websiteIds: readonly Types.ObjectId[];
  readonly from: Date;
  readonly to: Date;
}

/** Incidents listed individually in the report, newest first. */
const MAX_LISTED_INCIDENTS = 100;

interface CheckAggregate {
  readonly _id: Types.ObjectId;
  readonly totalChecks: number;
  readonly successfulChecks: number;
  readonly averageResponseTimeMs: number | null;
  readonly fastestResponseTimeMs: number | null;
  readonly slowestResponseTimeMs: number | null;
}

interface WebsiteRow {
  readonly _id: Types.ObjectId;
  readonly name: string;
  readonly url: string;
  readonly monitoringIntervalSeconds: number;
}

interface IncidentRow {
  readonly _id: Types.ObjectId;
  readonly websiteId: Types.ObjectId;
  readonly type: string;
  readonly category?: string;
  readonly startedAt: Date;
  readonly resolvedAt: Date | null;
  readonly durationSeconds: number | null;
  readonly detail?: string | null;
}

interface MonitorRow {
  readonly websiteId: Types.ObjectId;
  readonly type: string;
  readonly status: string;
  readonly summary: string;
  readonly checkedAt: Date;
  readonly findings: readonly unknown[];
}

function round(value: number | null | undefined): number | null {
  return typeof value === 'number' ? Math.round(value) : null;
}

export async function buildReport(input: BuildReportInput): Promise<ReportData> {
  const websites = await resolveWebsites(input);
  const websiteIds = websites.map((website) => website._id);

  if (websiteIds.length === 0) {
    return emptyReport(input);
  }

  const [checkTotals, incidents, monitorResults] = await Promise.all([
    aggregateChecks(websiteIds, input.from, input.to),
    listIncidents(input.organizationId, websiteIds, input.from, input.to),
    latestMonitorResults(websiteIds, input.to),
  ]);

  const websiteNames = new Map(
    websites.map((website) => [website._id.toHexString(), website.name]),
  );

  const sections = websites.map((website) =>
    buildSection(website, checkTotals, incidents, monitorResults),
  );

  const totalChecks = sections.reduce((sum, section) => sum + section.totalChecks, 0);
  const successfulChecks = sections.reduce((sum, section) => sum + section.successfulChecks, 0);

  /*
   * The organization-wide average response time is weighted by the number of
   * successful checks, not a mean of the per-site means. A site checked every
   * minute and one checked hourly contribute very differently to what visitors
   * actually experienced, and an unweighted average would let the quiet site
   * dominate.
   */
  const weighted = sections.reduce(
    (accumulator, section) => {
      if (section.averageResponseTimeMs === null) return accumulator;
      return {
        sum: accumulator.sum + section.averageResponseTimeMs * section.successfulChecks,
        count: accumulator.count + section.successfulChecks,
      };
    },
    { sum: 0, count: 0 },
  );

  return {
    organizationName: input.organizationName,
    periodStart: input.from.toISOString(),
    periodEnd: input.to.toISOString(),
    generatedAt: new Date().toISOString(),
    websiteCount: sections.length,
    totalChecks,
    overallUptimePercentage: calculateUptimePercentage(successfulChecks, totalChecks),
    averageResponseTimeMs: weighted.count > 0 ? Math.round(weighted.sum / weighted.count) : null,
    totalIncidents: incidents.length,
    totalDowntimeSeconds: sections.reduce((sum, section) => sum + section.totalDowntimeSeconds, 0),
    websites: sections,
    incidents: incidents.slice(0, MAX_LISTED_INCIDENTS).map((incident) => ({
      incidentId: incident._id.toHexString(),
      websiteName: websiteNames.get(incident.websiteId.toHexString()) ?? 'Deleted website',
      type: incident.type,
      category: incident.category ?? 'availability',
      startedAt: incident.startedAt.toISOString(),
      resolvedAt: incident.resolvedAt?.toISOString() ?? null,
      durationSeconds: incident.durationSeconds,
      detail: incident.detail ?? null,
    })) satisfies ReportIncidentSummary[],
    narrative: null,
  };
}

function emptyReport(input: BuildReportInput): ReportData {
  return {
    organizationName: input.organizationName,
    periodStart: input.from.toISOString(),
    periodEnd: input.to.toISOString(),
    generatedAt: new Date().toISOString(),
    websiteCount: 0,
    totalChecks: 0,
    overallUptimePercentage: null,
    averageResponseTimeMs: null,
    totalIncidents: 0,
    totalDowntimeSeconds: 0,
    websites: [],
    incidents: [],
    narrative: null,
  };
}

/**
 * The websites the report covers.
 *
 * Always filtered by organization, even when explicit ids were given: the ids
 * come from a request, and an id belonging to another tenant simply does not
 * resolve rather than being resolved and then rejected.
 */
async function resolveWebsites(input: BuildReportInput): Promise<readonly WebsiteRow[]> {
  const query: Record<string, unknown> = { organizationId: input.organizationId };
  if (input.websiteIds.length > 0) query._id = { $in: input.websiteIds };

  return WebsiteModel.find(query)
    .select({ name: 1, url: 1, monitoringIntervalSeconds: 1 })
    .sort({ name: 1 })
    .lean<WebsiteRow[]>()
    .exec();
}

/**
 * Check totals per website for the period, in one aggregation.
 *
 * Response-time figures cover successful checks only: the duration of a failed
 * check measures how long a failure took, not how fast the site is, and
 * averaging it in makes a broken site look fast.
 */
async function aggregateChecks(
  websiteIds: readonly Types.ObjectId[],
  from: Date,
  to: Date,
): Promise<ReadonlyMap<string, CheckAggregate>> {
  const rows = await WebsiteCheckModel.aggregate<CheckAggregate>([
    { $match: { websiteId: { $in: [...websiteIds] }, checkedAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: '$websiteId',
        totalChecks: { $sum: 1 },
        successfulChecks: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
        averageResponseTimeMs: {
          $avg: { $cond: [{ $eq: ['$status', 'up'] }, '$responseTimeMs', null] },
        },
        fastestResponseTimeMs: {
          $min: { $cond: [{ $eq: ['$status', 'up'] }, '$responseTimeMs', null] },
        },
        slowestResponseTimeMs: {
          $max: { $cond: [{ $eq: ['$status', 'up'] }, '$responseTimeMs', null] },
        },
      },
    },
  ]).exec();

  return new Map(rows.map((row) => [row._id.toHexString(), row]));
}

/**
 * Incidents that overlap the period.
 *
 * Overlap, not containment: an outage that started before the period and ended
 * inside it is part of what happened during that month, and a report that only
 * counted incidents wholly inside the window would omit exactly the long ones
 * that matter most.
 */
async function listIncidents(
  organizationId: Types.ObjectId,
  websiteIds: readonly Types.ObjectId[],
  from: Date,
  to: Date,
): Promise<readonly IncidentRow[]> {
  return IncidentModel.find({
    organizationId,
    websiteId: { $in: [...websiteIds] },
    startedAt: { $lte: to },
    $or: [{ resolvedAt: null }, { resolvedAt: { $gte: from } }],
  })
    .sort({ startedAt: -1 })
    .limit(500)
    .select({
      websiteId: 1,
      type: 1,
      category: 1,
      startedAt: 1,
      resolvedAt: 1,
      durationSeconds: 1,
      detail: 1,
    })
    .lean<IncidentRow[]>()
    .exec();
}

/** The last result of each monitor type per website, as at the end of the period. */
async function latestMonitorResults(
  websiteIds: readonly Types.ObjectId[],
  to: Date,
): Promise<ReadonlyMap<string, MonitorRow[]>> {
  const rows = await MonitorResultModel.aggregate<MonitorRow>([
    { $match: { websiteId: { $in: [...websiteIds] }, checkedAt: { $lte: to } } },
    { $sort: { checkedAt: -1 } },
    {
      $group: {
        _id: { websiteId: '$websiteId', type: '$type' },
        latest: { $first: '$$ROOT' },
      },
    },
    { $replaceRoot: { newRoot: '$latest' } },
  ]).exec();

  const byWebsite = new Map<string, MonitorRow[]>();
  for (const row of rows) {
    const key = row.websiteId.toHexString();
    const existing = byWebsite.get(key);
    if (existing) existing.push(row);
    else byWebsite.set(key, [row]);
  }

  return byWebsite;
}

function buildSection(
  website: WebsiteRow,
  checkTotals: ReadonlyMap<string, CheckAggregate>,
  incidents: readonly IncidentRow[],
  monitorResults: ReadonlyMap<string, MonitorRow[]>,
): ReportWebsiteSection {
  const id = website._id.toHexString();
  const totals = checkTotals.get(id);

  const own = incidents.filter((incident) => incident.websiteId.toHexString() === id);
  const availability = own.filter(
    (incident) => (incident.category ?? 'availability') === 'availability',
  );

  const durations = availability
    .map((incident) => incident.durationSeconds)
    .filter((duration): duration is number => duration !== null);

  const monitors: ReportMonitorSummary[] = (monitorResults.get(id) ?? [])
    .map((row) => ({
      type: row.type,
      status: row.status,
      summary: row.summary,
      checkedAt: row.checkedAt.toISOString(),
      findingCount: row.findings.length,
    }))
    .sort((a, b) => a.type.localeCompare(b.type));

  return {
    websiteId: id,
    name: website.name,
    url: website.url,
    totalChecks: totals?.totalChecks ?? 0,
    successfulChecks: totals?.successfulChecks ?? 0,
    // Null, not 100%, when nothing was measured.
    uptimePercentage: totals
      ? calculateUptimePercentage(totals.successfulChecks, totals.totalChecks)
      : null,
    averageResponseTimeMs: round(totals?.averageResponseTimeMs),
    fastestResponseTimeMs: round(totals?.fastestResponseTimeMs),
    slowestResponseTimeMs: round(totals?.slowestResponseTimeMs),
    // Availability incidents only: a certificate warning is not downtime, and
    // counting it as such would make every uptime figure in the report wrong.
    incidentCount: availability.length,
    /*
     * Summed from the incidents' own recorded durations where they have one,
     * with the failed-check estimate as the fallback for an outage that is
     * still open. The incident duration is exact; the estimate is bounded by
     * the polling interval and is the best available for an ongoing outage.
     */
    totalDowntimeSeconds:
      durations.reduce((sum, duration) => sum + duration, 0) +
      (availability.length > durations.length && totals
        ? estimateDowntimeSeconds(
            totals.totalChecks - totals.successfulChecks,
            website.monitoringIntervalSeconds,
          )
        : 0),
    longestIncidentSeconds: durations.length > 0 ? Math.max(...durations) : null,
    monitors,
  };
}
