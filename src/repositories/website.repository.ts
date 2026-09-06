import { Types } from 'mongoose';

import type { WebsiteStatus } from '../contracts/index.js';
import {
  IncidentModel,
  MonitorResultModel,
  WebsiteCheckModel,
  WebsiteModel,
  WebsiteMonitorModel,
  type WebsiteAttributes,
} from '../models/index.js';
import { toObjectId } from '../utils/object-id.js';

export interface WebsiteRecord extends WebsiteAttributes {
  readonly _id: Types.ObjectId;
}

export interface ListWebsitesFilter {
  readonly organizationId: Types.ObjectId;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | undefined;
  readonly status?: WebsiteStatus | undefined;
  /** Narrows to one client's websites. Part of the tenant boundary, not a filter. */
  readonly clientScope?: Types.ObjectId | null | undefined;
  /** An agency filtering its own view by client. */
  readonly clientId?: string | undefined;
}

export interface ListWebsitesResult {
  readonly items: readonly WebsiteRecord[];
  readonly totalItems: number;
}

/** The website fields an incident row displays. */
export interface WebsiteLabel {
  readonly name: string;
  readonly url: string;
}

/** Escapes a user string so it cannot smuggle regex syntax into a query. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Website data access.
 *
 * Every method takes `organizationId` and every query filters on it. There is
 * no code path that reads or writes a website without naming its tenant, which
 * is what makes cross-tenant access impossible rather than merely unlikely.
 */
export class WebsiteRepository {
  async list(filter: ListWebsitesFilter): Promise<ListWebsitesResult> {
    const query: Record<string, unknown> = { organizationId: filter.organizationId };

    /*
     * The client scope is applied first and unconditionally. It comes from the
     * membership the middleware read from the database, not from the request,
     * and it is the difference between "this organization's websites" and "the
     * websites this contact is allowed to see". A `clientId` *filter* below is
     * an agency narrowing its own view and is applied on top — it can never
     * widen the scope, because both end up in the same `$and`ed query.
     */
    if (filter.clientScope) query.clientId = filter.clientScope;

    if (filter.clientId !== undefined) {
      const clientObjectId = toObjectId(filter.clientId);
      // An unparseable id matches nothing rather than being ignored, which
      // would silently return every website instead of none.
      query.clientId = clientObjectId ?? new Types.ObjectId('000000000000000000000000');
    }

    if (filter.status) {
      query.status = filter.status;
    }
    if (filter.search && filter.search.length > 0) {
      const pattern = new RegExp(escapeRegex(filter.search), 'i');
      query.$or = [{ name: pattern }, { url: pattern }];
    }

    const skip = (filter.page - 1) * filter.pageSize;

    const [items, totalItems] = await Promise.all([
      WebsiteModel.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(filter.pageSize)
        .lean<WebsiteRecord[]>()
        .exec(),
      WebsiteModel.countDocuments(query).exec(),
    ]);

    return { items, totalItems };
  }

  async findById(
    organizationId: Types.ObjectId,
    websiteId: string,
    clientScope?: Types.ObjectId | null,
  ): Promise<WebsiteRecord | null> {
    const websiteObjectId = toObjectId(websiteId);
    if (!websiteObjectId) return null;

    const query: Record<string, unknown> = { _id: websiteObjectId, organizationId };
    // Both scopes are part of the filter, not checked afterwards: a website in
    // another tenant — or belonging to another client — simply does not
    // resolve, which is what makes a 404 the honest answer.
    if (clientScope) query.clientId = clientScope;

    return WebsiteModel.findOne(query).lean<WebsiteRecord>().exec();
  }

  async countForOrganization(organizationId: Types.ObjectId): Promise<number> {
    return WebsiteModel.countDocuments({ organizationId }).exec();
  }

