import type { Types } from 'mongoose';

import { IncidentModel } from '../models/index.js';
import type { CheckErrorType, IncidentCategory, IncidentType } from '../contracts/index.js';

import { createLogger } from '../utils/logger.js';
import { type IncidentTransition } from './incident-rules.js';

const logger = createLogger('incident');

export interface IncidentCheckContext {
  readonly organizationId: Types.ObjectId;
  readonly websiteId: Types.ObjectId;
  readonly checkedAt: Date;
  /** Whether *this* check succeeded, which decides whether it may overwrite
   * the incident's record of the failure. A timeout carries no `errorType`,
   * so the outcome cannot be inferred from the error fields. */
  readonly checkSucceeded: boolean;
  readonly failedCheckCount: number;
  readonly statusCode: number | null;
  readonly errorType: CheckErrorType | null;
  readonly errorMessage: string | null;
}

export interface IncidentApplyResult {
  /** The website's open incident after this check, or null if none is open. */
  readonly openIncidentId: Types.ObjectId | null;
  /** Set only when this call is the one that opened or resolved an incident. */
  readonly newlyOpenedIncidentId: Types.ObjectId | null;
  readonly newlyResolvedIncidentId: Types.ObjectId | null;
}

/**
 * Every other error type — DNS failure, TLS failure, too many redirects, a
 * blocked target, an invalid URL, or no error at all (a bare timeout with no
 * `errorType`) — is reported as generic `downtime`, since `IncidentType` is a
 * coarser, user-facing classification than the checker's own error taxonomy.
 */
const INCIDENT_TYPE_BY_ERROR: Readonly<Partial<Record<CheckErrorType, IncidentType>>> = {
  timeout: 'timeout',
  http_error: 'http_error',
  connection_refused: 'connection_error',
  connection_reset: 'connection_error',
  // A failed TLS handshake is a failure to establish the connection, and
  // `IncidentType` has no finer bucket for it than that.
  ssl_error: 'connection_error',
};

function incidentTypeFor(errorType: CheckErrorType | null): IncidentType {
  if (errorType === null) return 'downtime';
  return INCIDENT_TYPE_BY_ERROR[errorType] ?? 'downtime';
}

/**
 * The category every uptime failure belongs to.
 *
 * Named once here because it appears in the insert, in the duplicate-key
 * read-back and in the availability queries elsewhere; they have to agree or
 * the unique index stops deduplicating.
 */
const AVAILABILITY: IncidentCategory = 'availability';

/**
 * Applies an incident-rules decision to the database.
 *
 * The `open` path relies on the unique partial index
 * (`incident_one_open_per_website_category`) as the actual guarantee against duplicate
 * incidents, not on this function's own logic: if two callers somehow race —
 * the lease should make that impossible, but the index is what makes it
 * impossible even if the lease is ever bypassed — the loser's insert fails
 * with a duplicate-key error, which is caught and treated as "an incident is
 * already open" rather than surfaced as a fault.
 */
export async function applyIncidentTransition(
  transition: IncidentTransition,
  currentIncidentId: Types.ObjectId | null,
  context: IncidentCheckContext,
): Promise<IncidentApplyResult> {
  if (transition === 'none') {
    return { openIncidentId: null, newlyOpenedIncidentId: null, newlyResolvedIncidentId: null };
  }

  if (transition === 'open') {
    return openIncident(context);
  }

  if (currentIncidentId === null) {
    // Should not happen — `resolve`/`ongoing` are only decided when an
    // incident is already open — but a missing id must not throw and abandon
    // the check that got us here.
    logger.error(
      { websiteId: context.websiteId.toHexString(), transition },
      'incident.missing_id_for_transition',
    );
    return { openIncidentId: null, newlyOpenedIncidentId: null, newlyResolvedIncidentId: null };
  }

  if (transition === 'resolve') {
    return resolveIncident(currentIncidentId, context);
  }

  // 'ongoing': count another failed check and refresh the failure details.
  //
  // A *successful* check during an unresolved incident writes nothing. It
  // carries no information about the outage, and letting it through would
  // overwrite the incident's record with a 200 and no error — so a resolved
  // outage would be filed forever as "0 failed checks, HTTP 200", which is
  // both useless and untrue. `failedCheckCount` is incremented rather than
  // assigned for the same reason: it is the number of failed checks seen
  // during this incident, and the website's own consecutive counter resets to
  // zero on any success.
  if (!context.checkSucceeded) {
    await IncidentModel.updateOne(
      { _id: currentIncidentId, status: 'open' },
      {
        $inc: { failedCheckCount: 1 },
        $set: {
          lastStatusCode: context.statusCode,
          lastErrorType: context.errorType,
          lastErrorMessage: context.errorMessage,
        },
      },
    ).exec();
  }

  return {
    openIncidentId: currentIncidentId,
    newlyOpenedIncidentId: null,
    newlyResolvedIncidentId: null,
  };
}

