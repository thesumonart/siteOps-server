import type { Types } from 'mongoose';

import { env } from '../config/env.js';
import type { OrganizationMemberDto, OrganizationRole } from '../contracts/index.js';
import { canActOn, canAssignRole } from '../contracts/index.js';
import type { EmailService } from '../email/email.service.js';
import { invitationTemplate } from '../email/templates/index.js';
import { ApiError } from '../errors/ApiError.js';
import { INVITATION_TTL_SECONDS } from '../models/invitation.model.js';
import type {
  InvitationRecord,
  MembershipRepository,
} from '../repositories/membership.repository.js';
import type { OrganizationActor, OrganizationContext } from '../types/common.types.js';
import { emailsMatch, generateToken, hashToken } from '../utils/crypto.js';
import { createLogger } from '../utils/logger.js';
import { toObjectId } from '../utils/object-id.js';
import type { AuditService } from './audit.service.js';
import type { OrganizationService } from './organization.service.js';

const logger = createLogger('members');

export interface PendingInvitationDto {
  readonly id: string;
  readonly email: string;
  readonly role: OrganizationRole;
  readonly invitedByName: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface MembersViewDto {
  readonly members: readonly OrganizationMemberDto[];
  readonly invitations: readonly PendingInvitationDto[];
}

export class MemberService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly organizations: OrganizationService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  async list(organization: OrganizationContext): Promise<MembersViewDto> {
    const [members, invitations] = await Promise.all([
      this.members.listMembers(organization.objectId),
      this.members.listPendingInvitations(organization.objectId),
    ]);

    return {
      members: members.map((member) => ({
        id: member.memberId,
        userId: member.userId,
        name: member.name,
        email: member.email,
        role: member.role,
        joinedAt: member.joinedAt.toISOString(),
      })),
      invitations: invitations.map(toInvitationDto),
    };
  }

