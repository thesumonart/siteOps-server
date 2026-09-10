import { randomUUID } from 'node:crypto';

import { env } from '../config/env.js';
import {
  CHANNEL_TEST_EVENT,
  FEATURE_FOR_CHANNEL_TYPE,
  validateChannelUrl,
  type ChannelDeliveryDto,
  type ChannelEventPayload,
  type ChannelSigningSecretDto,
  type ChannelTestResultDto,
  type CreateChannelInput,
  type CreatedNotificationChannelDto,
  type CursorPaginatedResult,
  type ListChannelDeliveriesQuery,
  type NotificationChannelDto,
  type UpdateChannelInput,
} from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import {
  deliverToChannel,
  openChannel,
  previewChannelTarget,
} from '../integrations/channel-delivery.js';
import { generateSigningSecret } from '../integrations/webhook-signature.js';
import type {
  ChannelChanges,
  ChannelDeliveryRecord,
  ChannelRecord,
  ChannelRepository,
} from '../repositories/channel.repository.js';
import { isDuplicateKeyError } from '../repositories/notification.repository.js';
import type { OrganizationActor, OrganizationContext } from '../types/common.types.js';
import { toObjectId } from '../utils/object-id.js';
import { decodeOptionalCursor, encodeCursor } from '../utils/pagination.js';
import { sealSecret } from '../utils/secret-box.js';
import type { AuditService } from './audit.service.js';
import type { EntitlementService } from './entitlement.service.js';

/**
 * Managing an organization's Slack, Discord and webhook channels.
 *
 * Three rules hold throughout, and each is here because the alternative is a
 * specific failure:
 *
 *  - **A destination URL goes in and never comes out.** It is sealed on write
 *    and every response carries `targetPreview` instead. A Slack webhook URL
 *    is a credential for posting into somebody's workspace; an endpoint that
 *    echoed it would make every admin session a way to leak it.
 *  - **A signing secret is shown once.** On creation and on rotation, and not
 *    otherwise — the same bargain every webhook sender offers, because a
 *    secret that can be re-read by anyone with the settings page open is a
 *    secret shared with all of them.
 *  - **The plan gates use, not existence.** Creating, enabling, re-pointing or
 *    testing a channel needs the feature; reading, renaming, disabling and
 *    deleting one never does. An organization that downgrades must still be
 *    able to see what it had and clean it up.
 */
export class ChannelService {
  constructor(
    private readonly repository: ChannelRepository,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
  ) {}

  async list(organization: OrganizationContext): Promise<readonly NotificationChannelDto[]> {
    const channels = await this.repository.list(organization.objectId);
    return channels.map(toChannelDto);
  }

  async findById(
    organization: OrganizationContext,
    channelId: string,
  ): Promise<NotificationChannelDto> {
    return toChannelDto(await this.requireChannel(organization, channelId));
  }

  async create(
    organization: OrganizationContext,
    input: CreateChannelInput,
    actor: OrganizationActor,
  ): Promise<CreatedNotificationChannelDto> {
    this.entitlements.assertFeature(organization, FEATURE_FOR_CHANNEL_TYPE[input.type]);
    await this.entitlements.assertWithinLimit(organization, 'maxIntegrations');

    const actorObjectId = toObjectId(actor.id);
    if (!actorObjectId) throw ApiError.unauthenticated();

    // Slack and Discord authenticate the sender by the URL alone; there is
    // nothing for them to verify a signature against, so only webhooks get one.
    const signingSecret = input.type === 'webhook' ? generateSigningSecret() : null;

    try {
      const channel = await this.repository.create({
        organizationId: organization.objectId,
        name: input.name,
        type: input.type,
        enabled: input.enabled,
        events: input.events,
        urlCiphertext: sealSecret(input.url, organization.id),
        targetPreview: previewChannelTarget(input.url),
        secretCiphertext:
          signingSecret === null ? null : sealSecret(signingSecret, organization.id),
        metadata: input.type === 'webhook' ? input.metadata : {},
        createdByUserId: actorObjectId,
      });

      await this.audit.record({
        organizationId: organization.objectId,
        action: 'integration.created',
        actorUserId: actorObjectId,
        actorName: actor.name,
        targetType: 'integration',
        targetId: channel._id,
        targetLabel: channel.name,
      });

      return { channel: toChannelDto(channel), signingSecret };
    } catch (error) {
      if (isDuplicateKeyError(error)) throw nameTaken();
      throw error;
    }
  }

