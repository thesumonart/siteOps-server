import type { Types } from 'mongoose';

import type {
  ChannelDeliveryStatus,
  ChannelEvent,
  ChannelEventPayload,
  ChannelType,
} from '../contracts/index.js';
import {
  ChannelDeliveryModel,
  NotificationChannelModel,
  type ChannelDeliveryAttributes,
  type NotificationChannelAttributes,
} from '../models/index.js';
import { toObjectId } from '../utils/object-id.js';
import { cursorFilter, type DecodedCursor } from '../utils/pagination.js';
import { isDuplicateKeyError } from './notification.repository.js';

export interface ChannelRecord extends NotificationChannelAttributes {
  readonly _id: Types.ObjectId;
}

export interface ChannelDeliveryRecord extends ChannelDeliveryAttributes {
  readonly _id: Types.ObjectId;
}

export type ChannelChanges = Partial<
  Pick<
    NotificationChannelAttributes,
    'name' | 'enabled' | 'events' | 'urlCiphertext' | 'targetPreview' | 'metadata'
  > & { secretCiphertext: string }
>;

export interface ListDeliveriesFilter {
  readonly organizationId: Types.ObjectId;
  readonly channelId: Types.ObjectId;
  readonly pageSize: number;
  readonly status?: ChannelDeliveryStatus | undefined;
  readonly cursor?: DecodedCursor | undefined;
}

/**
 * Notification channels and the messages owed to them.
 *
 * One repository for both collections for the same reason `NotificationRepository`
 * holds deliveries and preferences together: they are only ever used together.
 * The dashboard reads a channel and its delivery log; the worker reads a
 * channel to decide what to enqueue and writes back how the delivery went.
 *
 * Every read an API route can reach takes the organization id and filters on
 * it. The worker's delivery path reads by the channel id a delivery already
 * carries — together with the organization id it was enqueued under, so even a
 * corrupted delivery document cannot send one tenant's event through another
 * tenant's channel.
 */
export class ChannelRepository {
  /**
   * Every channel in an organization, newest first.
   *
   * Unpaginated on purpose: the count is bounded by the plan's integration
   * limit, and the settings screen shows them all at once.
   */
  async list(organizationId: Types.ObjectId): Promise<readonly ChannelRecord[]> {
    return NotificationChannelModel.find({ organizationId })
      .sort({ createdAt: -1 })
      .lean<ChannelRecord[]>()
      .exec();
  }

  async findById(organizationId: Types.ObjectId, channelId: string): Promise<ChannelRecord | null> {
    const channelObjectId = toObjectId(channelId);
    if (!channelObjectId) return null;
    return this.findByObjectId(organizationId, channelObjectId);
  }

  async findByObjectId(
    organizationId: Types.ObjectId,
    channelId: Types.ObjectId,
  ): Promise<ChannelRecord | null> {
    return NotificationChannelModel.findOne({ _id: channelId, organizationId })
      .lean<ChannelRecord>()
      .exec();
  }

  async create(input: {
    readonly organizationId: Types.ObjectId;
    readonly name: string;
    readonly type: ChannelType;
    readonly enabled: boolean;
    readonly events: readonly ChannelEvent[];
    readonly urlCiphertext: string;
    readonly targetPreview: string;
    readonly secretCiphertext: string | null;
    readonly metadata: Readonly<Record<string, string>>;
    readonly createdByUserId: Types.ObjectId;
  }): Promise<ChannelRecord> {
    const created = await NotificationChannelModel.create({
      ...input,
      events: [...input.events],
      metadata: { ...input.metadata },
    });
    return created.toObject<ChannelRecord>();
  }

  async update(
    organizationId: Types.ObjectId,
    channelId: Types.ObjectId,
    changes: ChannelChanges,
  ): Promise<ChannelRecord | null> {
    return NotificationChannelModel.findOneAndUpdate(
      { _id: channelId, organizationId },
      { $set: changes },
      { returnDocument: 'after', runValidators: true },
    )
      .lean<ChannelRecord>()
      .exec();
  }

