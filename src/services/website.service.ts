import type {
  CreateWebsiteInput,
  ListWebsitesQuery,
  OffsetPaginatedResult,
  UpdateWebsiteInput,
  WebsiteDto,
  WebsiteSummaryDto,
} from '../contracts/index.js';
import {
  buildOffsetMeta,
  calculateUptimePercentage,
  limitsFor,
  normalizeWebsiteUrl,
} from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type { Types } from 'mongoose';

import type { CheckResultRepository } from '../repositories/check-result.repository.js';
import type { IncidentRepository } from '../repositories/incident.repository.js';
import type { WebsiteRecord, WebsiteRepository } from '../repositories/website.repository.js';
import type { Actor } from '../types/auth.types.js';
import type { OrganizationContext } from '../types/common.types.js';
import { createLogger } from '../utils/logger.js';
import { toObjectId } from '../utils/object-id.js';
import type { AuditService } from './audit.service.js';

const logger = createLogger('websites');

/** MongoDB's duplicate-key error number. */
const DUPLICATE_KEY = 11000;

/** The window the website table's uptime and response-time columns cover. */
const SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/**
 * A rejected URL is either an address that must never be reached or input that
 * is simply malformed, and the dashboard shows a different message for each.
 */
function urlRejection(reason: string, detail: string): ApiError {
  return ApiError.badRequest(
    reason === 'blocked_ip' || reason === 'blocked_hostname'
      ? 'BLOCKED_WEBSITE_URL'
      : 'INVALID_WEBSITE_URL',
    detail,
  );
}

export class WebsiteService {
  constructor(
    private readonly repository: WebsiteRepository,
    private readonly checks: CheckResultRepository,
    private readonly incidents: IncidentRepository,
    private readonly audit: AuditService,
    /**
     * Resolves a client id within an organization, or null.
     *
     * A function rather than the repository, so this service does not depend on
     * client management to assign a website to one — and so the dependency is
     * one query rather than a whole module.
     */
    private readonly clientExists: (
      organizationId: Types.ObjectId,
      clientId: string,
    ) => Promise<Types.ObjectId | null>,
  ) {}

  /**
   * Lists websites with the 24-hour figures the table shows beside each row.
   *
   * The rollups are two organization-wide reads for the whole page rather than
   * two per row: a table of fifty sites must not become a hundred round trips.
   */
  async findAll(
    organization: OrganizationContext,
    query: ListWebsitesQuery,
  ): Promise<OffsetPaginatedResult<WebsiteSummaryDto>> {
    const { items, totalItems } = await this.repository.list({
      organizationId: organization.objectId,
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      status: query.status,
      // From the membership, never the request. A client contact sees their
      // own websites and cannot widen this by asking.
      clientScope: organization.clientScope,
      clientId: query.clientId,
    });

    const pagination = buildOffsetMeta(query.page, query.pageSize, totalItems);
    if (items.length === 0) return { items: [], pagination };

    const since = new Date(Date.now() - SUMMARY_WINDOW_MS);
    const [totals, openIncidentIds] = await Promise.all([
      this.checks.totalsByWebsite(organization.objectId, since),
      this.incidents.openIncidentIdsFor(
        organization.objectId,
        items.map((website) => website._id),
      ),
    ]);

    return {
      items: items.map((website) => {
        const id = website._id.toHexString();
        const websiteTotals = totals.get(id);

        return {
          ...toWebsiteDto(website),
          // Null, not 100%, when nothing has been measured yet. An unchecked
          // website is not a healthy one.
          uptimePercentage24h: websiteTotals
            ? calculateUptimePercentage(websiteTotals.successfulChecks, websiteTotals.totalChecks)
            : null,
          averageResponseTimeMs24h: websiteTotals?.averageResponseTimeMs ?? null,
          openIncidentId: openIncidentIds.get(id) ?? null,
        };
      }),
      pagination,
    };
  }

  async findById(organization: OrganizationContext, websiteId: string): Promise<WebsiteDto> {
    return toWebsiteDto(await this.requireWebsite(organization, websiteId));
  }

