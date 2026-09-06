import type { Types } from 'mongoose';

import type { MonitorConfig, MonitorType } from '../contracts/index.js';
import { WebsiteMonitorModel, type WebsiteMonitorAttributes } from '../models/index.js';

/**
 * The auxiliary monitor work queue.
 *
 * Deliberately the same shape as `monitoring.queue.ts`: `nextRunAt` is the
 * ready time, `leaseExpiresAt` is the visibility timeout, and one atomic
 * `findOneAndUpdate` claims a document. Two scheduling mechanisms in one
 * product means two sets of duplicate-run bugs, so this is the same mechanism
 * pointed at a different collection.
 *
 * What differs is the granularity. The uptime queue claims a *website*; this
 * claims a `(website, type)` pair, and claims are made per type. A crawl can
 * take minutes while a TLS handshake takes milliseconds, so each type gets its
 * own concurrency budget and its own lease duration — a shared claim would let
 * one slow crawl monopolise the batch.
 *
 * The website's URL is joined in at claim time rather than denormalized onto
 * the monitor, so a renamed or re-pointed website is never checked at its old
 * address. That is one extra read per claimed monitor, at a rate measured in
 * runs per day.
 */

export interface ClaimedMonitor {
  readonly id: Types.ObjectId;
  readonly organizationId: Types.ObjectId;
  readonly websiteId: Types.ObjectId;
  readonly type: MonitorType;
  readonly intervalSeconds: number;
  readonly config: MonitorConfig;
  readonly currentIncidentId: Types.ObjectId | null;
  readonly consecutiveErrors: number;
  /** Joined from the website at claim time. */
  readonly websiteName: string;
  readonly websiteUrl: string;
  /** Whether the website's own uptime monitoring is paused. */
  readonly websitePaused: boolean;
}

export interface MonitorQueueOptions {
  readonly type: MonitorType;
  readonly batchSize: number;
  readonly leaseDurationMs: number;
}

interface ClaimedRow extends WebsiteMonitorAttributes {
  readonly _id: Types.ObjectId;
}

interface WebsiteRow {
  readonly name: string;
  readonly url: string;
  readonly monitoringEnabled: boolean;
}

/** Claims one due-and-unleased monitor of a type, or null if there is nothing to do. */
async function claimOne(options: MonitorQueueOptions): Promise<ClaimedRow | null> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + options.leaseDurationMs);

  return WebsiteMonitorModel.findOneAndUpdate(
    {
      type: options.type,
      enabled: true,
      nextRunAt: { $lte: now },
      $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
    },
    { $set: { leaseExpiresAt } },
    {
      returnDocument: 'after',
      // Oldest-due first, so one perpetually-overdue monitor cannot starve the
      // rest of the queue behind it.
      sort: { nextRunAt: 1 },
    },
  )
    .lean<ClaimedRow>()
    .exec();
}

/**
 * Claims up to `batchSize` due monitors of one type.
 *
 * Sequential claims, each atomic, so the batch shrinks naturally to whatever is
 * actually due and never blocks waiting for more work to appear.
 */
export async function claimMonitorBatch(
  options: MonitorQueueOptions,
): Promise<readonly ClaimedMonitor[]> {
  const rows: ClaimedRow[] = [];

  for (let index = 0; index < options.batchSize; index += 1) {
    const claimed = await claimOne(options);
    if (!claimed) break;
    rows.push(claimed);
  }

  if (rows.length === 0) return [];

  const { WebsiteModel } = await import('../models/index.js');
  const websites = await WebsiteModel.find({ _id: { $in: rows.map((row) => row.websiteId) } })
    .select({ name: 1, url: 1, monitoringEnabled: 1 })
    .lean<(WebsiteRow & { _id: Types.ObjectId })[]>()
    .exec();

  const byId = new Map(websites.map((website) => [website._id.toHexString(), website]));

  return rows.flatMap((row) => {
    const website = byId.get(row.websiteId.toHexString());
    /*
     * A monitor whose website is gone is an orphan — deletion removes both, so
     * this should not happen. Skipping it rather than throwing means the rest
     * of the batch still runs; the lease it holds expires on its own, and the
     * next claim finds it again and skips it again, which is harmless and
     * visible in the logs rather than silent.
     */
    if (!website) return [];

    return [
      {
        id: row._id,
        organizationId: row.organizationId,
        websiteId: row.websiteId,
        type: row.type,
        intervalSeconds: row.intervalSeconds,
        config: row.config,
        currentIncidentId: row.currentIncidentId,
        consecutiveErrors: row.consecutiveErrors,
        websiteName: website.name,
        websiteUrl: website.url,
        websitePaused: !website.monitoringEnabled,
      } satisfies ClaimedMonitor,
    ];
  });
}

/** Releases a lease and schedules the next run, whether or not this one succeeded. */
export async function releaseMonitor(
  monitorId: Types.ObjectId,
  intervalSeconds: number,
): Promise<void> {
  await WebsiteMonitorModel.updateOne(
    { _id: monitorId },
    {
      $set: {
        leaseExpiresAt: null,
        nextRunAt: new Date(Date.now() + intervalSeconds * 1000),
      },
    },
  ).exec();
}
