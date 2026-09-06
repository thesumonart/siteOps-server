import type { Types } from 'mongoose';

import type {
  BillingInterval,
  OrganizationRole,
  Plan,
  SubscriptionStatus,
} from '../contracts/index.js';
import {
  OrganizationMemberModel,
  OrganizationModel,
  WebsiteModel,
  type OrganizationAttributes,
  type OrganizationMemberAttributes,
} from '../models/index.js';
import { toObjectId } from '../utils/object-id.js';

/**
 * Data access for organizations and their membership.
 *
 * Every method that reads organization-owned data takes the organization id as
 * a required argument — there is no query path that omits it. That is what
 * makes tenant isolation a property of this layer rather than a habit of the
 * caller.
 */

export interface OrganizationRecord extends OrganizationAttributes {
  readonly _id: Types.ObjectId;
}

export interface MembershipRecord {
  readonly organizationId: Types.ObjectId;
  readonly userId: Types.ObjectId;
  readonly role: OrganizationRole;
  /** Set only for a `client` membership: the client this person may see. */
  readonly clientId: Types.ObjectId | null;
  readonly joinedAt: Date;
}

export interface MembershipWithOrganization {
  readonly membership: MembershipRecord;
  readonly organization: OrganizationRecord;
  readonly websiteCount: number;
}

export class OrganizationRepository {
  /**
   * Resolves a user's role in one organization.
   *
   * This is the single source of truth for "may this person act here". The
   * organization id comes from the client and is untrusted; a non-member gets
   * `null`, and the caller turns that into a 404.
   */
  async findMembership(organizationId: string, userId: string): Promise<MembershipRecord | null> {
    const orgObjectId = toObjectId(organizationId);
    const userObjectId = toObjectId(userId);
    if (!orgObjectId || !userObjectId) return null;

    const member = await OrganizationMemberModel.findOne({
      organizationId: orgObjectId,
      userId: userObjectId,
    })
      .lean()
      .exec();

    if (!member) return null;

    return {
      organizationId: member.organizationId,
      userId: member.userId,
      role: member.role,
      // Nullish rather than strict, because memberships written before client
      // access existed carry no field at all.
      clientId: member.clientId ?? null,
      joinedAt: member.joinedAt,
    };
  }

  async findById(organizationId: string): Promise<OrganizationRecord | null> {
    const orgObjectId = toObjectId(organizationId);
    if (!orgObjectId) return null;

    return OrganizationModel.findById(orgObjectId).lean<OrganizationRecord>().exec();
  }

