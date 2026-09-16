import {
  buildIncidentFacts,
  type AnalysisCheck,
  type IncidentFacts,
} from '../ai/incident-facts.js';
import { buildIncidentAnalysisPrompt, normalizeAnalysisMarkdown } from '../ai/incident-prompt.js';
import { LanguageModelError, type LanguageModel } from '../ai/language-model.js';
import { limitsFor, planHasFeature } from '../contracts/index.js';
import type { PlanLookup } from '../monitoring/plan-lookup.js';
import {
  completeAnalysis,
  retryAnalysis,
  settleAnalysisWithout,
  type ClaimedAnalysis,
} from '../queues/incident-analysis.queue.js';
import type { IncidentRecord } from '../repositories/incident.repository.js';
import type { IncidentAnalysisRepository } from '../repositories/incident-analysis.repository.js';
import type { AuditService } from '../services/audit.service.js';
import { createLogger } from '../utils/logger.js';
import { retryDelaySeconds } from './channel-delivery.job.js';

const logger = createLogger('incident-analysis');

export interface IncidentAnalysisJobOptions {
  readonly maxAttempts: number;
  readonly maxOutputTokens: number;
}

export interface IncidentAnalysisJobDependencies {
  readonly repository: IncidentAnalysisRepository;
  readonly model: LanguageModel;
  readonly plans: PlanLookup;
  readonly audit: AuditService;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * How much of the website's history around the incident the model sees.
 *
 * An hour before shows what normal looked like and whether it was already
 * wobbling; fifteen minutes after shows whether the recovery held.
 */
const LOOKBACK_MS = 60 * MINUTE_MS;
const LOOKAHEAD_MS = 15 * MINUTE_MS;

/** Checks loaded from each side of the window. Enough for a baseline, never a scan. */
const MAX_CHECKS_BEFORE = 500;
const MAX_CHECKS_AFTER = 200;

/**
 * Checks loaded from inside the incident. A longer incident loads its first and
 * last halves of this — how it began and how it ended — and says how many
 * checks in between were left out.
 */
const MAX_CHECKS_DURING = 4_000;

/** First retry after a minute, then four times longer each time. */
const RETRY_BASE_SECONDS = 60;

/**
 * Writes one incident's analysis, and records how it went.
 *
 * The order is deliberate. Everything that can refuse without spending money —
 * the incident still existing, the plan, the monthly allowance — is settled
 * before the provider is called, and the allowance is *reserved* rather than
 * checked, so concurrent analyses cannot overspend it. A generation that then
 * produces nothing gives its reservation back.
 *
 * Nothing here throws to the caller. A fault in this process — the database,
 * most likely — is logged and left to the lease: the attempt was counted at
 * claim time, so one that faults every time still runs out.
 */
export async function runIncidentAnalysis(
  claimed: ClaimedAnalysis,
  options: IncidentAnalysisJobOptions,
  dependencies: IncidentAnalysisJobDependencies,
): Promise<void> {
  const { repository, model, plans, audit } = dependencies;
  const context = { incidentId: claimed.incidentId.toHexString(), attempt: claimed.attempts };

  try {
    if (claimed.attempts > options.maxAttempts) {
      await settleAnalysisWithout(
        claimed.incidentId,
        'failed',
        'The analysis could not be completed after several attempts.',
      );
      return;
    }

    const incident = await repository.findIncidentById(claimed.organizationId, claimed.incidentId);
    if (incident?.status !== 'resolved' || incident.resolvedAt === null) {
      await settleAnalysisWithout(
        claimed.incidentId,
        'skipped',
        'The incident is no longer resolved, so there is nothing to summarise yet.',
      );
      return;
    }

    const plan = await plans.planOf(claimed.organizationId);
    if (!plan || !planHasFeature(plan, 'ai_insights')) {
      await settleAnalysisWithout(
        claimed.incidentId,
        'skipped',
        "The organization's plan does not include AI analysis.",
      );
      return;
    }

    const reservedAt = new Date();
    const reserved = await repository.reserveGeneration(
      claimed.organizationId,
      reservedAt,
      limitsFor(plan).aiGenerationsPerMonth,
    );
    if (!reserved) {
      await settleAnalysisWithout(
        claimed.incidentId,
        'skipped',
        "This month's AI analysis allowance is used up.",
      );
      return;
    }

    let summary: string;
    let completion: Awaited<ReturnType<LanguageModel['complete']>>;
    let websiteName: string | undefined;
    try {
      const gathered = await gatherFacts(repository, incident, incident.resolvedAt);
      websiteName = gathered.website?.name;
      completion = await model.complete(
        buildIncidentAnalysisPrompt(gathered, options.maxOutputTokens),
      );
      const normalized = normalizeAnalysisMarkdown(completion.text, completion.truncated);
      if (normalized === null) {
        throw new LanguageModelError('The model answered without a usable summary.', {
          retryable: true,
        });
      }
      summary = normalized;
    } catch (error) {
      await repository.releaseGeneration(claimed.organizationId, reservedAt);
      throw error;
    }

    const at = new Date();
    const stored = await completeAnalysis(claimed.incidentId, {
      at,
      summary,
      provider: model.provider,
      model: model.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
    });
    if (!stored) return;

    logger.info(
      { ...context, outputTokens: completion.outputTokens, truncated: completion.truncated },
      'incident_analysis.completed',
    );

    await audit.record({
      organizationId: claimed.organizationId,
      action: 'ai.analysis_generated',
      actorUserId: claimed.requestedByUserId,
      actorName: claimed.requestedByName ?? 'SiteOps',
      targetType: 'incident',
      targetId: claimed.incidentId,
      ...(websiteName === undefined ? {} : { targetLabel: websiteName }),
    });
  } catch (error) {
    if (error instanceof LanguageModelError) {
      await settleFailure(claimed, options, error).catch((settleError: unknown) => {
        logger.error({ ...context, err: settleError }, 'incident_analysis.settle_failed');
      });
      return;
    }
    logger.error({ ...context, err: error }, 'incident_analysis.job_failed');
  }
}

async function settleFailure(
  claimed: ClaimedAnalysis,
  options: IncidentAnalysisJobOptions,
  error: LanguageModelError,
): Promise<void> {
  const context = { incidentId: claimed.incidentId.toHexString(), attempt: claimed.attempts };

  if (error.retryable && claimed.attempts < options.maxAttempts) {
    const delay = retryDelaySeconds(claimed.attempts, RETRY_BASE_SECONDS, error.retryAfterSeconds);
    await retryAnalysis(claimed.incidentId, {
      nextAttemptAt: new Date(Date.now() + delay * 1000),
      failureReason: error.message,
    });
    logger.warn(
      { ...context, statusCode: error.statusCode, retryInSeconds: delay },
      'incident_analysis.retrying',
    );
    return;
  }

  await settleAnalysisWithout(claimed.incidentId, 'failed', error.message);
  logger.error(
    { ...context, statusCode: error.statusCode, reason: error.message },
    'incident_analysis.failed',
  );
}

/** Reads everything the analysis is built from. */
async function gatherFacts(
  repository: IncidentAnalysisRepository,
  incident: IncidentRecord,
  resolvedAt: Date,
): Promise<IncidentFacts> {
  const { organizationId, websiteId, startedAt } = incident;
  const windowStart = new Date(startedAt.getTime() - LOOKBACK_MS);
  const windowEnd = new Date(Math.min(resolvedAt.getTime() + LOOKAHEAD_MS, Date.now()));
  const monthAgo = new Date(resolvedAt.getTime() - 30 * DAY_MS);

  const [website, before, during, after, related, incidentsLast30Days, sameCategoryLast30Days] =
    await Promise.all([
      repository.websiteFor(organizationId, websiteId),
      repository
        .checks(
          websiteId,
          { $gte: windowStart, $lt: startedAt },
          { limit: MAX_CHECKS_BEFORE, newestFirst: true },
        )
        .then((rows) => rows.reverse()),
      checksDuring(repository, incident, resolvedAt),
      repository.checks(
        websiteId,
        { $gt: resolvedAt, $lte: windowEnd },
        { limit: MAX_CHECKS_AFTER },
      ),
      repository.relatedIncidents(organizationId, websiteId, incident._id, windowStart, windowEnd),
      repository.countIncidentsSince(organizationId, websiteId, monthAgo),
      repository.countIncidentsSince(organizationId, websiteId, monthAgo, incident.category),
    ]);

  return buildIncidentFacts({
    incident: {
      type: incident.type,
      category: incident.category,
      severity: incident.severity,
      detail: incident.detail,
      startedAt,
      resolvedAt,
      durationSeconds: incident.durationSeconds,
      failedCheckCount: incident.failedCheckCount,
      lastStatusCode: incident.lastStatusCode,
      lastErrorType: incident.lastErrorType,
      lastErrorMessage: incident.lastErrorMessage,
      resolvedManually: incident.resolvedByUserId !== null,
    },
    // The hostname, not the URL: a path or query string can carry a token, and
    // the host is all an explanation of an outage needs.
    website: website
      ? {
          name: website.name,
          host: hostOf(website.url),
          checkIntervalSeconds: website.monitoringIntervalSeconds,
        }
      : null,
    checks: { before, during: during.checks, after, omittedDuring: during.omitted },
    relatedIncidents: related,
    history: {
      // Both counts include this incident; "the third this month" is the point.
      incidentsLast30Days,
      sameCategoryLast30Days,
    },
  });
}

async function checksDuring(
  repository: IncidentAnalysisRepository,
  incident: IncidentRecord,
  resolvedAt: Date,
): Promise<{ readonly checks: readonly AnalysisCheck[]; readonly omitted: number }> {
  const range = { $gte: incident.startedAt, $lte: resolvedAt };
  const total = await repository.countChecks(incident.websiteId, range);

  if (total <= MAX_CHECKS_DURING) {
    return {
      checks: await repository.checks(incident.websiteId, range, { limit: MAX_CHECKS_DURING }),
      omitted: 0,
    };
  }

  const half = MAX_CHECKS_DURING / 2;
  const [first, last] = await Promise.all([
    repository.checks(incident.websiteId, range, { limit: half }),
    repository.checks(incident.websiteId, range, { limit: half, newestFirst: true }),
  ]);
  return { checks: [...first, ...last.reverse()], omitted: total - MAX_CHECKS_DURING };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