  async update(
    organization: OrganizationContext,
    channelId: string,
    input: UpdateChannelInput,
    actor: OrganizationActor,
  ): Promise<NotificationChannelDto> {
    const existing = await this.requireChannel(organization, channelId);

    const changes: ChannelChanges = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.events !== undefined) changes.events = input.events;
    if (input.enabled !== undefined) changes.enabled = input.enabled;

    if (input.url !== undefined) {
      // The type is fixed, so the new URL is judged by the rule for the type
      // this channel already is — the same function the edit form runs.
      const validated = validateChannelUrl(existing.type, input.url);
      if (!validated.ok) {
        throw ApiError.validation('Some fields need attention.', [
          { field: 'url', message: validated.message },
        ]);
      }
      changes.urlCiphertext = sealSecret(validated.href, organization.id);
      changes.targetPreview = previewChannelTarget(validated.href);
    }

    if (input.metadata !== undefined) {
      if (existing.type !== 'webhook') {
        throw ApiError.validation('Some fields need attention.', [
          { field: 'metadata', message: 'Only webhook channels carry metadata.' },
        ]);
      }
      changes.metadata = input.metadata;
    }

    if (changes.enabled === true || changes.urlCiphertext !== undefined) {
      this.entitlements.assertFeature(organization, FEATURE_FOR_CHANNEL_TYPE[existing.type]);
    }

    // An empty patch writes nothing and records nothing.
    if (Object.keys(changes).length === 0) return toChannelDto(existing);