  /** Every organization the user belongs to, oldest membership first. */
  async listForUser(userId: string): Promise<readonly MembershipWithOrganization[]> {
    const userObjectId = toObjectId(userId);
    if (!userObjectId) return [];

    const memberships = await OrganizationMemberModel.find({ userId: userObjectId })
      .sort({ joinedAt: 1 })
      .lean()
      .exec();

    if (memberships.length === 0) return [];

    const organizationIds = memberships.map((member) => member.organizationId);

    const [organizations, websiteCounts] = await Promise.all([
      OrganizationModel.find({ _id: { $in: organizationIds } })
        .lean<OrganizationRecord[]>()
        .exec(),
      // One grouped count rather than a query per organization: the list is
      // short, but this is the shape that stays cheap as it grows.
      WebsiteModel.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { organizationId: { $in: organizationIds } } },
        { $group: { _id: '$organizationId', count: { $sum: 1 } } },
      ]).exec(),
    ]);

    const organizationById = new Map(organizations.map((org) => [org._id.toHexString(), org]));
    const countById = new Map(websiteCounts.map((row) => [row._id.toHexString(), row.count]));

    const result: MembershipWithOrganization[] = [];
    for (const member of memberships) {
      const key = member.organizationId.toHexString();
      const organization = organizationById.get(key);
      // A membership whose organization was deleted is skipped rather than
      // surfaced as a broken row.
      if (!organization) continue;

      result.push({
        membership: {
          organizationId: member.organizationId,
          userId: member.userId,
          role: member.role,
          clientId: member.clientId ?? null,
          joinedAt: member.joinedAt,
        },
        organization,
        websiteCount: countById.get(key) ?? 0,
      });
    }
    return result;
  }

  async slugExists(slug: string): Promise<boolean> {
    return (await OrganizationModel.exists({ slug })) !== null;
  }

  async countWebsites(organizationId: Types.ObjectId): Promise<number> {
    return WebsiteModel.countDocuments({ organizationId }).exec();
  }

  async countMembers(organizationId: Types.ObjectId): Promise<number> {
    return OrganizationMemberModel.countDocuments({ organizationId }).exec();
  }

  /**
   * Creates the organization and its first membership.
   *
   * Both documents are written in one transaction: an organization with no
   * owner would be unreachable by anyone, including the person who made it.
   */
  async createWithOwner(input: {
    readonly name: string;
    readonly slug: string;
    readonly timezone: string;
    readonly ownerUserId: Types.ObjectId;
  }): Promise<OrganizationRecord> {
    const session = await OrganizationModel.startSession();
    try {
      let created: OrganizationRecord | null = null;

      await session.withTransaction(async () => {
        const [organization] = await OrganizationModel.create(
          [
            {
              name: input.name,
              slug: input.slug,
              timezone: input.timezone,
              createdByUserId: input.ownerUserId,
            } satisfies Partial<OrganizationAttributes>,
          ],
          { session },
        );
        if (!organization) throw new Error('Organization insert returned no document.');

        await OrganizationMemberModel.create(
          [
            {
              organizationId: organization._id,
              userId: input.ownerUserId,
              role: 'owner',
              invitedByUserId: null,
              joinedAt: new Date(),
            } satisfies Partial<OrganizationMemberAttributes>,
          ],
          { session },
        );

        created = organization.toObject<OrganizationRecord>();
      });

      if (!created) throw new Error('Organization transaction produced no document.');
      return created;
    } finally {
      await session.endSession();
    }
  }

  async update(
    organizationId: string,
    changes: { readonly name?: string; readonly timezone?: string },
  ): Promise<OrganizationRecord | null> {
    const orgObjectId = toObjectId(organizationId);
    if (!orgObjectId) return null;

    return OrganizationModel.findByIdAndUpdate(
      orgObjectId,
      { $set: changes },
      { returnDocument: 'after' },
    )
      .lean<OrganizationRecord>()
      .exec();
  }

  async planFor(organizationId: string): Promise<Plan | null> {
    const organization = await this.findById(organizationId);
    return organization?.plan ?? null;
  }

  /**
   * Finds the organization a provider customer belongs to.
   *
   * This is how a webhook is routed: the payload names a customer, never an
   * organization, because the provider has never heard of our tenancy. Backed
   * by the unique sparse index on `billing.customerId`, so a missing customer
   * is a cheap miss rather than a collection scan.
   */
  async findByBillingCustomerId(customerId: string): Promise<OrganizationRecord | null> {
    if (customerId.length === 0) return null;
    return OrganizationModel.findOne({ 'billing.customerId': customerId })
      .lean<OrganizationRecord>()
      .exec();
  }

  /**
   * Records the provider customer for an organization, once.
   *
   * Conditional on the field still being unset, so two checkout sessions opened
   * from two tabs cannot end with the second overwriting the first — the loser
   * gets `null` back and the caller reuses the customer that already exists.
   * Without that condition the organization would end up pointing at one
   * customer while the provider holds a subscription against the other.
   */
  async attachBillingCustomer(
    organizationId: Types.ObjectId,
    customerId: string,
  ): Promise<OrganizationRecord | null> {
    return OrganizationModel.findOneAndUpdate(
      {
        _id: organizationId,
        $or: [{ 'billing.customerId': null }, { 'billing.customerId': { $exists: false } }],
      },
      { $set: { 'billing.customerId': customerId } },
      { returnDocument: 'after' },
    )
      .lean<OrganizationRecord>()
      .exec();
  }

  /**
   * Applies subscription state from a provider event.
   *
   * Writes the plan and the billing record together in one update: they are one
   * fact, and an interleaved failure that set the plan without the status —
   * or the reverse — would leave an organization whose entitlements and whose
   * billing page disagree.
   *
   * The `lastEventAt` guard makes the write a no-op for an event older than the
   * one already applied. Webhooks are not ordered, and a late `updated`
   * overwriting a newer `deleted` is exactly the bug that leaves a cancelled
   * customer on a paid plan forever.
   */
  async applySubscriptionState(
    organizationId: Types.ObjectId,
    state: {
      readonly plan: Plan;
      readonly status: SubscriptionStatus;
      readonly subscriptionId: string | null;
      readonly interval: BillingInterval | null;
      readonly currentPeriodEnd: Date | null;
      readonly cancelAtPeriodEnd: boolean;
      readonly trialEndsAt: Date | null;
      readonly eventAt: Date;
    },
  ): Promise<OrganizationRecord | null> {
    return OrganizationModel.findOneAndUpdate(
      {
        _id: organizationId,
        $or: [
          { 'billing.lastEventAt': null },
          { 'billing.lastEventAt': { $exists: false } },
          { 'billing.lastEventAt': { $lte: state.eventAt } },
        ],
      },
      {
        $set: {
          plan: state.plan,
          'billing.status': state.status,
          'billing.subscriptionId': state.subscriptionId,
          'billing.interval': state.interval,
          'billing.currentPeriodEnd': state.currentPeriodEnd,
          'billing.cancelAtPeriodEnd': state.cancelAtPeriodEnd,
          'billing.trialEndsAt': state.trialEndsAt,
          'billing.lastEventAt': state.eventAt,
        },
      },
      { returnDocument: 'after' },
    )
      .lean<OrganizationRecord>()
      .exec();
  }
}