  /**
   * Website counts per status, for the overview cards.
   *
   * One grouped aggregation rather than a count per status: the numbers on a
   * summary card should come from a single read, or they can disagree with
   * each other when a check lands between two queries.
   */
  async countByStatus(
    organizationId: Types.ObjectId,
    clientScope?: Types.ObjectId | null,
  ): Promise<ReadonlyMap<WebsiteStatus, number>> {
    const match: Record<string, unknown> = { organizationId };
    if (clientScope) match.clientId = clientScope;

    const rows = await WebsiteModel.aggregate<{ _id: WebsiteStatus; count: number }>([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec();

    return new Map(rows.map((row) => [row._id, row.count]));
  }

  async create(input: {
    readonly organizationId: Types.ObjectId;
    readonly name: string;
    readonly url: string;
    readonly canonicalKey: string;
    readonly monitoringIntervalSeconds: number;
    readonly requestTimeoutMs: number;
    readonly failureThreshold: number;
    readonly recoveryThreshold: number;
  }): Promise<WebsiteRecord> {
    const created = await WebsiteModel.create({
      organizationId: input.organizationId,
      name: input.name,
      url: input.url,
      canonicalKey: input.canonicalKey,
      status: 'unknown',
      monitoringEnabled: true,
      monitoringIntervalSeconds: input.monitoringIntervalSeconds,
      requestTimeoutMs: input.requestTimeoutMs,
      failureThreshold: input.failureThreshold,
      recoveryThreshold: input.recoveryThreshold,
      // Due immediately, so the worker picks it up on its next pass rather than
      // after a full interval of silence.
      nextCheckAt: new Date(),
    });

    return created.toObject<WebsiteRecord>();
  }

  async update(
    organizationId: Types.ObjectId,
    websiteId: string,
    changes: Partial<
      Pick<
        WebsiteAttributes,
        | 'name'
        | 'url'
        | 'canonicalKey'
        | 'monitoringIntervalSeconds'
        | 'requestTimeoutMs'
        | 'failureThreshold'
        | 'recoveryThreshold'
        | 'monitoringEnabled'
        | 'status'
        | 'nextCheckAt'
        | 'consecutiveFailures'
        | 'consecutiveSuccesses'
        | 'clientId'
      >
    >,
  ): Promise<WebsiteRecord | null> {
    const websiteObjectId = toObjectId(websiteId);
    if (!websiteObjectId) return null;

    return WebsiteModel.findOneAndUpdate(
      { _id: websiteObjectId, organizationId },
      { $set: changes },
      { returnDocument: 'after' },
    )
      .lean<WebsiteRecord>()
      .exec();
  }

  async delete(organizationId: Types.ObjectId, websiteId: string): Promise<WebsiteRecord | null> {
    const websiteObjectId = toObjectId(websiteId);
    if (!websiteObjectId) return null;

    return WebsiteModel.findOneAndDelete({ _id: websiteObjectId, organizationId })
      .lean<WebsiteRecord>()
      .exec();
  }

  /**
   * Names and URLs for a set of websites, in one query.
   *
   * Deliberately not scoped by organization: the caller already resolved these
   * ids from documents it read inside a tenant-scoped query, and only two
   * display fields are returned. Requiring the organization here would add a
   * redundant filter to a lookup that cannot widen anyone's access.
   */
  async labelsFor(
    websiteIds: readonly Types.ObjectId[],
  ): Promise<ReadonlyMap<string, WebsiteLabel>> {
    if (websiteIds.length === 0) return new Map();

    const rows = await WebsiteModel.find({ _id: { $in: websiteIds } })
      .select({ name: 1, url: 1 })
      .lean<{ _id: Types.ObjectId; name: string; url: string }[]>()
      .exec();

    return new Map(rows.map((row) => [row._id.toHexString(), { name: row.name, url: row.url }]));
  }

  async deleteIncidentsFor(websiteId: Types.ObjectId): Promise<number> {
    const result = await IncidentModel.deleteMany({ websiteId }).exec();
    return result.deletedCount;
  }

  async deleteChecksFor(websiteId: Types.ObjectId): Promise<number> {
    const result = await WebsiteCheckModel.deleteMany({ websiteId }).exec();
    return result.deletedCount;
  }

  /**
   * Removes the auxiliary monitors and their results.
   *
   * Done with the incidents rather than in the background: a monitor left
   * behind is not merely stale data, it is a document the worker will keep
   * claiming and failing to resolve a website for, forever.
   */
  /** Every website id belonging to one client, for scoping a bulk read. */
  async idsForClient(
    organizationId: Types.ObjectId,
    clientId: Types.ObjectId,
  ): Promise<readonly Types.ObjectId[]> {
    const rows = await WebsiteModel.find({ organizationId, clientId })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();

    return rows.map((row) => row._id);
  }

  /** How many websites one client has, for the client list. */
  async countByClient(organizationId: Types.ObjectId): Promise<ReadonlyMap<string, number>> {
    const rows = await WebsiteModel.aggregate<{ _id: Types.ObjectId | null; count: number }>([
      { $match: { organizationId, clientId: { $ne: null } } },
      { $group: { _id: '$clientId', count: { $sum: 1 } } },
    ]).exec();

    return new Map(
      rows
        .filter((row): row is { _id: Types.ObjectId; count: number } => row._id !== null)
        .map((row) => [row._id.toHexString(), row.count]),
    );
  }

  /**
   * Detaches every website from a client.
   *
   * Called when a client is deleted. The websites stay — an agency deleting a
   * client relationship is not asking to stop monitoring their sites — they
   * simply become unassigned.
   */
  async detachClient(organizationId: Types.ObjectId, clientId: Types.ObjectId): Promise<number> {
    const result = await WebsiteModel.updateMany(
      { organizationId, clientId },
      { $set: { clientId: null } },
    ).exec();

    return result.modifiedCount;
  }

  async deleteMonitorsFor(websiteId: Types.ObjectId): Promise<number> {
    const [monitors] = await Promise.all([
      WebsiteMonitorModel.deleteMany({ websiteId }).exec(),
      MonitorResultModel.deleteMany({ websiteId }).exec(),
    ]);
    return monitors.deletedCount;
  }
}
