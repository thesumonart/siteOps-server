import type { Types } from 'mongoose';

import { env } from '../config/env.js';
import {
  FEATURE_FOR_CHANNEL_TYPE,
  categoryForIncidentType,
  planHasFeature,
  type ChannelEvent,
  type ChannelEventPayload,
  type CheckErrorType,
  type IncidentCategory,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentType,
  type Plan,
  type WebhookIncident,
  type WebhookMonitor,
  type WebhookWebsite,
} from '../contracts/index.js';
import { IncidentModel, OrganizationModel } from '../models/index.js';
import type { ClaimedMonitor } from '../queues/monitor.queue.js';
import type { ChannelRepository } from '../repositories/channel.repository.js';
import { createLogger } from '../utils/logger.js';
import type { MonitorRunResult } from './monitor-runner.js';
import type { NotifiableWebsite } from './notification-processor.js';

const logger = createLogger('channel-dispatch');

/**
 * Queues an incident transition for every Slack, Discord and webhook channel
 * that wants to hear about it.
 *
 * Queuing, not sending. The monitoring job calls this while it holds a lease
 * sized for one check, and a receiver that takes ten seconds to answer — or
 * never does — must not be able to hold it. So this writes one delivery per
 * channel and returns; the delivery loop sends them, retries them with backoff
 * and records what happened.
 *
 * Idempotency is the database's, as it is for email. Each delivery carries
 * `<incidentId>:<event>:<channelId>` under a unique index, so a job that runs
 * twice for one transition queues nothing the second time, and there is no
 * claim flag on the incident to keep in step with it.
 *
 * Independent of email by construction: an organization with no verified
 * member still has its Slack told about an outage.
 */
export class ChannelEventPublisher {
  constructor(
    private readonly channels: ChannelRepository,
    /** Called when something was queued, so an in-process loop can send it now. */
    private readonly onEnqueued: () => void = () => undefined,
  ) {}

  websiteDown(website: NotifiableWebsite, incidentId: Types.ObjectId): Promise<number> {
    return this.publish('website.down', website.organizationId, incidentId, {
      website: websiteOf(website.id, website.name, website.url),
      monitor: null,
    });
  }

  websiteRecovered(website: NotifiableWebsite, incidentId: Types.ObjectId): Promise<number> {
    return this.publish('website.recovered', website.organizationId, incidentId, {
      website: websiteOf(website.id, website.name, website.url),
      monitor: null,
    });
  }

  monitorProblem(
    monitor: ClaimedMonitor,
    result: MonitorRunResult,
    incidentId: Types.ObjectId,
  ): Promise<number> {
    return this.publish('monitor.problem', monitor.organizationId, incidentId, {
      website: websiteOf(monitor.websiteId, monitor.websiteName, monitor.websiteUrl),
      monitor: { type: monitor.type, status: result.status, summary: result.summary },
    });
  }

  monitorRecovered(
    monitor: ClaimedMonitor,
    result: MonitorRunResult,
    incidentId: Types.ObjectId,
  ): Promise<number> {
    return this.publish('monitor.recovered', monitor.organizationId, incidentId, {
      website: websiteOf(monitor.websiteId, monitor.websiteName, monitor.websiteUrl),
      monitor: { type: monitor.type, status: result.status, summary: result.summary },
    });
  }

  /** Returns how many deliveries were newly queued. */
  private async publish(
    event: ChannelEvent,
    organizationId: Types.ObjectId,
    incidentId: Types.ObjectId,
    subject: { readonly website: WebhookWebsite; readonly monitor: WebhookMonitor | null },
  ): Promise<number> {
    const channels = await this.subscribedChannels(organizationId, event);
    if (channels.length === 0) return 0;

    // The incident document, not a hand-built context, is the source of truth:
    // it was written in the same pass that decided this transition happened.
    const incident = await loadIncident(incidentId);
    if (!incident) return 0;

    const payload: ChannelEventPayload = {
      id: `${event}:${incidentId.toHexString()}`,
      type: event,
      createdAt: new Date().toISOString(),
      organizationId: organizationId.toHexString(),
      data: {
        website: subject.website,
        incident,
        monitor: subject.monitor,
        dashboardUrl: `${env.APP_URL}/dashboard/websites/${subject.website.id}`,
      },
    };

    let enqueued = 0;
    for (const channel of channels) {
      const queued = await this.channels.enqueueDelivery({
        organizationId,
        channelId: channel._id,
        event,
        dedupeKey: `${incidentId.toHexString()}:${event}:${channel._id.toHexString()}`,
        payload,
      });
      if (queued) enqueued += 1;
    }

    if (enqueued > 0) {
      logger.info(
        { organizationId: organizationId.toHexString(), event, channels: enqueued },
        'channel.deliveries_enqueued',
      );
      this.onEnqueued();
    }

    return enqueued;
  }

  /**
   * The channels to queue for, filtered by what the plan still includes.
   *
   * A downgrade keeps an organization's channels — it may upgrade again, and
   * reconnecting Slack is tedious — but stops sending to the ones the plan no
   * longer covers. The plan is read here, per event, rather than trusted from
   * whenever the channel was created.
   */
  private async subscribedChannels(
    organizationId: Types.ObjectId,
    event: ChannelEvent,
  ): Promise<readonly { readonly _id: Types.ObjectId }[]> {
    const channels = await this.channels.findSubscribed(organizationId, event);
    if (channels.length === 0) return [];

    const organization = await OrganizationModel.findById(organizationId)
      .select({ plan: 1 })
      .lean<{ plan: Plan }>()
      .exec();
    if (!organization) return [];

    return channels.filter((channel) =>
      planHasFeature(organization.plan, FEATURE_FOR_CHANNEL_TYPE[channel.type]),
    );
  }
}

function websiteOf(id: Types.ObjectId, name: string, url: string): WebhookWebsite {
  return { id: id.toHexString(), name, url };
}

interface IncidentRow {
  readonly _id: Types.ObjectId;
  readonly status: IncidentStatus;
  readonly type: IncidentType;
  readonly category?: IncidentCategory;
  readonly severity?: IncidentSeverity;
  readonly detail?: string | null;
  readonly startedAt: Date;
  readonly resolvedAt: Date | null;
  readonly durationSeconds: number | null;
  readonly failedCheckCount: number;
  readonly lastStatusCode: number | null;
  readonly lastErrorType: CheckErrorType | null;
  readonly lastErrorMessage: string | null;
}

async function loadIncident(incidentId: Types.ObjectId): Promise<WebhookIncident | null> {
  const row = await IncidentModel.findById(incidentId)
    .select({
      status: 1,
      type: 1,
      category: 1,
      severity: 1,
      detail: 1,
      startedAt: 1,
      resolvedAt: 1,
      durationSeconds: 1,
      failedCheckCount: 1,
      lastStatusCode: 1,
      lastErrorType: 1,
      lastErrorMessage: 1,
    })
    .lean<IncidentRow>()
    .exec();
  if (!row) return null;

  return {
    id: row._id.toHexString(),
    status: row.status,
    type: row.type,
    // Older documents predate the category field; see `toIncidentDto`.
    category: row.category ?? categoryForIncidentType(row.type),
    severity: row.severity ?? 'critical',
    detail: row.detail ?? null,
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    durationSeconds: row.durationSeconds,
    failedCheckCount: row.failedCheckCount,
    lastStatusCode: row.lastStatusCode,
    lastErrorType: row.lastErrorType,
    lastErrorMessage: row.lastErrorMessage,
  };
}
