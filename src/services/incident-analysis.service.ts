import { isAnalyzableIncidentCategory, type IncidentAnalysisDto } from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type { IncidentRecord } from '../repositories/incident.repository.js';
import type { IncidentAnalysisRepository } from '../repositories/incident-analysis.repository.js';
import type { Actor } from '../types/auth.types.js';
import type { OrganizationContext } from '../types/common.types.js';
import { createLogger } from '../utils/logger.js';
import { toObjectId } from '../utils/object-id.js';
import type { EntitlementService } from './entitlement.service.js';
import type { IncidentAnalysisScheduler } from './incident-analysis-scheduler.js';

const logger = createLogger('incident-analysis');

export interface IncidentAnalysisServiceOptions {
  readonly repository: IncidentAnalysisRepository;
  readonly entitlements: EntitlementService;
  readonly scheduler: IncidentAnalysisScheduler;
}

/**
 * Reading an incident's AI analysis, and asking for one.
 *
 * Writing it is the worker's job — see `jobs/incident-analysis.job.ts`. This
 * service only queues: a request returns at once with the analysis pending,
 * and the summary appears when the worker has written it.
 */
export class IncidentAnalysisService {
  private readonly repository: IncidentAnalysisRepository;
  private readonly entitlements: EntitlementService;
  private readonly scheduler: IncidentAnalysisScheduler;

  constructor(options: IncidentAnalysisServiceOptions) {
    this.repository = options.repository;
    this.entitlements = options.entitlements;
    this.scheduler = options.scheduler;
  }

  /**
   * An incident's analysis.
   *
   * Readable after a downgrade: a summary already written was paid for, and
   * hiding it would only hide it. A client membership sees the analysis of its
   * own websites' incidents and nothing else.
   */
  async get(organization: OrganizationContext, incidentId: string): Promise<IncidentAnalysisDto> {
    const incident = await this.requireIncident(organization, incidentId);
    if (!incident.analysis) {
      throw ApiError.notFound(
        'INCIDENT_ANALYSIS_NOT_FOUND',
        'This incident has not been analysed.',
      );
    }
    return toIncidentAnalysisDto(incident);
  }

  /**
   * Queues an analysis now, for a resolved outage or slowdown.
   *
   * Idempotent while one is pending: asking twice returns the same pending
   * analysis rather than queuing, and paying for, a second. The monthly
   * allowance is checked here for a clear refusal and reserved again by the
   * worker, which is the check that actually holds under concurrency.
   */
  async request(
    organization: OrganizationContext,
    incidentId: string,
    actor: Actor,
  ): Promise<IncidentAnalysisDto> {
    if (!this.scheduler.enabled) {
      throw new ApiError(
        503,
        'AI analysis is not configured on this deployment.',
        'AI_NOT_CONFIGURED',
      );
    }
    this.entitlements.assertFeature(organization, 'ai_insights');

    const incident = await this.requireIncident(organization, incidentId);
    if (incident.status !== 'resolved') {
      throw ApiError.conflict(
        'INCIDENT_NOT_RESOLVED',
        'An incident can be analysed once it is resolved.',
      );
    }
    if (!isAnalyzableIncidentCategory(incident.category)) {
      throw ApiError.badRequest(
        'VALIDATION_ERROR',
        'AI analysis covers outages and response-time slowdowns.',
      );
    }
    if (incident.analysis?.status === 'pending') return toIncidentAnalysisDto(incident);

    await this.entitlements.assertWithinLimit(organization, 'aiGenerationsPerMonth');

    const queued = await this.repository.requestAnalysis(organization.objectId, incident._id, {
      now: new Date(),
      requestedByUserId: toObjectId(actor.id),
      requestedByName: actor.name,
    });
    if (queued) return toIncidentAnalysisDto(queued);

    // Queued by someone else between the read and the write: theirs stands.
    return toIncidentAnalysisDto(await this.requireIncident(organization, incidentId));
  }

  /**
   * Queues the automatic analysis after a person resolves an incident by hand.
   *
   * Never throws: closing the incident is what was asked for, and it has
   * already happened.
   */
  async afterManualResolution(
    organization: OrganizationContext,
    incident: IncidentRecord,
  ): Promise<void> {
    try {
      await this.scheduler.afterResolution(incident._id, organization.plan);
    } catch (error) {
      logger.error(
        { err: error, incidentId: incident._id.toHexString() },
        'incident_analysis.enqueue_failed',
      );
    }
  }

  private async requireIncident(
    organization: OrganizationContext,
    incidentId: string,
  ): Promise<IncidentRecord> {
    const incident = await this.repository.findIncident(
      organization.objectId,
      incidentId,
      organization.clientScope,
    );
    if (!incident) throw ApiError.notFound('INCIDENT_NOT_FOUND', 'Incident not found.');
    return incident;
  }
}

export function toIncidentAnalysisDto(incident: IncidentRecord): IncidentAnalysisDto {
  const analysis = incident.analysis;
  if (!analysis) {
    throw new Error('toIncidentAnalysisDto called for an incident without an analysis.');
  }

  return {
    incidentId: incident._id.toHexString(),
    status: analysis.status,
    summary: analysis.summary,
    provider: analysis.provider,
    model: analysis.model,
    generatedAt: analysis.generatedAt?.toISOString() ?? null,
    requestedAt: analysis.requestedAt.toISOString(),
    requestedByName: analysis.requestedByName,
    // On a pending analysis this is why the last attempt is being retried.
    failureReason: analysis.status === 'completed' ? null : analysis.failureReason,
  };
}