async function openIncident(context: IncidentCheckContext): Promise<IncidentApplyResult> {
  try {
    const created = await IncidentModel.create({
      organizationId: context.organizationId,
      websiteId: context.websiteId,
      status: 'open',
      type: incidentTypeFor(context.errorType),
      category: AVAILABILITY,
      severity: 'critical',
      startedAt: context.checkedAt,
      failedCheckCount: context.failedCheckCount,
      lastStatusCode: context.statusCode,
      lastErrorType: context.errorType,
      lastErrorMessage: context.errorMessage,
    });

    logger.info(
      { websiteId: context.websiteId.toHexString(), incidentId: created._id.toHexString() },
      'incident.created',
    );

    return {
      openIncidentId: created._id,
      newlyOpenedIncidentId: created._id,
      newlyResolvedIncidentId: null,
    };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Another claim already opened one — read it back rather than treating
      // this as our own fresh open (no duplicate notification should fire).
      const existing = await IncidentModel.findOne({
        websiteId: context.websiteId,
        category: AVAILABILITY,
        status: 'open',
      })
        .lean<{ _id: Types.ObjectId }>()
        .exec();

      logger.warn({ websiteId: context.websiteId.toHexString() }, 'incident.open_race_detected');

      return {
        openIncidentId: existing?._id ?? null,
        newlyOpenedIncidentId: null,
        newlyResolvedIncidentId: null,
      };
    }
    throw error;
  }
}

async function resolveIncident(
  incidentId: Types.ObjectId,
  context: IncidentCheckContext,
): Promise<IncidentApplyResult> {
  const open = await IncidentModel.findOne({ _id: incidentId, status: 'open' })
    .select({ startedAt: 1 })
    .lean<{ _id: Types.ObjectId; startedAt: Date }>()
    .exec();

  if (!open) {
    // Already resolved by a concurrent call, or never existed. Either way
    // there is nothing open now, and this call did not resolve it.
    return { openIncidentId: null, newlyOpenedIncidentId: null, newlyResolvedIncidentId: null };
  }

  const durationSeconds = Math.max(
    0,
    Math.round((context.checkedAt.getTime() - open.startedAt.getTime()) / 1000),
  );

  // Conditioned on `status: 'open'` again so a concurrent resolver — should be
  // impossible given the per-website lease, but the guard costs nothing — loses
  // the race cleanly instead of double-resolving.
  const result = await IncidentModel.updateOne(
    { _id: incidentId, status: 'open' },
    { $set: { status: 'resolved', resolvedAt: context.checkedAt, durationSeconds } },
  ).exec();

  if (result.modifiedCount === 0) {
    return { openIncidentId: null, newlyOpenedIncidentId: null, newlyResolvedIncidentId: null };
  }

  logger.info(
    { websiteId: context.websiteId.toHexString(), incidentId: incidentId.toHexString() },
    'incident.resolved',
  );

  return {
    openIncidentId: null,
    newlyOpenedIncidentId: null,
    newlyResolvedIncidentId: incidentId,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}
