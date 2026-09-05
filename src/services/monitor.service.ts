import type { WebsiteDto } from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type { WebsiteRepository } from '../repositories/website.repository.js';
import type { Actor } from '../types/auth.types.js';
import type { OrganizationContext } from '../types/common.types.js';
import { toObjectId } from '../utils/object-id.js';
import type { AuditService } from './audit.service.js';
import { toWebsiteDto, type WebsiteService } from './website.service.js';

/**
 * The monitoring configuration of a website: whether it is checked, and what
 * its current state is.
 *
 * There is no separate `monitors` collection. A website has exactly one
 * monitor, its configuration is what `WebsiteDto` already carries, and the
 * dashboard shows the two as one thing — so splitting them would mean a join on
 * every read to rebuild a document that was never apart. What is separate is
 * this service: enabling and disabling monitoring is a different operation from
 * editing a website, with a different permission (`monitoring:toggle`) and
 * different side effects on the check schedule.
 */
export class MonitorService {
  constructor(
    private readonly repository: WebsiteRepository,
    private readonly websites: WebsiteService,
    private readonly audit: AuditService,
  ) {}

  async enable(
    organization: OrganizationContext,
    websiteId: string,
    actor: Actor,
  ): Promise<WebsiteDto> {
    return this.setEnabled(organization, websiteId, true, actor);
  }

  async disable(
    organization: OrganizationContext,
    websiteId: string,
    actor: Actor,
  ): Promise<WebsiteDto> {
    return this.setEnabled(organization, websiteId, false, actor);
  }

  /**
   * Turns monitoring on or off.
   *
   * Resuming starts from a clean slate rather than continuing a failure streak
   * from before the pause: those checks describe a window nobody was watching,
   * and counting them could confirm an outage the moment monitoring resumes.
   * `nextCheckAt` is set to now so the worker picks the site up on its next
   * pass instead of after a full interval of silence.
   */
  private async setEnabled(
    organization: OrganizationContext,
    websiteId: string,
    enabled: boolean,
    actor: Actor,
  ): Promise<WebsiteDto> {
    // Resolves within the tenant first, so a website in another organization is
    // a 404 rather than a silent no-op update.
    await this.websites.requireWebsite(organization, websiteId);

    const updated = await this.repository.update(organization.objectId, websiteId, {
      monitoringEnabled: enabled,
      status: enabled ? 'unknown' : 'paused',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      nextCheckAt: new Date(),
    });
    if (!updated) throw ApiError.notFound('WEBSITE_NOT_FOUND', 'Website not found.');

    await this.audit.record({
      organizationId: organization.objectId,
      action: enabled ? 'website.monitoring_resumed' : 'website.monitoring_paused',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'website',
      targetId: updated._id,
      targetLabel: updated.name,
    });

    return toWebsiteDto(updated);
  }
}
