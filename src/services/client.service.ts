import type { Types } from 'mongoose';

import { env } from '../config/env.js';
import type {
  ClientContactDto,
  ClientDto,
  CreateClientInput,
  InviteClientContactInput,
  ListClientsQuery,
  UpdateClientInput,
} from '../contracts/index.js';
import type { EmailService } from '../email/email.service.js';
import { invitationTemplate } from '../email/templates/index.js';
import { ApiError } from '../errors/ApiError.js';
import { INVITATION_TTL_SECONDS } from '../models/invitation.model.js';
import type { ClientRecord, ClientRepository } from '../repositories/client.repository.js';
import type { MembershipRepository } from '../repositories/membership.repository.js';
import type { WebsiteRepository } from '../repositories/website.repository.js';
import type { OrganizationActor, OrganizationContext } from '../types/common.types.js';
import { generateToken, hashToken } from '../utils/crypto.js';
import { toObjectId } from '../utils/object-id.js';
import type { AuditService } from './audit.service.js';
import type { EntitlementService } from './entitlement.service.js';

/** MongoDB's duplicate-key error number. */
const DUPLICATE_KEY = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/**
 * Agency client management, and portal access.
 *
 * Portal access is granted through the invitation flow the product already has:
 * the contact receives a link, creates an account with a verified address and a
 * password they choose, and accepting the invitation creates a `client`
 * membership scoped to this client. A second way to create a user would be a
 * second way to get identity wrong.
 *
 * Two rules are enforced here and matter more than the rest:
 *
 *  - **A client membership always carries a client.** One without would be a
 *    contact who can see the whole agency.
 *  - **Archiving revokes access.** An agency that archives a client expects the
 *    portal to close, and expecting them to also remember to remove each
 *    contact is how a former client keeps reading a dashboard for a year.
 */
