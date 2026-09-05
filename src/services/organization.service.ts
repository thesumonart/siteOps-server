import type {
  CreateOrganizationInput,
  OrganizationDto,
  OrganizationMembershipDto,
  UpdateOrganizationInput,
} from '../contracts/index.js';
import { limitsFor, permissionsFor, slugifyOrganizationName } from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type {
  MembershipWithOrganization,
  OrganizationRecord,
  OrganizationRepository,
} from '../repositories/organization.repository.js';
import type { Actor } from '../types/auth.types.js';
import { createLogger } from '../utils/logger.js';
import { toObjectId } from '../utils/object-id.js';
import type { AuditService } from './audit.service.js';

const logger = createLogger('organizations');

/** Attempts before giving up and asking the user to choose a slug themselves. */
const MAX_SLUG_ATTEMPTS = 25;

export class OrganizationService {
  constructor(
    private readonly repository: OrganizationRepository,
    private readonly audit: AuditService,
  ) {}

  async listForUser(userId: string): Promise<readonly OrganizationMembershipDto[]> {
    const memberships = await this.repository.listForUser(userId);
    return memberships.map(toMembershipDto);
  }

  async create(input: CreateOrganizationInput, actor: Actor): Promise<OrganizationMembershipDto> {
    const ownerObjectId = toObjectId(actor.id);
    if (!ownerObjectId) throw ApiError.unauthenticated();

    const slug = input.slug
      ? await this.claimExactSlug(input.slug)
      : await this.claimDerivedSlug(input.name);

    const organization = await this.repository.createWithOwner({
      name: input.name,
      slug,
      timezone: 'UTC',
      ownerUserId: ownerObjectId,
    });

    await this.audit.record({
      organizationId: organization._id,
      action: 'organization.created',
      actorUserId: ownerObjectId,
      actorName: actor.name,
      targetType: 'organization',
      targetId: organization._id,
      targetLabel: organization.name,
    });

    logger.info({ organizationId: organization._id.toHexString(), slug }, 'organization.created');

    return {
      organization: toOrganizationDto(organization, 0),
      role: 'owner',
      permissions: permissionsFor('owner'),
      joinedAt: new Date().toISOString(),
    };
  }

  async update(
    organizationId: string,
    input: UpdateOrganizationInput,
    actor: Actor,
  ): Promise<OrganizationDto> {
    const changes: { name?: string; timezone?: string } = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.timezone !== undefined) changes.timezone = input.timezone;

    const updated = await this.repository.update(organizationId, changes);
    if (!updated) {
      throw ApiError.notFound('ORGANIZATION_NOT_FOUND', 'Organization not found.');
    }

    await this.audit.record({
      organizationId: updated._id,
      action: 'organization.updated',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'organization',
      targetId: updated._id,
      targetLabel: updated.name,
    });

    const websiteCount = await this.repository.countWebsites(updated._id);
    return toOrganizationDto(updated, websiteCount);
  }

  /**
   * Enforces the plan's member cap before an invitation is created.
   *
   * Limits live on the server and are read from the organization's stored plan
   * — never from anything the client sends.
   */
  async assertCanAddMember(organizationId: string): Promise<void> {
    const organization = await this.repository.findById(organizationId);
    if (!organization) {
      throw ApiError.notFound('ORGANIZATION_NOT_FOUND', 'Organization not found.');
    }

    const limits = limitsFor(organization.plan);
    const memberCount = await this.repository.countMembers(organization._id);

    if (memberCount >= limits.maxMembers) {
      throw ApiError.planLimit(
        `The ${organization.plan} plan allows ${String(limits.maxMembers)} members. Upgrade to invite more.`,
      );
    }
  }

  private async claimExactSlug(slug: string): Promise<string> {
    if (await this.repository.slugExists(slug)) {
      throw ApiError.conflict('ORGANIZATION_SLUG_TAKEN', 'That name is already taken.');
    }
    return slug;
  }

  /**
   * Derives a slug from the display name, suffixing until one is free.
   *
   * Best-effort only: the unique index on `slug` is the real guarantee, and a
   * concurrent creation surfaces as a conflict rather than a duplicate.
   */
  private async claimDerivedSlug(name: string): Promise<string> {
    const base = slugifyOrganizationName(name);

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${String(attempt + 1)}`;
      if (!(await this.repository.slugExists(candidate))) {
        return candidate;
      }
    }

    throw ApiError.conflict(
      'ORGANIZATION_SLUG_TAKEN',
      'Could not derive a unique name. Choose one explicitly.',
    );
  }
}

export function toOrganizationDto(
  organization: OrganizationRecord,
  websiteCount: number,
): OrganizationDto {
  return {
    id: organization._id.toHexString(),
    name: organization.name,
    slug: organization.slug,
    plan: organization.plan,
    timezone: organization.timezone,
    websiteCount,
    createdAt: organization.createdAt.toISOString(),
  };
}

export function toMembershipDto(entry: MembershipWithOrganization): OrganizationMembershipDto {
  return {
    organization: toOrganizationDto(entry.organization, entry.websiteCount),
    role: entry.membership.role,
    permissions: permissionsFor(entry.membership.role),
    joinedAt: entry.membership.joinedAt.toISOString(),
  };
}
