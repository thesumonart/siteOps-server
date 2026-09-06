import type { Types } from 'mongoose';

import type { ClientStatus } from '../contracts/index.js';
import { ClientModel, OrganizationMemberModel, type ClientAttributes } from '../models/index.js';
import { toObjectId } from '../utils/object-id.js';

export interface ClientRecord extends ClientAttributes {
  readonly _id: Types.ObjectId;
}

/** A person with portal access to one client. */
export interface ClientContactRecord {
  readonly membershipId: Types.ObjectId;
  readonly userId: Types.ObjectId;
  readonly joinedAt: Date;
}

/**
 * Agency clients, and who has portal access to each.
 *
 * Portal access lives in `organization_members` rather than a table of its own —
 * a client contact is a normal user with a `client` membership carrying a
 * `clientId`. That is why this repository reaches into the membership
 * collection: the two are one concept, and splitting them would mean two
 * answers to "who can see this client's websites".
 */
export class ClientRepository {
  async list(filter: {
    readonly organizationId: Types.ObjectId;
    readonly status?: ClientStatus | undefined;
    readonly search?: string | undefined;
  }): Promise<readonly ClientRecord[]> {
    const query: Record<string, unknown> = { organizationId: filter.organizationId };
    if (filter.status) query.status = filter.status;

    if (filter.search && filter.search.length > 0) {
      const pattern = new RegExp(escapeRegex(filter.search), 'i');
      query.$or = [{ name: pattern }, { companyName: pattern }, { contactEmail: pattern }];
    }

    return ClientModel.find(query).sort({ status: 1, name: 1 }).lean<ClientRecord[]>().exec();
  }

  async findById(organizationId: Types.ObjectId, clientId: string): Promise<ClientRecord | null> {
    const clientObjectId = toObjectId(clientId);
    if (!clientObjectId) return null;

    return ClientModel.findOne({ _id: clientObjectId, organizationId }).lean<ClientRecord>().exec();
  }

  /**
   * Resolves a client id to its ObjectId, or null.
   *
   * The narrow existence check the website service uses when a website is
   * assigned to a client. Scoped by organization, so a client id belonging to
   * another agency simply does not resolve.
   */
  async exists(organizationId: Types.ObjectId, clientId: string): Promise<Types.ObjectId | null> {
    const clientObjectId = toObjectId(clientId);
    if (!clientObjectId) return null;

    const found = await ClientModel.exists({ _id: clientObjectId, organizationId });
    return found ? clientObjectId : null;
  }

  async create(input: {
    readonly organizationId: Types.ObjectId;
    readonly name: string;
    readonly companyName: string | null;
    readonly contactName: string | null;
    readonly contactEmail: string | null;
    readonly notes: string | null;
    readonly createdByUserId: Types.ObjectId;
  }): Promise<ClientRecord> {
    const created = await ClientModel.create({ ...input, status: 'active' });
    return created.toObject<ClientRecord>();
  }

  async update(
    organizationId: Types.ObjectId,
    clientId: string,
    changes: Partial<
      Pick<
        ClientAttributes,
        'name' | 'companyName' | 'contactName' | 'contactEmail' | 'notes' | 'status'
      >
    >,
  ): Promise<ClientRecord | null> {
    const clientObjectId = toObjectId(clientId);
    if (!clientObjectId) return null;

    return ClientModel.findOneAndUpdate(
      { _id: clientObjectId, organizationId },
      { $set: changes },
      { returnDocument: 'after' },
    )
      .lean<ClientRecord>()
      .exec();
  }

  async delete(organizationId: Types.ObjectId, clientId: string): Promise<ClientRecord | null> {
    const clientObjectId = toObjectId(clientId);
    if (!clientObjectId) return null;

    return ClientModel.findOneAndDelete({ _id: clientObjectId, organizationId })
      .lean<ClientRecord>()
      .exec();
  }

  async countForOrganization(organizationId: Types.ObjectId): Promise<number> {
    return ClientModel.countDocuments({ organizationId }).exec();
  }

  /* ------------------------------------------------------------- portal access */

  /** The people with portal access to one client. */
  async listContacts(
    organizationId: Types.ObjectId,
    clientId: Types.ObjectId,
  ): Promise<readonly ClientContactRecord[]> {
    const rows = await OrganizationMemberModel.find({
      organizationId,
      clientId,
      role: 'client',
    })
      .select({ userId: 1, joinedAt: 1 })
      .lean<{ _id: Types.ObjectId; userId: Types.ObjectId; joinedAt: Date }[]>()
      .exec();

    return rows.map((row) => ({
      membershipId: row._id,
      userId: row.userId,
      joinedAt: row.joinedAt,
    }));
  }

  /** How many contacts each client has, for the client list. */
  async countContactsByClient(
    organizationId: Types.ObjectId,
  ): Promise<ReadonlyMap<string, number>> {
    const rows = await OrganizationMemberModel.aggregate<{
      _id: Types.ObjectId | null;
      count: number;
    }>([
      { $match: { organizationId, role: 'client', clientId: { $ne: null } } },
      { $group: { _id: '$clientId', count: { $sum: 1 } } },
    ]).exec();

    return new Map(
      rows
        .filter((row): row is { _id: Types.ObjectId; count: number } => row._id !== null)
        .map((row) => [row._id.toHexString(), row.count]),
    );
  }

  /**
   * Removes every portal membership for a client.
   *
   * Called when a client is archived or deleted. Revoking access is deleting a
   * membership — the same operation the product already performs correctly for
   * an internal member — rather than a flag somewhere that a query might forget
   * to consult.
   */
  async revokeAllAccess(organizationId: Types.ObjectId, clientId: Types.ObjectId): Promise<number> {
    const result = await OrganizationMemberModel.deleteMany({
      organizationId,
      clientId,
      role: 'client',
    }).exec();

    return result.deletedCount;
  }

  async revokeAccess(organizationId: Types.ObjectId, membershipId: string): Promise<boolean> {
    const membershipObjectId = toObjectId(membershipId);
    if (!membershipObjectId) return false;

    const result = await OrganizationMemberModel.deleteOne({
      _id: membershipObjectId,
      organizationId,
      // Scoped to `client` so this can never be used to remove a colleague:
      // internal members are removed through the members routes, which enforce
      // the last-owner rule.
      role: 'client',
    }).exec();

    return result.deletedCount > 0;
  }
}

/** Escapes a user string so it cannot smuggle regex syntax into a query. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