export class ClientService {
  constructor(
    private readonly repository: ClientRepository,
    private readonly websites: WebsiteRepository,
    private readonly members: MembershipRepository,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  async list(
    organization: OrganizationContext,
    query: ListClientsQuery,
  ): Promise<readonly ClientDto[]> {
    this.entitlements.assertFeature(organization, 'clients');

    const clients = await this.repository.list({
      organizationId: organization.objectId,
      status: query.status,
      search: query.search,
    });

    // Two grouped counts for the whole page rather than two per row: a list of
    // fifty clients must not become a hundred round trips.
    const [websiteCounts, contactCounts] = await Promise.all([
      this.websites.countByClient(organization.objectId),
      this.repository.countContactsByClient(organization.objectId),
    ]);

    return clients.map((client) =>
      toClientDto(client, {
        websiteCount: websiteCounts.get(client._id.toHexString()) ?? 0,
        contactCount: contactCounts.get(client._id.toHexString()) ?? 0,
      }),
    );
  }

  async findById(organization: OrganizationContext, clientId: string): Promise<ClientDto> {
    this.entitlements.assertFeature(organization, 'clients');
    const client = await this.requireClient(organization, clientId);

    const [websiteCounts, contactCounts] = await Promise.all([
      this.websites.countByClient(organization.objectId),
      this.repository.countContactsByClient(organization.objectId),
    ]);

    return toClientDto(client, {
      websiteCount: websiteCounts.get(clientId) ?? 0,
      contactCount: contactCounts.get(clientId) ?? 0,
    });
  }

  async create(
    organization: OrganizationContext,
    input: CreateClientInput,
    actor: OrganizationActor,
  ): Promise<ClientDto> {
    this.entitlements.assertFeature(organization, 'clients');
    await this.entitlements.assertWithinLimit(organization, 'maxClients');

    const actorObjectId = toObjectId(actor.id);
    if (!actorObjectId) throw ApiError.unauthenticated();

    try {
      const client = await this.repository.create({
        organizationId: organization.objectId,
        name: input.name,
        companyName: input.companyName ?? null,
        contactName: input.contactName ?? null,
        contactEmail: input.contactEmail ?? null,
        notes: input.notes ?? null,
        createdByUserId: actorObjectId,
      });

      await this.audit.record({
        organizationId: organization.objectId,
        action: 'client.created',
        actorUserId: actorObjectId,
        actorName: actor.name,
        targetType: 'client',
        targetId: client._id,
        targetLabel: client.name,
      });

      return toClientDto(client, { websiteCount: 0, contactCount: 0 });
    } catch (error) {
      // The unique index is the guarantee, so a double-submitted form surfaces
      // here rather than creating two clients an agency cannot tell apart.
      if (isDuplicateKeyError(error)) {
        throw ApiError.conflict('CLIENT_NAME_TAKEN', 'A client with that name already exists.');
      }
      throw error;
    }
  }

  async update(
    organization: OrganizationContext,
    clientId: string,
    input: UpdateClientInput,
    actor: OrganizationActor,
  ): Promise<ClientDto> {
    this.entitlements.assertFeature(organization, 'clients');
    const existing = await this.requireClient(organization, clientId);

    const changes: Parameters<ClientRepository['update']>[2] = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.companyName !== undefined) changes.companyName = input.companyName;
    if (input.contactName !== undefined) changes.contactName = input.contactName;
    if (input.contactEmail !== undefined) changes.contactEmail = input.contactEmail;
    if (input.notes !== undefined) changes.notes = input.notes;
    if (input.status !== undefined) changes.status = input.status;

    try {
      const updated = await this.repository.update(organization.objectId, clientId, changes);
      if (!updated) throw ApiError.notFound('CLIENT_NOT_FOUND', 'Client not found.');

      /*
       * Archiving closes the portal. An agency that archives a client expects
       * access to stop; expecting them to also remember each contact is how a
       * former client keeps reading a live dashboard for a year.
       */
      if (input.status === 'archived' && existing.status !== 'archived') {
        const revoked = await this.repository.revokeAllAccess(organization.objectId, existing._id);
        if (revoked > 0) {
          await this.audit.record({
            organizationId: organization.objectId,
            action: 'client.access_revoked',
            actorUserId: toObjectId(actor.id),
            actorName: actor.name,
            targetType: 'client',
            targetId: existing._id,
            targetLabel: updated.name,
          });
        }
      }

      await this.audit.record({
        organizationId: organization.objectId,
        action: 'client.updated',
        actorUserId: toObjectId(actor.id),
        actorName: actor.name,
        targetType: 'client',
        targetId: updated._id,
        targetLabel: updated.name,
      });

      return this.findById(organization, clientId);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw ApiError.conflict('CLIENT_NAME_TAKEN', 'A client with that name already exists.');
      }
      throw error;
    }
  }

  /**
   * Deletes a client.
   *
   * The websites survive and become unassigned: an agency deleting a client
   * relationship is not asking to stop monitoring their sites, and silently
   * deleting the monitoring would destroy history the agency may still need.
   * Portal access is revoked, because there is no longer anything to grant it
   * to.
   */
  async delete(
    organization: OrganizationContext,
    clientId: string,
    actor: OrganizationActor,
  ): Promise<void> {
    this.entitlements.assertFeature(organization, 'clients');

    const client = await this.requireClient(organization, clientId);

    await this.repository.revokeAllAccess(organization.objectId, client._id);
    await this.websites.detachClient(organization.objectId, client._id);

    const deleted = await this.repository.delete(organization.objectId, clientId);
    if (!deleted) throw ApiError.notFound('CLIENT_NOT_FOUND', 'Client not found.');

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'client.deleted',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'client',
      targetId: deleted._id,
      targetLabel: deleted.name,
    });
  }

  /* -------------------------------------------------------------- portal access */

  async listContacts(
    organization: OrganizationContext,
    clientId: string,
  ): Promise<readonly ClientContactDto[]> {
    this.entitlements.assertFeature(organization, 'client_portal');
    const client = await this.requireClient(organization, clientId);

    const [contacts, invitations] = await Promise.all([
      this.repository.listContacts(organization.objectId, client._id),
      this.members.listPendingInvitations(organization.objectId),
    ]);

    const users = await this.members.listMembers(organization.objectId);
    const byUserId = new Map(users.map((member) => [member.userId, member]));

    const accepted: ClientContactDto[] = contacts.map((contact) => {
      const user = byUserId.get(contact.userId.toHexString());
      return {
        id: contact.membershipId.toHexString(),
        email: user?.email ?? '',
        name: user?.name ?? '',
        status: 'active',
        joinedAt: contact.joinedAt.toISOString(),
      };
    });

    // Pending invitations for this client, so an agency can see that an invite
    // was sent and has not been accepted rather than wondering why nothing
    // appeared.
    const pending: ClientContactDto[] = invitations
      .filter((invitation) => invitation.role === 'client')
      .filter((invitation) => invitation.clientId?.toHexString() === clientId)
      .map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        name: '',
        status: 'invited',
        joinedAt: invitation.createdAt.toISOString(),
      }));

    return [...accepted, ...pending];
  }

  /**
   * Invites a contact to the client portal.
   *
   * Reuses the organization invitation flow entirely — same token, same expiry,
   * same acceptance route — with the client carried on the invitation. What
   * differs is the role, and that the invitation names the client so the
   * recipient cannot choose one.
   */
  async inviteContact(
    organization: OrganizationContext,
    clientId: string,
    input: InviteClientContactInput,
    actor: OrganizationActor,
  ): Promise<ClientContactDto> {
    this.entitlements.assertFeature(organization, 'client_portal');
    const client = await this.requireClient(organization, clientId);

    if (client.status !== 'active') {
      throw ApiError.conflict(
        'CONFLICT',
        'This client is archived. Restore it before inviting a contact.',
      );
    }

    const existingUserId = await this.members.findUserIdByEmail(input.email);
    if (existingUserId && (await this.members.isMember(organization.objectId, existingUserId))) {
      /*
       * Refused rather than silently converted. The address may belong to
       * somebody at the agency, and turning their membership into a
       * client-scoped one would lock them out of their own organization.
       */
      throw ApiError.conflict(
        'ALREADY_A_MEMBER',
        'That address already has access to this organization.',
      );
    }

    const actorObjectId = toObjectId(actor.id);
    if (!actorObjectId) throw ApiError.unauthenticated();

    const token = generateToken();
    const invitation = await this.members.upsertInvitation({
      organizationId: organization.objectId,
      email: input.email,
      role: 'client',
      clientId: client._id,
      tokenHash: hashToken(token),
      invitedByUserId: actorObjectId,
      invitedByName: actor.name,
      expiresAt: new Date(Date.now() + INVITATION_TTL_SECONDS * 1000),
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
      action: 'client.invited',
      actorUserId: actorObjectId,
      actorName: actor.name,
      targetType: 'client',
      targetId: client._id,
      targetLabel: client.name,
    });

    return {
      id: invitation.id,
      email: invitation.email,
      name: '',
      status: 'invited',
      joinedAt: invitation.createdAt.toISOString(),
    };
  }

  async revokeContact(
    organization: OrganizationContext,
    clientId: string,
    membershipId: string,
    actor: OrganizationActor,
  ): Promise<void> {
    this.entitlements.assertFeature(organization, 'client_portal');
    const client = await this.requireClient(organization, clientId);

    const revoked = await this.repository.revokeAccess(organization.objectId, membershipId);
    if (!revoked) {
      // Also the answer when the id names an internal member: `revokeAccess`
      // filters on the client role, so this route can never remove a colleague.
      throw ApiError.notFound('MEMBER_NOT_FOUND', 'That contact does not have portal access.');
    }

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'client.access_revoked',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'client',
      targetId: client._id,
      targetLabel: client.name,
    });
  }

  private async requireClient(
    organization: OrganizationContext,
    clientId: string,
  ): Promise<ClientRecord> {
    const client = await this.repository.findById(organization.objectId, clientId);
    if (!client) throw ApiError.notFound('CLIENT_NOT_FOUND', 'Client not found.');
    return client;
  }
}

export function toClientDto(
  client: ClientRecord,
  counts: { readonly websiteCount: number; readonly contactCount: number },
): ClientDto {
  return {
    id: client._id.toHexString(),
    name: client.name,
    companyName: client.companyName,
    contactName: client.contactName,
    contactEmail: client.contactEmail,
    status: client.status,
    notes: client.notes,
    websiteCount: counts.websiteCount,
    contactCount: counts.contactCount,
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
  };
}

/** Exported for the composition root's website-to-client resolver. */
export type ClientExistsResolver = (
  organizationId: Types.ObjectId,
  clientId: string,
) => Promise<Types.ObjectId | null>;