  /**
   * Adds a website to the organization.
   *
   * The URL has already been normalized by `createWebsiteSchema`; it is
   * re-normalized here to derive the canonical key, because the service must
   * hold on its own rather than trusting that a caller used the middleware.
   */
  async create(
    organization: OrganizationContext,
    input: CreateWebsiteInput,
    actor: Actor,
  ): Promise<WebsiteDto> {
    const normalized = normalizeWebsiteUrl(input.url);
    if (!normalized.ok) {
      // The string-level SSRF check. The authoritative one runs in the worker
      // against the resolved address, immediately before connecting.
      throw urlRejection(normalized.reason, normalized.detail);
    }

    await this.assertWithinPlan(organization, input.monitoringIntervalSeconds);

    try {
      const website = await this.repository.create({
        organizationId: organization.objectId,
        name: input.name,
        url: normalized.value.href,
        canonicalKey: normalized.value.canonicalKey,
        monitoringIntervalSeconds: input.monitoringIntervalSeconds,
        requestTimeoutMs: input.requestTimeoutMs,
        failureThreshold: input.failureThreshold,
        recoveryThreshold: input.recoveryThreshold,
      });

      await this.audit.record({
        organizationId: organization.objectId,
        action: 'website.created',
        actorUserId: toObjectId(actor.id),
        actorName: actor.name,
        targetType: 'website',
        targetId: website._id,
        targetLabel: website.name,
      });

      logger.info(
        { organizationId: organization.id, websiteId: website._id.toHexString() },
        'website.created',
      );

      return toWebsiteDto(website);
    } catch (error) {
      // The unique index is the real guarantee, so a double-submitted form
      // surfaces here rather than creating a second monitor.
      if (isDuplicateKeyError(error)) {
        throw ApiError.conflict(
          'WEBSITE_URL_ALREADY_MONITORED',
          'This organization is already monitoring that URL.',
        );
      }
      throw error;
    }
  }