  async invite(
    organization: OrganizationContext,
    input: { readonly email: string; readonly role: OrganizationRole },
    actor: OrganizationActor,
  ): Promise<PendingInvitationDto> {
    // Nobody may hand out a role above their own; otherwise an admin could mint
    // an owner and escalate through the invitation flow.
    if (!canAssignRole(actor.role, input.role)) {
      throw ApiError.forbidden(
        'INSUFFICIENT_ROLE',
        'You cannot invite someone at a higher role than your own.',
      );
    }

    await this.organizations.assertCanAddMember(organization.id);

    const existingUserId = await this.members.findUserIdByEmail(input.email);
    if (existingUserId && (await this.members.isMember(organization.objectId, existingUserId))) {
      throw ApiError.conflict(
        'ALREADY_A_MEMBER',
        'That person is already a member of this organization.',
      );
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_SECONDS * 1000);
    const invitedByObjectId = toObjectId(actor.id);
    if (!invitedByObjectId) throw ApiError.unauthenticated();

    const invitation = await this.members.upsertInvitation({
      organizationId: organization.objectId,
      email: input.email,
      role: input.role,
      tokenHash: hashToken(token),
      invitedByUserId: invitedByObjectId,
      invitedByName: actor.name,
      expiresAt,
    });

    const content = invitationTemplate({
      organizationName: organization.name,
      invitedByName: actor.name,
      acceptUrl: `${env.APP_URL}/invitations/accept?token=${encodeURIComponent(token)}`,
      expiresInDays: Math.round(INVITATION_TTL_SECONDS / 86_400),
    });
    await this.email.send({ to: input.email, ...content });

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'member.invited',
      actorUserId: invitedByObjectId,
      actorName: actor.name,
      targetType: 'invitation',
      targetLabel: input.email,
    });

    logger.info({ organizationId: organization.id, role: input.role }, 'member.invited');

    return toInvitationDto(invitation);
  }

  /**
   * Accepts an invitation for the signed-in user.
   *
   * The invitation is matched on the token hash and then checked against the
   * signed-in address: a link forwarded to someone else must not let them join.
   */
  async accept(
    token: string,
    user: { readonly id: string; readonly name: string; readonly email: string },
  ): Promise<{ readonly organizationId: string }> {
    const invitation = await this.members.findPendingByTokenHash(hashToken(token));
    if (!invitation) {
      throw ApiError.notFound('INVALID_TOKEN', 'This invitation is no longer valid.');
    }

    if (invitation.expiresAt.getTime() < Date.now()) {
      throw ApiError.badRequest('TOKEN_EXPIRED', 'This invitation has expired.');
    }

    if (!emailsMatch(invitation.email, user.email)) {
      throw ApiError.forbidden(
        'FORBIDDEN',
        'This invitation was sent to a different email address.',
      );
    }

    const userObjectId = toObjectId(user.id);
    if (!userObjectId) throw ApiError.unauthenticated();

    if (!(await this.members.isMember(invitation.organizationId, userObjectId))) {
      await this.members.addMember({
        organizationId: invitation.organizationId,
        userId: userObjectId,
        role: invitation.role,
        invitedByUserId: invitation.invitedByUserId,
      });
    }

    await this.members.markInvitationAccepted(invitation.id, userObjectId);

    await this.audit.record({
      organizationId: invitation.organizationId,
      action: 'member.joined',
      actorUserId: userObjectId,
      actorName: user.name,
      targetType: 'member',
      targetLabel: user.email,
    });

    return { organizationId: invitation.organizationId.toHexString() };
  }

  async revokeInvitation(
    organization: OrganizationContext,
    invitationId: string,
    actor: OrganizationActor,
  ): Promise<void> {
    const revoked = await this.members.revokeInvitation(organization.objectId, invitationId);
    if (!revoked) {
      throw ApiError.notFound('NOT_FOUND', 'Invitation not found.');
    }

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'member.removed',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'invitation',
      targetLabel: invitationId,
    });
  }

  async updateRole(
    organization: OrganizationContext,
    memberId: string,
    role: OrganizationRole,
    actor: OrganizationActor,
  ): Promise<OrganizationMemberDto> {
    const target = await this.members.findMemberById(organization.objectId, memberId);
    if (!target) throw ApiError.notFound('MEMBER_NOT_FOUND', 'Member not found.');

    if (target.userId === actor.id) {
      throw ApiError.forbidden('FORBIDDEN', 'You cannot change your own role. Ask another owner.');
    }

    // Peers may manage each other, but nobody may touch a superior or grant a
    // role above their own. The last-owner rule below is what keeps peer
    // management from emptying the organization.
    if (!canActOn(actor.role, target.role)) {
      throw ApiError.forbidden(
        'INSUFFICIENT_ROLE',
        'You cannot change the role of someone above your own.',
      );
    }
    if (!canAssignRole(actor.role, role)) {
      throw ApiError.forbidden('INSUFFICIENT_ROLE', 'You cannot grant a role above your own.');
    }

    await this.assertNotLastOwner(organization.objectId, target.role, role);

    const updated = await this.members.updateRole(organization.objectId, memberId, role);
    if (!updated) throw ApiError.notFound('MEMBER_NOT_FOUND', 'Member not found.');

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'member.role_updated',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'member',
      targetLabel: target.email,
    });

    return {
      id: target.memberId,
      userId: target.userId,
      name: target.name,
      email: target.email,
      role,
      joinedAt: target.joinedAt.toISOString(),
    };
  }

  async remove(
    organization: OrganizationContext,
    memberId: string,
    actor: OrganizationActor,
  ): Promise<void> {
    const target = await this.members.findMemberById(organization.objectId, memberId);
    if (!target) throw ApiError.notFound('MEMBER_NOT_FOUND', 'Member not found.');

    // Removing yourself is "leaving" and is allowed, provided you are not the
    // last owner. Removing anyone else requires at least their rank.
    if (target.userId !== actor.id && !canActOn(actor.role, target.role)) {
      throw ApiError.forbidden(
        'INSUFFICIENT_ROLE',
        'You cannot remove someone above your own role.',
      );
    }

    await this.assertNotLastOwner(organization.objectId, target.role, null);

    const removed = await this.members.remove(organization.objectId, memberId);
    if (!removed) throw ApiError.notFound('MEMBER_NOT_FOUND', 'Member not found.');

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'member.removed',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'member',
      targetLabel: target.email,
    });
  }

  /**
   * An organization must always keep at least one owner.
   *
   * Without this, demoting or removing the final owner would leave nobody able
   * to manage members or billing — an unrecoverable state for the tenant.
   */
  private async assertNotLastOwner(
    organizationId: Types.ObjectId,
    currentRole: OrganizationRole,
    nextRole: OrganizationRole | null,
  ): Promise<void> {
    if (currentRole !== 'owner' || nextRole === 'owner') return;

    const owners = await this.members.countOwners(organizationId);
    if (owners <= 1) {
      throw ApiError.conflict(
        'CANNOT_REMOVE_LAST_OWNER',
        'An organization must keep at least one owner. Promote someone else first.',
      );
    }
  }
}

function toInvitationDto(invitation: InvitationRecord): PendingInvitationDto {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    invitedByName: invitation.invitedByName,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
  };
}
