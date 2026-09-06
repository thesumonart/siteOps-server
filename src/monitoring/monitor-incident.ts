import type { Types } from 'mongoose';

import type {
  IncidentCategory,
  IncidentSeverity,
  IncidentType,
  MonitorStatus,
  MonitorType,
} from '../contracts/index.js';
import { categoryForIncidentType } from '../contracts/index.js';
import { IncidentModel } from '../models/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('monitor-incident');

/**
 * Opens and resolves the incidents raised by the auxiliary monitors.
 *
 * Separate from `incident-processor.ts` because the two decide differently.
 * Uptime needs consecutive-failure thresholds, because one dropped packet is
 * not an outage. These monitors do not: a certificate that expires in four days
 * expires in four days on every run, and running it three times before saying
 * so would only delay the alert. One bad result opens the incident; one good
 * result closes it.
 *
 * Deduplication is the same mechanism as uptime — the unique partial index on
 * `(websiteId, category)` where `status: 'open'` — so a race loses at the
 * database rather than in application bookkeeping, and an SSL incident and an
 * outage can be open at the same time.
 */

/** Which incident type each monitor raises, and how severe each status is. */
const INCIDENT_TYPE_BY_MONITOR: Record<MonitorType, IncidentType> = {
  ssl: 'ssl_invalid',
  domain: 'domain_expiring',
  performance: 'performance_degraded',
  content: 'content_changed',
  seo: 'seo_regression',
  links: 'broken_links',
};

/**
 * `ssl` is the exception: an expiring certificate and an invalid one are
 * different problems with different urgency, and the alert reads very
 * differently, so the warning case gets its own type.
 */
function incidentTypeFor(monitorType: MonitorType, status: MonitorStatus): IncidentType {
  if (monitorType === 'ssl' && status === 'warning') return 'ssl_expiring';
  return INCIDENT_TYPE_BY_MONITOR[monitorType];
}

function severityFor(status: MonitorStatus): IncidentSeverity {
  return status === 'failing' ? 'critical' : 'warning';
}

export interface MonitorIncidentContext {
  readonly organizationId: Types.ObjectId;
  readonly websiteId: Types.ObjectId;
  readonly monitorType: MonitorType;
  readonly status: MonitorStatus;
  readonly detail: string;
  readonly checkedAt: Date;
}

export interface MonitorIncidentResult {
  readonly openIncidentId: Types.ObjectId | null;
  readonly newlyOpenedIncidentId: Types.ObjectId | null;
  readonly newlyResolvedIncidentId: Types.ObjectId | null;
}

const NOTHING: MonitorIncidentResult = {
  openIncidentId: null,
  newlyOpenedIncidentId: null,
  newlyResolvedIncidentId: null,
};

/**
 * Reconciles the monitor's verdict with its open incident.
 *
 * The `error` case is the one worth reading twice: it leaves everything alone.
 * A registry that timed out has told us nothing, so an open "domain expiring"
 * incident must stay open — resolving it would send a recovery notification for
 * a problem that has not gone away. Equally it must not open one, because
 * nothing is known to be wrong.
 */
export async function applyMonitorIncident(
  currentIncidentId: Types.ObjectId | null,
  context: MonitorIncidentContext,
): Promise<MonitorIncidentResult> {
  if (context.status === 'error' || context.status === 'unknown') {
    return { ...NOTHING, openIncidentId: currentIncidentId };
  }

  const type = incidentTypeFor(context.monitorType, context.status);
  const category = categoryForIncidentType(type);

  if (context.status === 'passing') {
    return currentIncidentId === null
      ? NOTHING
      : resolveIncident(currentIncidentId, context.checkedAt, context.websiteId);
  }

  // Still a problem, and one is already open: refresh what it says rather than
  // opening a second. The type can change within a category — a certificate
  // that was expiring is now invalid — and the incident should say so.
  if (currentIncidentId !== null) {
    const updated = await IncidentModel.updateOne(
      { _id: currentIncidentId, status: 'open' },
      {
        $set: {
          type,
          severity: severityFor(context.status),
          detail: context.detail,
        },
        $inc: { failedCheckCount: 1 },
      },
    ).exec();

    if (updated.matchedCount > 0) {
      return { ...NOTHING, openIncidentId: currentIncidentId };
    }
    // The incident was closed underneath us; fall through and open a new one.
  }

  return openIncident(type, category, context);
}

async function openIncident(
  type: IncidentType,
  category: IncidentCategory,
  context: MonitorIncidentContext,
): Promise<MonitorIncidentResult> {
  try {
    const created = await IncidentModel.create({
      organizationId: context.organizationId,
      websiteId: context.websiteId,
      status: 'open',
      type,
      category,
      severity: severityFor(context.status),
      detail: context.detail,
      startedAt: context.checkedAt,
      failedCheckCount: 1,
    });

    logger.info(
      {
        websiteId: context.websiteId.toHexString(),
        incidentId: created._id.toHexString(),
        monitorType: context.monitorType,
        category,
      },
      'monitor.incident_created',
    );

    return {
      openIncidentId: created._id,
      newlyOpenedIncidentId: created._id,
      newlyResolvedIncidentId: null,
    };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    // Another run already opened one for this category. Adopt it rather than
    // treating this as a fresh open, so no second notification fires.
    const existing = await IncidentModel.findOne({
      websiteId: context.websiteId,
      category,
      status: 'open',
    })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>()
      .exec();

    logger.warn(
      { websiteId: context.websiteId.toHexString(), category },
      'monitor.incident_open_race_detected',
    );

    return { ...NOTHING, openIncidentId: existing?._id ?? null };
  }
}

async function resolveIncident(
  incidentId: Types.ObjectId,
  resolvedAt: Date,
  websiteId: Types.ObjectId,
): Promise<MonitorIncidentResult> {
  const open = await IncidentModel.findOne({ _id: incidentId, status: 'open' })
    .select({ startedAt: 1 })
    .lean<{ startedAt: Date }>()
    .exec();

  if (!open) return NOTHING;

  const durationSeconds = Math.max(
    0,
    Math.round((resolvedAt.getTime() - open.startedAt.getTime()) / 1000),
  );

  // Conditioned on `status: 'open'` in the filter, so a concurrent resolver
  // loses cleanly instead of double-resolving and double-notifying.
  const result = await IncidentModel.updateOne(
    { _id: incidentId, status: 'open' },
    { $set: { status: 'resolved', resolvedAt, durationSeconds } },
  ).exec();

  if (result.modifiedCount === 0) return NOTHING;

  logger.info(
    { websiteId: websiteId.toHexString(), incidentId: incidentId.toHexString() },
    'monitor.incident_resolved',
  );

  return { openIncidentId: null, newlyOpenedIncidentId: null, newlyResolvedIncidentId: incidentId };
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}
