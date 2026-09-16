import type { Types } from 'mongoose';

import {
  CUSTOM_DOMAIN_CHALLENGE_LABEL,
  CUSTOM_DOMAIN_CHALLENGE_PREFIX,
  type CreateStatusPageInput,
  type CustomDomainDto,
  type CustomDomainInput,
  type StatusPageDto,
  type UpdateStatusPageInput,
} from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type { TxtLookup } from '../integrations/dns-txt.js';
import { isDuplicateKeyError } from '../repositories/notification.repository.js';
import type {
  StatusPageChanges,
  StatusPageRecord,
  StatusPageRepository,
} from '../repositories/status-page.repository.js';
import type { OrganizationActor, OrganizationContext } from '../types/common.types.js';
import { generateToken } from '../utils/crypto.js';
import { toObjectId, toObjectIdOrThrow } from '../utils/object-id.js';
import type { AuditService } from './audit.service.js';
import type { CustomDomainResolver } from './custom-domain-resolver.js';
import type { EntitlementService } from './entitlement.service.js';
import type { PublicStatusCache } from './public-status-cache.js';

export interface StatusPageServiceOptions {
  readonly repository: StatusPageRepository;
  readonly entitlements: EntitlementService;
  readonly audit: AuditService;
  readonly cache: PublicStatusCache;
  readonly domains: CustomDomainResolver;
  readonly txtLookup: TxtLookup;
  /** The hostname a customer's CNAME should point at. */
  readonly cnameTarget: string;
}

/**
 * Managing status pages and their custom domains, from the dashboard.
 *
 * The rules that matter:
 *
 *  - **A page shows only its organization's websites.** Every component id is
 *    checked against the tenant before it is stored; the public renderer checks
 *    again before it reads anything.
 *  - **Publishing is a decision.** A page is created unpublished unless the
 *    request says otherwise, and nothing about it is reachable until it is.
 *  - **A domain is not a page's until DNS says so.** Claiming one stores a
 *    token; only a TXT record carrying that token makes it route. Two
 *    organizations may both be pending on a name — the first to prove it wins,
 *    and the unique index decides, not this code.
 *  - **The plan gates changes, not cleanup.** After a downgrade a page can still
 *    be listed, unpublished's effect is automatic, and it can be deleted.
 */
export class StatusPageService {
  private readonly repository: StatusPageRepository;
  private readonly entitlements: EntitlementService;
  private readonly audit: AuditService;
  private readonly cache: PublicStatusCache;
  private readonly domains: CustomDomainResolver;
  private readonly txtLookup: TxtLookup;
  private readonly cnameTarget: string;

  constructor(options: StatusPageServiceOptions) {
    this.repository = options.repository;
    this.entitlements = options.entitlements;
    this.audit = options.audit;
    this.cache = options.cache;
    this.domains = options.domains;
    this.txtLookup = options.txtLookup;
    this.cnameTarget = options.cnameTarget;
  }

  async list(organization: OrganizationContext): Promise<readonly StatusPageDto[]> {
    const pages = await this.repository.list(organization.objectId);
    return pages.map((page) => this.toDto(page));
  }

  async get(organization: OrganizationContext, pageId: string): Promise<StatusPageDto> {
    return this.toDto(await this.requirePage(organization, pageId));
  }