  async update(
    organization: OrganizationContext,
    websiteId: string,
    input: UpdateWebsiteInput,
    actor: Actor,
  ): Promise<WebsiteDto> {
    const existing = await this.requireWebsite(organization, websiteId);

    const changes: Parameters<WebsiteRepository['update']>[2] = {};

    if (input.name !== undefined) changes.name = input.name;

    if (input.url !== undefined) {
      const normalized = normalizeWebsiteUrl(input.url);
      if (!normalized.ok) throw urlRejection(normalized.reason, normalized.detail);

      changes.url = normalized.value.href;
      changes.canonicalKey = normalized.value.canonicalKey;

      // Pointing at a different address makes the accumulated failure and
      // recovery counters meaningless, so the confirmation state restarts.
      if (normalized.value.canonicalKey !== existing.canonicalKey) {
        changes.consecutiveFailures = 0;
        changes.consecutiveSuccesses = 0;
        changes.status = existing.monitoringEnabled ? 'unknown' : 'paused';
        changes.nextCheckAt = new Date();
      }
    }

    if (input.monitoringIntervalSeconds !== undefined) {
      await this.assertWithinPlan(organization, input.monitoringIntervalSeconds, {
        countsTowardsLimit: false,
      });
      changes.monitoringIntervalSeconds = input.monitoringIntervalSeconds;
    }
    if (input.requestTimeoutMs !== undefined) changes.requestTimeoutMs = input.requestTimeoutMs;
    if (input.failureThreshold !== undefined) changes.failureThreshold = input.failureThreshold;
    if (input.recoveryThreshold !== undefined) changes.recoveryThreshold = input.recoveryThreshold;

    if (input.clientId !== undefined) {
      // Null clears the assignment. A non-null id is checked against this
      // organization's clients before it is stored, so a website can never be
      // assigned to another agency's client.
      changes.clientId =
        input.clientId === null ? null : await this.resolveClient(organization, input.clientId);
    }

    try {
      const updated = await this.repository.update(organization.objectId, websiteId, changes);
      if (!updated) throw ApiError.notFound('WEBSITE_NOT_FOUND', 'Website not found.');

      await this.audit.record({
        organizationId: organization.objectId,
        action: 'website.updated',
        actorUserId: toObjectId(actor.id),
        actorName: actor.name,
        targetType: 'website',
        targetId: updated._id,
        targetLabel: updated.name,
      });

      return toWebsiteDto(updated);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw ApiError.conflict(
          'WEBSITE_URL_ALREADY_MONITORED',
          'This organization is already monitoring that URL.',
        );
      }
      throw error;
    }
  }

  async delete(organization: OrganizationContext, websiteId: string, actor: Actor): Promise<void> {
    const deleted = await this.repository.delete(organization.objectId, websiteId);
    if (!deleted) {
      throw ApiError.notFound('WEBSITE_NOT_FOUND', 'Website not found.');
    }

    // Incidents and monitors are few and are removed with the website. A
    // monitor especially must not survive: it is a queue document the worker
    // would go on claiming for a website that no longer exists.
    await this.repository.deleteIncidentsFor(deleted._id);
    await this.repository.deleteMonitorsFor(deleted._id);
    // Checks can number in the hundreds of thousands, so they are cleaned up
    // without blocking the response — they are unreachable once the website is
    // gone (every query scopes by websiteId) and expire via the TTL index.
    void this.repository
      .deleteChecksFor(deleted._id)
      .then((count) => {
        logger.info({ websiteId: deleted._id.toHexString(), count }, 'website.checks_purged');
      })
      .catch((error: unknown) => {
        logger.error(
          { err: error, websiteId: deleted._id.toHexString() },
          'website.checks_purge_failed',
        );
      });

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'website.deleted',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'website',
      targetId: deleted._id,
      targetLabel: deleted.name,
    });

    logger.info(
      { organizationId: organization.id, websiteId: deleted._id.toHexString() },
      'website.deleted',
    );
  }

  /**
   * Resolves a website within the tenant, or 404s. Every read starts here.
   *
   * "Within the tenant" means both the organization *and*, for a client
   * membership, that client. A website belonging to a different client of the
   * same agency does not resolve, which is the whole of the portal's isolation
   * guarantee.
   */
  async requireWebsite(
    organization: OrganizationContext,
    websiteId: string,
  ): Promise<WebsiteRecord> {
    const website = await this.repository.findById(
      organization.objectId,
      websiteId,
      organization.clientScope,
    );
    if (!website) {
      throw ApiError.notFound('WEBSITE_NOT_FOUND', 'Website not found.');
    }
    return website;
  }

  /**
   * Resolves a client id within this organization.
   *
   * Injected rather than imported so the website service does not depend on the
   * client repository: the check is one existence query, and the caller passes
   * the resolver in. See the composition root.
   */
  private async resolveClient(
    organization: OrganizationContext,
    clientId: string,
  ): Promise<Types.ObjectId> {
    const resolved = await this.clientExists(organization.objectId, clientId);
    if (!resolved) {
      throw ApiError.notFound('CLIENT_NOT_FOUND', 'Client not found.');
    }
    return resolved;
  }

  /**
   * Plan limits, read from the organization's stored plan.
   *
   * Nothing about a plan is ever taken from the client, and both the count cap
   * and the minimum interval are checked here rather than in the controller so
   * that any caller — including the worker — goes through the same path.
   */
  private async assertWithinPlan(
    organization: OrganizationContext,
    intervalSeconds: number,
    options: { readonly countsTowardsLimit?: boolean } = {},
  ): Promise<void> {
    const limits = limitsFor(organization.plan);

    if (options.countsTowardsLimit !== false) {
      const current = await this.repository.countForOrganization(organization.objectId);
      if (current >= limits.maxWebsites) {
        throw ApiError.planLimit(
          `The ${organization.plan} plan monitors up to ${String(limits.maxWebsites)} websites. Upgrade to add more.`,
        );
      }
    }

    if (intervalSeconds < limits.minMonitoringIntervalSeconds) {
      throw ApiError.planLimit(
        `The ${organization.plan} plan checks at most every ${String(limits.minMonitoringIntervalSeconds / 60)} minutes.`,
      );
    }
  }
}

export function toWebsiteDto(website: WebsiteRecord): WebsiteDto {
  return {
    id: website._id.toHexString(),
    organizationId: website.organizationId.toHexString(),
    name: website.name,
    url: website.url,
    status: website.status,
    monitoringEnabled: website.monitoringEnabled,
    monitoringIntervalSeconds: website.monitoringIntervalSeconds,
    requestTimeoutMs: website.requestTimeoutMs,
    failureThreshold: website.failureThreshold,
    recoveryThreshold: website.recoveryThreshold,
    lastCheckedAt: website.lastCheckedAt?.toISOString() ?? null,
    lastSuccessfulCheckAt: website.lastSuccessfulCheckAt?.toISOString() ?? null,
    lastFailedAt: website.lastFailedAt?.toISOString() ?? null,
    lastResponseTimeMs: website.lastResponseTimeMs,
    lastStatusCode: website.lastStatusCode,
    clientId: website.clientId?.toHexString() ?? null,
    createdAt: website.createdAt.toISOString(),
    updatedAt: website.updatedAt.toISOString(),
  };
}
