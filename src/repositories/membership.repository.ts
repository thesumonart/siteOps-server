import type { Types } from 'mongoose';

import type { OrganizationRole } from '../contracts/index.js';
import {
  InvitationModel,
  OrganizationMemberModel,
  UserModel,
  type InvitationAttributes,
} from '../models/index.js';
import { toObjectId } from '../utils/object-id.js';

export interface MemberWithUser {
  readonly memberId: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: OrganizationRole;
  readonly joinedAt: Date;
}

export interface InvitationRecord {
  readonly id: string;
  readonly organizationId: Types.ObjectId;
  readonly email: string;
  readonly role: OrganizationRole;
  /** Set only for a `client` invitation: the client the invitee will see. */
  readonly clientId?: Types.ObjectId | null;
  readonly invitedByName: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/**
 * Membership and invitation data access.
 *
 * Every method takes the organization id, so a caller cannot accidentally read
 * or mutate membership outside the tenant the guard verified.
 */
export class MembershipRepository {
  /**
   * Members of one organization with their profile fields.
   *
   * Profiles live in the auth-owned `user` collection, so they are fetched in a
   * single `$in` query rather than one per member.
   */
  /**
   * The organization's own team.
   *
   * Client contacts are excluded. They are memberships too, but they belong to
   * a client rather than to the agency, and they are listed and revoked on that
   * client's page — mixing them in here would make the members table a place
   * where somebody could accidentally promote a customer's contact to admin.
   *
   * `listContacts` on the client repository is the counterpart.
   */
  async listMembers(organizationId: Types.ObjectId): Promise<readonly MemberWithUser[]> {
    const members = await OrganizationMemberModel.find({
      organizationId,
      role: { $ne: 'client' },
    })
      .sort({ joinedAt: 1 })
      .lean()
      .exec();

    if (members.length === 0) return [];

    const users = await UserModel.find({ _id: { $in: members.map((m) => m.userId) } })
      .select({ name: 1, email: 1 })
      .lean<{ _id: Types.ObjectId; name: string; email: string }[]>()
      .exec();

    const userById = new Map(users.map((user) => [user._id.toHexString(), user]));

    return members.map((member) => {
      const user = userById.get(member.userId.toHexString());
      return {
        memberId: member._id.toHexString(),
        userId: member.userId.toHexString(),
        // A membership can outlive its user record; showing a placeholder is
        // better than dropping the row and hiding who still has access.
        name: user?.name ?? 'Unknown user',
        email: user?.email ?? '',
        role: member.role,
        joinedAt: member.joinedAt,
      };
    });
  }

  /**
   * Resolves a member for management.
   *
   * Also excludes client contacts, so the member routes — role change, removal
   * — can never reach one. Portal access is granted and revoked on the client's
   * own page, where archiving revokes it too.
   */
  async findMemberById(
    organizationId: Types.ObjectId,
    memberId: string,
  ): Promise<MemberWithUser | null> {
    const memberObjectId = toObjectId(memberId);
    if (!memberObjectId) return null;

    const member = await OrganizationMemberModel.findOne({
      _id: memberObjectId,
      organizationId,
      role: { $ne: 'client' },
    })
      .lean()
      .exec();
    if (!member) return null;

    const user = await UserModel.findById(member.userId)
      .select({ name: 1, email: 1 })
      .lean<{ name: string; email: string }>()
      .exec();

    return {
      memberId: member._id.toHexString(),
      userId: member.userId.toHexString(),
      name: user?.name ?? 'Unknown user',
      email: user?.email ?? '',
      role: member.role,
      joinedAt: member.joinedAt,
    };
  }

  async findUserIdByEmail(email: string): Promise<Types.ObjectId | null> {
    const user = await UserModel.findOne({ email: email.toLowerCase() })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>()
      .exec();
    return user?._id ?? null;
  }

  async isMember(organizationId: Types.ObjectId, userId: Types.ObjectId): Promise<boolean> {
    return (await OrganizationMemberModel.exists({ organizationId, userId })) !== null;
  }

  /**
   * Accepted members, for the plan's team-size limit.
   *
   * Pending invitations are deliberately not counted: an invitation that is
   * never accepted would otherwise occupy a seat forever. The limit is
   * re-checked when the invitation is accepted, which is the moment a seat is
   * actually taken.
   */
  async countForOrganization(organizationId: Types.ObjectId): Promise<number> {
    return OrganizationMemberModel.countDocuments({ organizationId }).exec();
  }

  /** Used to refuse the removal or demotion of the last owner. */
  async countOwners(organizationId: Types.ObjectId): Promise<number> {
    return OrganizationMemberModel.countDocuments({ organizationId, role: 'owner' }).exec();
  }