  async create(
    organization: OrganizationContext,
    input: CreateStatusPageInput,
    actor: OrganizationActor,
  ): Promise<StatusPageDto> {
    this.entitlements.assertFeature(organization, 'status_pages');
    await this.entitlements.assertWithinLimit(organization, 'maxStatusPages');

    const components = input.components.map((component) => ({
      websiteId: toObjectIdOrThrow(component.websiteId),
      displayName: component.displayName,
    }));
    await this.assertOwnedWebsites(
      organization,
      components.map((component) => component.websiteId),
    );

    const actorObjectId = toObjectId(actor.id);
    if (!actorObjectId) throw ApiError.unauthenticated();

    let page: StatusPageRecord;
    try {
      page = await this.repository.create({
        organizationId: organization.objectId,
        slug: input.slug,
        title: input.title,
        description: emptyToNull(input.description),
        published: input.published,
        theme: input.theme,
        components,
        createdByUserId: actorObjectId,
      });
    } catch (error) {
      throw slugConflictOr(error);
    }

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'status_page.created',
      actorUserId: actorObjectId,
      actorName: actor.name,
      targetType: 'status_page',
      targetId: page._id,
      targetLabel: page.title,
    });

    return this.toDto(page);
  }

  async update(
    organization: OrganizationContext,
    pageId: string,
    input: UpdateStatusPageInput,
    actor: OrganizationActor,
  ): Promise<StatusPageDto> {
    const existing = await this.requirePage(organization, pageId);

    // Unpublishing is always allowed: it is how a downgraded organization takes
    // a page down, and refusing it would leave the page's settings stuck
    // pointing at something public.
    const onlyUnpublishing =
      Object.keys(input).every((key) => key === 'published') && input.published === false;
    if (!onlyUnpublishing) this.entitlements.assertFeature(organization, 'status_pages');

    const changes: StatusPageChanges = {};
    if (input.title !== undefined) changes.title = input.title;
    if (input.slug !== undefined) changes.slug = input.slug;
    if (input.description !== undefined) changes.description = emptyToNull(input.description);
    if (input.published !== undefined) changes.published = input.published;
    if (input.theme !== undefined) changes.theme = input.theme;
    if (input.components !== undefined) {
      changes.components = input.components.map((component) => ({
        websiteId: toObjectIdOrThrow(component.websiteId),
        displayName: component.displayName,
      }));
      await this.assertOwnedWebsites(
        organization,
        changes.components.map((component) => component.websiteId),
      );
    }

    let updated: StatusPageRecord | null;
    try {
      updated = await this.repository.update(organization.objectId, existing._id, changes);
    } catch (error) {
      throw slugConflictOr(error);
    }
    if (!updated) throw statusPageNotFound();

    this.cache.forgetPage(updated._id.toHexString());

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'status_page.updated',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'status_page',
      targetId: updated._id,
      targetLabel: updated.title,
    });

    return this.toDto(updated);
  }

  async delete(
    organization: OrganizationContext,
    pageId: string,
    actor: OrganizationActor,
  ): Promise<void> {
    const existing = await this.requirePage(organization, pageId);

    const deleted = await this.repository.delete(organization.objectId, existing._id);
    if (!deleted) throw statusPageNotFound();

    this.forget(deleted);

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'status_page.deleted',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'status_page',
      targetId: deleted._id,
      targetLabel: deleted.title,
    });
  }

  /**
   * Claims a domain for the page, replacing any previous claim.
   *
   * Claiming the domain the page already holds changes nothing — in particular
   * it does not issue a new token, which would silently invalidate a TXT record
   * the customer may already have published.
   */
  async setCustomDomain(
    organization: OrganizationContext,
    pageId: string,
    input: CustomDomainInput,
    actor: OrganizationActor,
  ): Promise<StatusPageDto> {
    this.entitlements.assertFeature(organization, 'custom_domains');
    const existing = await this.requirePage(organization, pageId);

    if (existing.customDomain?.domain === input.domain) return this.toDto(existing);

    if (this.domains.isPlatformHost(input.domain)) {
      throw ApiError.badRequest(
        'VALIDATION_ERROR',
        'That domain belongs to SiteOps and cannot serve a status page.',
      );
    }

    // A page moving from one domain to another does not use another slot.
    if (!existing.customDomain) {
      await this.entitlements.assertWithinLimit(organization, 'maxCustomDomains');
    }

    // Refused up front for a clearer message. The unique index still decides at
    // verification, since another organization can verify in the meantime.
    const holder = await this.repository.findIdByVerifiedDomain(input.domain);
    if (holder !== null) throw customDomainTaken();

    const updated = await this.repository.setCustomDomain(organization.objectId, existing._id, {
      domain: input.domain,
      verificationToken: generateToken(),
    });
    if (!updated) throw statusPageNotFound();

    this.forget(existing);

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'custom_domain.added',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'custom_domain',
      targetId: updated._id,
      targetLabel: input.domain,
    });

    return this.toDto(updated);
  }

  /**
   * Checks DNS for the page's verification record and, if it is there, makes
   * the domain route to the page.
   *
   * Verifying an already verified domain succeeds without a lookup. The record
   * is not re-checked afterwards: removing it later does not unroute the page,
   * the same as every comparable product — the CNAME is what keeps traffic
   * arriving, and a customer who repoints it has taken the page down already.
   */
  async verifyCustomDomain(
    organization: OrganizationContext,
    pageId: string,
    actor: OrganizationActor,
  ): Promise<StatusPageDto> {
    this.entitlements.assertFeature(organization, 'custom_domains');
    const existing = await this.requirePage(organization, pageId);

    const claim = existing.customDomain;
    if (!claim) {
      throw ApiError.notFound('NOT_FOUND', 'This status page has no custom domain to verify.');
    }
    if (claim.verifiedAt !== null) return this.toDto(existing);

    const recordName = `${CUSTOM_DOMAIN_CHALLENGE_LABEL}.${claim.domain}`;
    const expected = `${CUSTOM_DOMAIN_CHALLENGE_PREFIX}${claim.verificationToken}`;
    const lookup = await this.txtLookup(recordName);

    if (lookup.outcome === 'failed') {
      throw ApiError.badRequest(
        'CUSTOM_DOMAIN_NOT_VERIFIED',
        `DNS did not answer for ${recordName}. Try again in a few minutes.`,
      );
    }
    if (lookup.outcome === 'missing' || !lookup.values.some((value) => value.trim() === expected)) {
      throw ApiError.badRequest(
        'CUSTOM_DOMAIN_NOT_VERIFIED',
        `No TXT record at ${recordName} contains the verification value yet. DNS changes can take a while to appear.`,
      );
    }

    let verified: StatusPageRecord | null;
    try {
      verified = await this.repository.markCustomDomainVerified(
        organization.objectId,
        existing._id,
        claim.domain,
        new Date(),
      );
    } catch (error) {
      if (isDuplicateKeyError(error)) throw customDomainTaken();
      throw error;
    }
    if (!verified) {
      throw ApiError.conflict(
        'CONFLICT',
        'The custom domain changed while it was being verified. Check the domain and try again.',
      );
    }

    this.forget(verified);

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'custom_domain.verified',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'custom_domain',
      targetId: verified._id,
      targetLabel: claim.domain,
    });

    return this.toDto(verified);
  }

  /** Idempotent, like revoking an API key: no domain is the outcome asked for. */
  async removeCustomDomain(
    organization: OrganizationContext,
    pageId: string,
    actor: OrganizationActor,
  ): Promise<StatusPageDto> {
    const existing = await this.requirePage(organization, pageId);
    if (!existing.customDomain) return this.toDto(existing);

    const updated = await this.repository.clearCustomDomain(organization.objectId, existing._id);
    if (!updated) throw statusPageNotFound();

    this.forget(existing);

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'custom_domain.removed',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'custom_domain',
      targetId: updated._id,
      targetLabel: existing.customDomain.domain,
    });

    return this.toDto(updated);
  }

  private async requirePage(
    organization: OrganizationContext,
    pageId: string,
  ): Promise<StatusPageRecord> {
    const page = await this.repository.findById(organization.objectId, pageId);
    if (!page) throw statusPageNotFound();
    return page;
  }

  /**
   * Refuses a website id that is not this organization's.
   *
   * The same 404 whether the id names another tenant's website or nothing at
   * all, so the answer says nothing about what exists elsewhere.
   */
  private async assertOwnedWebsites(
    organization: OrganizationContext,
    websiteIds: readonly Types.ObjectId[],
  ): Promise<void> {
    if (websiteIds.length === 0) return;
    const owned = await this.repository.countOwnedWebsites(organization.objectId, websiteIds);
    if (owned !== websiteIds.length) {
      throw ApiError.notFound('WEBSITE_NOT_FOUND', 'One or more websites were not found.');
    }
  }

  /** Forgets what this process has cached about a page and its domain, so a change shows at once. */
  private forget(page: StatusPageRecord): void {
    this.cache.forgetPage(page._id.toHexString());
    if (page.customDomain) this.cache.forgetHost(page.customDomain.domain);
  }

  private toDto(page: StatusPageRecord): StatusPageDto {
    return {
      id: page._id.toHexString(),
      slug: page.slug,
      title: page.title,
      description: page.description,
      published: page.published,
      theme: { mode: page.theme.mode, accentColor: page.theme.accentColor },
      components: page.components.map((component) => ({
        websiteId: component.websiteId.toHexString(),
        displayName: component.displayName,
      })),
      customDomain: page.customDomain ? this.toCustomDomainDto(page.customDomain) : null,
      createdAt: page.createdAt.toISOString(),
      updatedAt: page.updatedAt.toISOString(),
    };
  }

  private toCustomDomainDto(claim: NonNullable<StatusPageRecord['customDomain']>): CustomDomainDto {
    return {
      domain: claim.domain,
      status: claim.verifiedAt === null ? 'pending' : 'verified',
      verificationRecord: {
        type: 'TXT',
        name: `${CUSTOM_DOMAIN_CHALLENGE_LABEL}.${claim.domain}`,
        value: `${CUSTOM_DOMAIN_CHALLENGE_PREFIX}${claim.verificationToken}`,
      },
      cnameTarget: this.cnameTarget,
      verifiedAt: claim.verifiedAt?.toISOString() ?? null,
    };
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.length === 0 ? null : value;
}

function statusPageNotFound(): ApiError {
  return ApiError.notFound('STATUS_PAGE_NOT_FOUND', 'Status page not found.');
}

function customDomainTaken(): ApiError {
  return ApiError.conflict(
    'CUSTOM_DOMAIN_TAKEN',
    'That domain is already serving another status page.',
  );
}

/** The slug index is the only unique index a page write can hit. */
function slugConflictOr(error: unknown): unknown {
  if (isDuplicateKeyError(error)) {
    return ApiError.conflict(
      'STATUS_PAGE_SLUG_TAKEN',
      'That address is already in use. Choose another.',
    );
  }
  return error;
}