    try {
      const updated = await this.repository.update(organization.objectId, existing._id, changes);
      if (!updated) throw notFound();

      await this.audit.record({
        organizationId: organization.objectId,
        action: 'integration.updated',
        actorUserId: toObjectId(actor.id),
        actorName: actor.name,
        targetType: 'integration',
        targetId: updated._id,
        targetLabel: updated.name,
      });

      return toChannelDto(updated);
    } catch (error) {
      if (isDuplicateKeyError(error)) throw nameTaken();
      throw error;
    }
  }

  async delete(
    organization: OrganizationContext,
    channelId: string,
    actor: OrganizationActor,
  ): Promise<void> {
    const existing = await this.requireChannel(organization, channelId);

    const deleted = await this.repository.delete(organization.objectId, existing._id);
    if (!deleted) throw notFound();

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'integration.deleted',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'integration',
      targetId: deleted._id,
      targetLabel: deleted.name,
    });
  }

  /**
   * Replaces a webhook's signing secret, effective immediately.
   *
   * There is no overlap window where both secrets are valid: SiteOps signs each
   * request with exactly one, and a receiver updating its copy after a rotation
   * refuses the requests in between — which is the safe direction to fail in
   * when the reason for rotating is that the old one leaked.
   */
  async rotateSecret(
    organization: OrganizationContext,
    channelId: string,
    actor: OrganizationActor,
  ): Promise<ChannelSigningSecretDto> {
    const existing = await this.requireChannel(organization, channelId);
    if (existing.type !== 'webhook') {
      throw ApiError.badRequest('VALIDATION_ERROR', 'Only webhook channels are signed.');
    }

    const signingSecret = generateSigningSecret();
    const updated = await this.repository.update(organization.objectId, existing._id, {
      secretCiphertext: sealSecret(signingSecret, organization.id),
    });
    if (!updated) throw notFound();

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'integration.updated',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'integration',
      targetId: updated._id,
      targetLabel: updated.name,
    });

    return { signingSecret };
  }

  /**
   * Sends a test message now and reports how it went.
   *
   * Synchronous, and deliberately outside the delivery queue: somebody pasting
   * a Slack URL wants to know within seconds whether it works, not to find a
   * row in a log later. It still goes through the whole real path — formatter,
   * signature, SSRF guard — so a passing test means a real alert will arrive.
   * It works on a disabled channel too, which is exactly when a test is useful.
   */
  async test(organization: OrganizationContext, channelId: string): Promise<ChannelTestResultDto> {
    const existing = await this.requireChannel(organization, channelId);
    this.entitlements.assertFeature(organization, FEATURE_FOR_CHANNEL_TYPE[existing.type]);

    const deliverable = openChannel(existing);
    if (!deliverable) {
      return {
        delivered: false,
        statusCode: null,
        durationMs: 0,
        failureReason: "The channel's stored URL could not be read. Enter it again.",
      };
    }

    const payload: ChannelEventPayload = {
      id: `${CHANNEL_TEST_EVENT}:${randomUUID()}`,
      type: CHANNEL_TEST_EVENT,
      createdAt: new Date().toISOString(),
      organizationId: organization.id,
      data: {
        website: null,
        incident: null,
        monitor: null,
        anomaly: null,
        dashboardUrl: `${env.APP_URL}/dashboard`,
      },
    };

    const outcome = await deliverToChannel(deliverable, payload, {
      deliveryId: randomUUID(),
      timeoutMs: env.CHANNEL_DELIVERY_TIMEOUT_MS,
      allowLoopback: env.MONITOR_ALLOW_PRIVATE_ADDRESSES,
    });

    return {
      delivered: outcome.delivered,
      statusCode: outcome.statusCode,
      durationMs: outcome.durationMs,
      failureReason: outcome.failureReason,
    };
  }

  /** One page of what the channel was sent and what became of it, newest first. */
  async deliveries(
    organization: OrganizationContext,
    channelId: string,
    query: ListChannelDeliveriesQuery,
  ): Promise<CursorPaginatedResult<ChannelDeliveryDto>> {
    const channel = await this.requireChannel(organization, channelId);

    const rows = await this.repository.listDeliveries({
      organizationId: organization.objectId,
      channelId: channel._id,
      pageSize: query.pageSize,
      status: query.status,
      cursor: decodeOptionalCursor(query.cursor),
    });

    const hasNextPage = rows.length > query.pageSize;
    const items = hasNextPage ? rows.slice(0, query.pageSize) : rows;
    const last = items.at(-1);

    return {
      items: items.map(toDeliveryDto),
      pagination: {
        nextCursor: hasNextPage && last ? encodeCursor(last.createdAt, last._id) : null,
        hasNextPage,
        pageSize: query.pageSize,
      },
    };
  }

  private async requireChannel(
    organization: OrganizationContext,
    channelId: string,
  ): Promise<ChannelRecord> {
    const channel = await this.repository.findById(organization.objectId, channelId);
    if (!channel) throw notFound();
    return channel;
  }
}

function notFound(): ApiError {
  return ApiError.notFound('CHANNEL_NOT_FOUND', 'Channel not found.');
}

function nameTaken(): ApiError {
  return ApiError.conflict('CHANNEL_NAME_TAKEN', 'A channel with that name already exists.');
}

export function toChannelDto(channel: ChannelRecord): NotificationChannelDto {
  return {
    id: channel._id.toHexString(),
    name: channel.name,
    type: channel.type,
    enabled: channel.enabled,
    events: channel.events,
    target: channel.targetPreview,
    metadata: channel.metadata,
    hasSigningSecret: channel.secretCiphertext !== null,
    lastDeliveryAt: channel.lastDeliveryAt?.toISOString() ?? null,
    lastDeliveryStatus: channel.lastDeliveryStatus,
    lastFailureReason: channel.lastFailureReason,
    consecutiveFailures: channel.consecutiveFailures,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}

export function toDeliveryDto(delivery: ChannelDeliveryRecord): ChannelDeliveryDto {
  return {
    id: delivery._id.toHexString(),
    event: delivery.event,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    responseStatus: delivery.responseStatus,
    failureReason: delivery.failureReason,
    createdAt: delivery.createdAt.toISOString(),
    lastAttemptAt: delivery.lastAttemptAt?.toISOString() ?? null,
    nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
  };
}
