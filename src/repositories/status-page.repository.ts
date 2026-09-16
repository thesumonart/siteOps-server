import type { Types } from 'mongoose';

import type { IncidentCategory, Plan, WebsiteStatus } from '../contracts/index.js';
import {
  IncidentModel,
  OrganizationModel,
  StatusPageModel,
  WebsiteCheckModel,
  WebsiteModel,
  type StatusPageAttributes,
  type StatusPageComponent,
} from '../models/index.js';
import { toObjectId } from '../utils/object-id.js';

export interface StatusPageRecord extends StatusPageAttributes {
  readonly _id: Types.ObjectId;
}

export type StatusPageChanges = Partial<
  Pick<
    StatusPageAttributes,
    'title' | 'slug' | 'description' | 'published' | 'theme' | 'components'
  >
>;

export interface DailyCheckCounts {
  readonly total: number;
  readonly successful: number;
}

export interface PublicIncidentRow {
  readonly websiteId: Types.ObjectId;
  readonly category: IncidentCategory;
  readonly startedAt: Date;
}

/**
 * The index the daily history is read from.
 *
 * `{ websiteId, status, checkedAt, _id }` holds every field the aggregation
 * touches, so the database answers it from the index alone and never loads a
 * check document. That is what makes it reasonable for an unauthenticated
 * endpoint to ask for ninety days of history at all — see
 * `dailyCheckCounts`.
 */
const COVERING_CHECK_INDEX = 'check_website_status_checked_at';

/** A page with more open incidents than this has bigger problems than the list length. */
const MAX_PUBLIC_INCIDENTS = 50;

/**
 * Status pages, and the narrow public reads they are built from.
 *
 * Management methods take the organization id like every other repository.
 * The public ones cannot — a visitor arrives with a slug or a hostname, and the
 * page is what names the organization — so they return only what a published
 * page shows, and every query after the first is scoped by the organization
 * the page belongs to.
 */
export class StatusPageRepository {
  /** Bounded by the plan's status page limit. */
  async list(organizationId: Types.ObjectId): Promise<readonly StatusPageRecord[]> {
    return StatusPageModel.find({ organizationId })
      .sort({ createdAt: -1 })
      .lean<StatusPageRecord[]>()
      .exec();
  }

  async findById(organizationId: Types.ObjectId, pageId: string): Promise<StatusPageRecord | null> {
    const pageObjectId = toObjectId(pageId);
    if (!pageObjectId) return null;
    return StatusPageModel.findOne({ _id: pageObjectId, organizationId })
      .lean<StatusPageRecord>()
      .exec();
  }

  async create(input: {
    readonly organizationId: Types.ObjectId;
    readonly slug: string;
    readonly title: string;
    readonly description: string | null;
    readonly published: boolean;
    readonly theme: StatusPageAttributes['theme'];
    readonly components: readonly StatusPageComponent[];
    readonly createdByUserId: Types.ObjectId;
  }): Promise<StatusPageRecord> {
    const created = await StatusPageModel.create({
      ...input,
      components: [...input.components],
      customDomain: null,
    });
    return created.toObject<StatusPageRecord>();
  }

  async update(
    organizationId: Types.ObjectId,
    pageId: Types.ObjectId,
    changes: StatusPageChanges,
  ): Promise<StatusPageRecord | null> {
    return StatusPageModel.findOneAndUpdate(
      { _id: pageId, organizationId },
      { $set: changes },
      { returnDocument: 'after', runValidators: true },
    )
      .lean<StatusPageRecord>()
      .exec();
  }

  async delete(
    organizationId: Types.ObjectId,
    pageId: Types.ObjectId,
  ): Promise<StatusPageRecord | null> {
    return StatusPageModel.findOneAndDelete({ _id: pageId, organizationId })
      .lean<StatusPageRecord>()
      .exec();
  }

  async countForOrganization(organizationId: Types.ObjectId): Promise<number> {
    return StatusPageModel.countDocuments({ organizationId }).exec();
  }

  /** Pages holding a domain, pending or verified: a claim occupies a slot from the moment it is made. */
  async countCustomDomains(organizationId: Types.ObjectId): Promise<number> {
    return StatusPageModel.countDocuments({ organizationId, customDomain: { $ne: null } }).exec();
  }

  /**
   * How many of `websiteIds` belong to the organization.
   *
   * A page may only show the organization's own websites. Counting rather than
   * loading them is enough to say whether every id passed that test.
   */
  async countOwnedWebsites(
    organizationId: Types.ObjectId,
    websiteIds: readonly Types.ObjectId[],
  ): Promise<number> {
    if (websiteIds.length === 0) return 0;
    return WebsiteModel.countDocuments({ organizationId, _id: { $in: websiteIds } }).exec();
  }

  async setCustomDomain(
    organizationId: Types.ObjectId,
    pageId: Types.ObjectId,
    claim: { readonly domain: string; readonly verificationToken: string },
  ): Promise<StatusPageRecord | null> {
    return StatusPageModel.findOneAndUpdate(
      { _id: pageId, organizationId },
      { $set: { customDomain: { ...claim, verifiedAt: null } } },
      { returnDocument: 'after', runValidators: true },
    )
      .lean<StatusPageRecord>()
      .exec();
  }