  async updateRole(
    organizationId: Types.ObjectId,
    memberId: string,
    role: OrganizationRole,
  ): Promise<boolean> {
    const memberObjectId = toObjectId(memberId);
    if (!memberObjectId) return false;

    const result = await OrganizationMemberModel.updateOne(
      { _id: memberObjectId, organizationId },
      { $set: { role } },
    ).exec();
    return result.matchedCount > 0;
  }

  async remove(organizationId: Types.ObjectId, memberId: string): Promise<boolean> {
    const memberObjectId = toObjectId(memberId);
    if (!memberObjectId) return false;

    const result = await OrganizationMemberModel.deleteOne({
      _id: memberObjectId,
      organizationId,
    }).exec();
    return result.deletedCount > 0;
  }

  async addMember(input: {
    readonly organizationId: Types.ObjectId;
    readonly userId: Types.ObjectId;
    readonly role: OrganizationRole;
    /** Required for a `client` role; ignored for every other. */
    readonly clientId?: Types.ObjectId | null;
    readonly invitedByUserId: Types.ObjectId | null;
  }): Promise<void> {
    await OrganizationMemberModel.create({
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      // Stored only for a client membership. An internal role carrying one
      // would be a member mysteriously scoped to a subset of the organization.
      clientId: input.role === 'client' ? (input.clientId ?? null) : null,
      invitedByUserId: input.invitedByUserId,
      joinedAt: new Date(),
    });
  }

  async listPendingInvitations(
    organizationId: Types.ObjectId,
  ): Promise<readonly InvitationRecord[]> {
    const invitations = await InvitationModel.find({ organizationId, status: 'pending' })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    return invitations.map((invitation) => ({
      id: invitation._id.toHexString(),
      organizationId: invitation.organizationId,
      email: invitation.email,
      role: invitation.role,
      // Carried so the client portal's contact list can show which pending
      // invitations belong to which client.
      clientId: invitation.clientId ?? null,
      invitedByName: invitation.invitedByName,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    }));
  }

  /**
   * Creates a pending invitation, replacing any existing pending one for the
   * same address so a re-invite refreshes the link instead of failing on the
   * unique index.
   */
  async upsertInvitation(input: {
    readonly organizationId: Types.ObjectId;
    readonly email: string;
    readonly role: OrganizationRole;
    /** Set only for a `client` invitation. */
    readonly clientId?: Types.ObjectId | null;
    readonly tokenHash: string;
    readonly invitedByUserId: Types.ObjectId;
    readonly invitedByName: string;
    readonly expiresAt: Date;
  }): Promise<InvitationRecord> {
    const invitation = await InvitationModel.findOneAndUpdate(
      { organizationId: input.organizationId, email: input.email.toLowerCase(), status: 'pending' },
      {
        $set: {
          role: input.role,
          clientId: input.clientId ?? null,
          tokenHash: input.tokenHash,
          invitedByUserId: input.invitedByUserId,
          invitedByName: input.invitedByName,
          expiresAt: input.expiresAt,
          status: 'pending',
          acceptedAt: null,
          acceptedByUserId: null,
        } satisfies Partial<InvitationAttributes>,
      },
      { upsert: true, returnDocument: 'after' },
    )
      .lean()
      .exec();

    if (!invitation) throw new Error('Invitation upsert returned no document.');

    return {
      id: invitation._id.toHexString(),
      organizationId: invitation.organizationId,
      email: invitation.email,
      role: invitation.role,
      invitedByName: invitation.invitedByName,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    };
  }

  async findPendingByTokenHash(tokenHash: string): Promise<
    | (InvitationRecord & {
        readonly invitedByUserId: Types.ObjectId;
      })
    | null
  > {
    const invitation = await InvitationModel.findOne({ tokenHash, status: 'pending' })
      .lean()
      .exec();
    if (!invitation) return null;

    return {
      id: invitation._id.toHexString(),
      organizationId: invitation.organizationId,
      email: invitation.email,
      role: invitation.role,
      clientId: invitation.clientId ?? null,
      invitedByName: invitation.invitedByName,
      invitedByUserId: invitation.invitedByUserId,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    };
  }

  async markInvitationAccepted(invitationId: string, userId: Types.ObjectId): Promise<void> {
    const objectId = toObjectId(invitationId);
    if (!objectId) return;

    await InvitationModel.updateOne(
      { _id: objectId, status: 'pending' },
      { $set: { status: 'accepted', acceptedAt: new Date(), acceptedByUserId: userId } },
    ).exec();
  }

  async revokeInvitation(organizationId: Types.ObjectId, invitationId: string): Promise<boolean> {
    const objectId = toObjectId(invitationId);
    if (!objectId) return false;

    const result = await InvitationModel.updateOne(
      { _id: objectId, organizationId, status: 'pending' },
      { $set: { status: 'revoked' } },
    ).exec();
    return result.matchedCount > 0;
  }
}