  /**
   * Deletes a channel and everything queued for it.
   *
   * The deliveries go too: a pending one would otherwise be claimed, find no
   * channel and be recorded as failed, which is noise, and the settled ones are
   * unreachable once the channel they are listed under is gone.
   */
  async delete(
    organizationId: Types.ObjectId,
    channelId: Types.ObjectId,
  ): Promise<ChannelRecord | null> {
    const deleted = await NotificationChannelModel.findOneAndDelete({
      _id: channelId,
      organizationId,
    })
      .lean<ChannelRecord>()
      .exec();
    if (deleted) {
      await ChannelDeliveryModel.deleteMany({ organizationId, channelId }).exec();
    }
    return deleted;
  }

  async countForOrganization(organizationId: Types.ObjectId): Promise<number> {
    return NotificationChannelModel.countDocuments({ organizationId }).exec();
  }

  /** The enabled channels of one organization that want to hear about `event`. */
  async findSubscribed(
    organizationId: Types.ObjectId,
    event: ChannelEvent,
  ): Promise<readonly Pick<ChannelRecord, '_id' | 'type'>[]> {
    return NotificationChannelModel.find({ organizationId, enabled: true, events: event })
      .select({ _id: 1, type: 1 })
      .lean<Pick<ChannelRecord, '_id' | 'type'>[]>()
      .exec();
  }

  /**
   * Records how a delivery settled, on the channel it went to.
   *
   * Only settled outcomes are recorded — a delivery that will be retried is
   * not yet a failure — so `consecutiveFailures` counts messages that never
   * arrived, which is the number somebody deciding whether to fix a channel
   * actually wants.
   */
  async recordOutcome(
    channelId: Types.ObjectId,
    outcome: {
      readonly delivered: boolean;
      readonly at: Date;
      readonly failureReason: string | null;
    },
  ): Promise<void> {
    if (outcome.delivered) {
      await NotificationChannelModel.updateOne(
        { _id: channelId },
        {
          $set: {
            lastDeliveryAt: outcome.at,
            lastDeliveryStatus: 'delivered',
            lastFailureReason: null,
            consecutiveFailures: 0,
          },
        },
      ).exec();
      return;
    }

    await NotificationChannelModel.updateOne(
      { _id: channelId },
      {
        $set: {
          lastDeliveryAt: outcome.at,
          lastDeliveryStatus: 'failed',
          lastFailureReason: outcome.failureReason?.slice(0, 500) ?? null,
        },
        $inc: { consecutiveFailures: 1 },
      },
    ).exec();
  }

  /**
   * Queues one event for one channel, or reports that it is already queued.
   *
   * Returns false on a duplicate rather than throwing: the unique index on
   * `dedupeKey` is the guarantee, and hitting it means a replayed job already
   * queued this exact message. That is the expected outcome, not a fault.
   */
  async enqueueDelivery(input: {
    readonly organizationId: Types.ObjectId;
    readonly channelId: Types.ObjectId;
    readonly event: ChannelEvent;
    readonly dedupeKey: string;
    readonly payload: ChannelEventPayload;
  }): Promise<boolean> {
    try {
      await ChannelDeliveryModel.create({
        ...input,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: new Date(),
      });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  /** One page of a channel's delivery log, newest first, plus one row to decide `hasNextPage`. */
  async listDeliveries(filter: ListDeliveriesFilter): Promise<readonly ChannelDeliveryRecord[]> {
    const query: Record<string, unknown> = {
      organizationId: filter.organizationId,
      channelId: filter.channelId,
    };
    if (filter.status) query.status = filter.status;
    if (filter.cursor) Object.assign(query, cursorFilter('createdAt', filter.cursor));

    return ChannelDeliveryModel.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(filter.pageSize + 1)
      .select({ payload: 0 })
      .lean<ChannelDeliveryRecord[]>()
      .exec();
  }
}