  /**
   * Marks the page's claim verified.
   *
   * Conditioned on the domain still being the one that was checked, so a claim
   * changed between the DNS lookup and this write is not verified by a record
   * that proved a different name. Throws a duplicate-key error when another
   * page already verified the domain — the unique index is the arbiter.
   */
  async markCustomDomainVerified(
    organizationId: Types.ObjectId,
    pageId: Types.ObjectId,
    domain: string,
    at: Date,
  ): Promise<StatusPageRecord | null> {
    return StatusPageModel.findOneAndUpdate(
      { _id: pageId, organizationId, 'customDomain.domain': domain },
      { $set: { 'customDomain.verifiedAt': at } },
      { returnDocument: 'after' },
    )
      .lean<StatusPageRecord>()
      .exec();
  }

  async clearCustomDomain(
    organizationId: Types.ObjectId,
    pageId: Types.ObjectId,
  ): Promise<StatusPageRecord | null> {
    return StatusPageModel.findOneAndUpdate(
      { _id: pageId, organizationId },
      { $set: { customDomain: null } },
      { returnDocument: 'after' },
    )
      .lean<StatusPageRecord>()
      .exec();
  }

  /* ------------------------------------------------------------- public reads */

  async findPublishedBySlug(slug: string): Promise<StatusPageRecord | null> {
    return StatusPageModel.findOne({ slug, published: true }).lean<StatusPageRecord>().exec();
  }

  async findPublishedById(pageId: string): Promise<StatusPageRecord | null> {
    const pageObjectId = toObjectId(pageId);
    if (!pageObjectId) return null;
    return StatusPageModel.findOne({ _id: pageObjectId, published: true })
      .lean<StatusPageRecord>()
      .exec();
  }

  /** The page a verified domain belongs to. An unverified claim never matches. */
  async findIdByVerifiedDomain(domain: string): Promise<string | null> {
    const row = await StatusPageModel.findOne({
      'customDomain.domain': domain,
      'customDomain.verifiedAt': { $type: 'date' },
    })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>()
      .exec();
    return row?._id.toHexString() ?? null;
  }

  async planOf(organizationId: Types.ObjectId): Promise<Plan | null> {
    const organization = await OrganizationModel.findById(organizationId)
      .select({ plan: 1 })
      .lean<{ plan: Plan }>()
      .exec();
    return organization?.plan ?? null;
  }

  /** Current status of each website, keyed by id. Only the organization's own. */
  async websiteStatuses(
    organizationId: Types.ObjectId,
    websiteIds: readonly Types.ObjectId[],
  ): Promise<ReadonlyMap<string, WebsiteStatus>> {
    if (websiteIds.length === 0) return new Map();

    const rows = await WebsiteModel.find({ organizationId, _id: { $in: websiteIds } })
      .select({ status: 1 })
      .lean<{ _id: Types.ObjectId; status: WebsiteStatus }[]>()
      .exec();

    return new Map(rows.map((row) => [row._id.toHexString(), row.status]));
  }

  /**
   * Checks per website per UTC day since `since`, total and successful.
   *
   * Grouped in the database, from the covering index, and never shipped to
   * this process as documents: ninety days of a one-minute monitor is well over
   * a hundred thousand checks, and a public endpoint must not be the way to make
   * the API read them.
   *
   * Days with no checks are absent from the result, not zero — the same rule
   * the charts follow. A gap means nothing was measured, and a visitor should
   * see "no data", not an outage.
   */
  async dailyCheckCounts(
    websiteIds: readonly Types.ObjectId[],
    since: Date,
  ): Promise<ReadonlyMap<string, ReadonlyMap<string, DailyCheckCounts>>> {
    if (websiteIds.length === 0) return new Map();

    const rows = await WebsiteCheckModel.aggregate<{
      _id: { websiteId: Types.ObjectId; day: string };
      total: number;
      successful: number;
    }>([
      { $match: { websiteId: { $in: [...websiteIds] }, checkedAt: { $gte: since } } },
      {
        $group: {
          _id: {
            websiteId: '$websiteId',
            day: { $dateToString: { format: '%Y-%m-%d', date: '$checkedAt' } },
          },
          total: { $sum: 1 },
          successful: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 1, 0] } },
        },
      },
    ])
      .option({ hint: COVERING_CHECK_INDEX })
      .exec();

    const byWebsite = new Map<string, Map<string, DailyCheckCounts>>();
    for (const row of rows) {
      const key = row._id.websiteId.toHexString();
      const days = byWebsite.get(key) ?? new Map<string, DailyCheckCounts>();
      days.set(row._id.day, { total: row.total, successful: row.successful });
      byWebsite.set(key, days);
    }
    return byWebsite;
  }

  /**
   * Open incidents a visitor may be told about: outages and response-time
   * anomalies. Certificate, domain, content and SEO problems stay internal.
   */
  async openPublicIncidents(
    organizationId: Types.ObjectId,
    websiteIds: readonly Types.ObjectId[],
  ): Promise<readonly PublicIncidentRow[]> {
    if (websiteIds.length === 0) return [];

    return IncidentModel.find({
      organizationId,
      status: 'open',
      websiteId: { $in: [...websiteIds] },
      category: { $in: ['availability', 'anomaly'] },
    })
      .select({ websiteId: 1, category: 1, startedAt: 1 })
      .sort({ startedAt: -1 })
      .limit(MAX_PUBLIC_INCIDENTS)
      .lean<PublicIncidentRow[]>()
      .exec();
  }
}
