import type { CursorPaginatedResult, IncidentDto, ListIncidentsQuery } from '../contracts/index.js';
import { categoryForIncidentType } from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type { IncidentRecord, IncidentRepository } from '../repositories/incident.repository.js';
import type { WebsiteLabel, WebsiteRepository } from '../repositories/website.repository.js';
import type { Actor } from '../types/auth.types.js';
import type { OrganizationContext } from '../types/common.types.js';
import { decodeOptionalCursor, encodeCursor } from '../utils/pagination.js';
import { toObjectId } from '../utils/object-id.js';
import type { AuditService } from './audit.service.js';

export class IncidentService {
  constructor(
    private readonly repository: IncidentRepository,
    private readonly websites: WebsiteRepository,
    private readonly audit: AuditService,
  ) {}

  async findHistory(
    organization: OrganizationContext,
    query: ListIncidentsQuery,
  ): Promise<CursorPaginatedResult<IncidentDto>> {
    const rows = await this.repository.list({
      organizationId: organization.objectId,
      pageSize: query.pageSize,
      status: query.status,
      category: query.category,
      websiteId: query.websiteId,
      cursor: decodeOptionalCursor(query.cursor),
    });

    // The repository fetches one extra row purely to answer "is there more?".
    const hasNextPage = rows.length > query.pageSize;
    const items = hasNextPage ? rows.slice(0, query.pageSize) : rows;
    const last = items.at(-1);

    const labels = await this.labelsFor(items);

    return {
      items: items.map((incident) =>
        toIncidentDto(incident, labels.get(incident.websiteId.toHexString())),
      ),
      pagination: {
        nextCursor: hasNextPage && last ? encodeCursor(last.startedAt, last._id) : null,
        hasNextPage,
        pageSize: query.pageSize,
      },
    };
  }

  /** Open incidents only, newest first. The dashboard's "what is broken now" view. */
  async findActive(
    organization: OrganizationContext,
    pageSize: number,
  ): Promise<CursorPaginatedResult<IncidentDto>> {
    return this.findHistory(organization, { status: 'open', pageSize });
  }

  async findById(organization: OrganizationContext, incidentId: string): Promise<IncidentDto> {
    const incident = await this.repository.findById(organization.objectId, incidentId);
    if (!incident) {
      throw ApiError.notFound('INCIDENT_NOT_FOUND', 'Incident not found.');
    }

    const labels = await this.labelsFor([incident]);
    return toIncidentDto(incident, labels.get(incident.websiteId.toHexString()));
  }

  /**
   * Closes an incident by hand.
   *
   * For the case the monitor cannot settle on its own: a website that was
   * decommissioned mid-outage, or one whose incident is being kept open by a
   * check that will never succeed again. The website's own status is left to
   * the worker — this records that a person considers the outage over, not that
   * the site is back — and `resolvedByUserId` is what distinguishes it from an
   * automatic recovery in the incident history.
   *
   * The update is conditioned on the incident still being open, so a race with
   * the worker's own resolution loses cleanly rather than double-resolving.
   */
  async resolve(
    organization: OrganizationContext,
    incidentId: string,
    actor: Actor,
  ): Promise<IncidentDto> {
    const incident = await this.repository.findById(organization.objectId, incidentId);
    if (!incident) {
      throw ApiError.notFound('INCIDENT_NOT_FOUND', 'Incident not found.');
    }
    if (incident.status === 'resolved') {
      throw ApiError.conflict('INCIDENT_ALREADY_RESOLVED', 'That incident is already resolved.');
    }

    const actorObjectId = toObjectId(actor.id);
    const resolved = await this.repository.resolveManually(
      organization.objectId,
      incident._id,
      actorObjectId,
    );
    if (!resolved) {
      // Lost the race with the worker; the outage is over either way.
      throw ApiError.conflict('INCIDENT_ALREADY_RESOLVED', 'That incident is already resolved.');
    }

    const labels = await this.labelsFor([resolved]);

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'incident.resolved_manually',
      actorUserId: actorObjectId,
      actorName: actor.name,
      targetType: 'incident',
      targetId: resolved._id,
      targetLabel: labels.get(resolved.websiteId.toHexString())?.name,
    });

    return toIncidentDto(resolved, labels.get(resolved.websiteId.toHexString()));
  }

  /**
   * Resolves website names for a page of incidents in one query.
   *
   * The name is denormalized onto the response rather than onto the document,
   * because renaming a website should change how its past incidents read — the
   * incident is about the site, not about the name it had that day.
   */
  private async labelsFor(
    incidents: readonly IncidentRecord[],
  ): Promise<ReadonlyMap<string, WebsiteLabel>> {
    if (incidents.length === 0) return new Map();

    const websiteIds = [...new Set(incidents.map((incident) => incident.websiteId.toHexString()))];
    const byId = await this.websites.labelsFor(incidents.map((incident) => incident.websiteId));

    return new Map(
      websiteIds.map((id) => {
        const row = byId.get(id);
        // A website deleted after its incidents were purged should not happen —
        // deletion removes both — but a missing row must not blank the page.
        return [id, row ?? { name: 'Deleted website', url: '' }];
      }),
    );
  }
}

export function toIncidentDto(incident: IncidentRecord, website?: WebsiteLabel): IncidentDto {
  return {
    id: incident._id.toHexString(),
    organizationId: incident.organizationId.toHexString(),
    websiteId: incident.websiteId.toHexString(),
    websiteName: website?.name ?? 'Deleted website',
    websiteUrl: website?.url ?? '',
    status: incident.status,
    type: incident.type,
    // Older documents predate the category field; every incident written
    // before it existed was an availability failure.
    category: incident.category ?? categoryForIncidentType(incident.type),
    severity: incident.severity ?? 'critical',
    detail: incident.detail ?? null,
    startedAt: incident.startedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    durationSeconds: incident.durationSeconds,
    failedCheckCount: incident.failedCheckCount,
    lastStatusCode: incident.lastStatusCode,
    lastErrorType: incident.lastErrorType,
    lastErrorMessage: incident.lastErrorMessage,
  };
}
