import { WebsiteCheckModel, WebsiteModel, WorkerHeartbeatModel } from '../models/index.js';

/**
 * Whether monitoring is actually running, and how far behind it is.
 *
 * The question this service exists to answer could not be answered at all
 * before it: the API was healthy, the database was reachable, every probe was
 * green, and no website had been checked for eighteen hours. Liveness of the
 * API says nothing about liveness of the loops, and the dashboard was reporting
 * "100% uptime, operational" from data that had stopped moving.
 *
 * Every number here is derived from data the monitoring path itself writes.
 * Nothing is self-reported by the process answering the request, because the
 * process answering the request is frequently not the one doing the work.
 */

/**
 * How stale the newest heartbeat may be before monitoring is called degraded.
 *
 * Three heartbeat intervals. One missed write is a slow database or a restart;
 * three in a row is something an operator should look at. Sized in absolute
 * time rather than in intervals so the threshold does not silently change when
 * the interval is tuned.
 */
const DEGRADED_AFTER_MS = 2 * 60 * 1000;

/**
 * How stale it may be before monitoring is called stopped.
 *
 * Ten minutes is far longer than any legitimate gap — a graceful restart takes
 * seconds — and short enough that a dead worker is caught within one dashboard
 * visit rather than the next morning.
 */
const STOPPED_AFTER_MS = 10 * 60 * 1000;

/** Window for the failed-check count. A day, matching the dashboard's own. */
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How overdue the queue may be before it is called backed up.
 *
 * A website is due every interval and claimed within one poll, so a handful of
 * due websites at any instant is normal. One that has been due for more than
 * five minutes means nothing is claiming it.
 */
const BACKLOG_THRESHOLD_MS = 5 * 60 * 1000;

export type MonitoringRuntimeStatus = 'running' | 'degraded' | 'stopped' | 'never_started';

export interface MonitoringHealthReport {
  readonly status: MonitoringRuntimeStatus;
  /** Newest heartbeat from any instance, or null if none has ever been written. */
  readonly lastHeartbeatAt: string | null;
  readonly heartbeatAgeSeconds: number | null;
  /** Where the loops are running: the dedicated worker, or inside the API. */
  readonly host: 'api' | 'worker' | null;
  readonly instanceId: string | null;
  readonly startedAt: string | null;
  /** Completion of the most recent sweeps, as the runtime last reported them. */
  readonly lastUptimeTickAt: string | null;
  readonly lastMonitorTickAt: string | null;
  readonly lastReportTickAt: string | null;
  /** Instances that have written a heartbeat inside the stopped threshold. */
  readonly liveInstances: number;
  /** Websites whose next check is already due. */
  readonly pendingChecks: number;
  /** Of those, how many have been due long enough to mean nothing is claiming them. */
  readonly overdueChecks: number;
  /** The oldest due time in the queue; the honest measure of how far behind. */
  readonly oldestPendingCheckAt: string | null;
  /** Non-`up` checks recorded in the last day. */
  readonly failedChecksLast24h: number;
  readonly totalChecksLast24h: number;
  /** The most recent check of any website, which is what the dashboard shows. */
  readonly lastCheckRecordedAt: string | null;
}

interface HeartbeatRow {
  readonly instanceId: string;
  readonly host: 'api' | 'worker';
  readonly startedAt: Date;
  readonly lastHeartbeatAt: Date;
  readonly lastUptimeTickAt: Date | null;
  readonly lastMonitorTickAt: Date | null;
  readonly lastReportTickAt: Date | null;
}

export class MonitoringHealthService {
  async report(now: Date = new Date()): Promise<MonitoringHealthReport> {
    const stoppedBefore = new Date(now.getTime() - STOPPED_AFTER_MS);
    const backlogBefore = new Date(now.getTime() - BACKLOG_THRESHOLD_MS);
    const windowStart = new Date(now.getTime() - FAILURE_WINDOW_MS);

    /*
     * Issued together. Six sequential round trips would make the diagnostics
     * endpoint slower than the thing it is diagnosing, and none of them depend
     * on each other.
     */
    const [
      newest,
      liveInstances,
      pendingChecks,
      overdueChecks,
      oldestPending,
      checkCounts,
      lastCheck,
    ] = await Promise.all([
      WorkerHeartbeatModel.findOne({})
        .sort({ lastHeartbeatAt: -1 })
        .select({
          instanceId: 1,
          host: 1,
          startedAt: 1,
          lastHeartbeatAt: 1,
          lastUptimeTickAt: 1,
          lastMonitorTickAt: 1,
          lastReportTickAt: 1,
        })
        .lean<HeartbeatRow>()
        .exec(),

      WorkerHeartbeatModel.countDocuments({ lastHeartbeatAt: { $gt: stoppedBefore } }).exec(),

      WebsiteModel.countDocuments({
        monitoringEnabled: true,
        nextCheckAt: { $lte: now },
      }).exec(),

      WebsiteModel.countDocuments({
        monitoringEnabled: true,
        nextCheckAt: { $lte: backlogBefore },
      }).exec(),

      WebsiteModel.findOne({ monitoringEnabled: true, nextCheckAt: { $lte: now } })
        .sort({ nextCheckAt: 1 })
        .select({ nextCheckAt: 1 })
        .lean<{ nextCheckAt: Date }>()
        .exec(),

      WebsiteCheckModel.aggregate<{ _id: null; total: number; failed: number }>([
        { $match: { checkedAt: { $gte: windowStart } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'up'] }, 0, 1] } },
          },
        },
      ]).exec(),

      WebsiteCheckModel.findOne({})
        .sort({ checkedAt: -1 })
        .select({ checkedAt: 1 })
        .lean<{ checkedAt: Date }>()
        .exec(),
    ]);

    const heartbeatAgeMs = newest ? now.getTime() - newest.lastHeartbeatAt.getTime() : null;
    const counts = checkCounts[0] ?? { total: 0, failed: 0 };

    return {
      status: classify(heartbeatAgeMs),
      lastHeartbeatAt: newest?.lastHeartbeatAt.toISOString() ?? null,
      heartbeatAgeSeconds: heartbeatAgeMs === null ? null : Math.round(heartbeatAgeMs / 1000),
      host: newest?.host ?? null,
      instanceId: newest?.instanceId ?? null,
      startedAt: newest?.startedAt.toISOString() ?? null,
      lastUptimeTickAt: newest?.lastUptimeTickAt?.toISOString() ?? null,
      lastMonitorTickAt: newest?.lastMonitorTickAt?.toISOString() ?? null,
      lastReportTickAt: newest?.lastReportTickAt?.toISOString() ?? null,
      liveInstances,
      pendingChecks,
      overdueChecks,
      oldestPendingCheckAt: oldestPending?.nextCheckAt.toISOString() ?? null,
      failedChecksLast24h: counts.failed,
      totalChecksLast24h: counts.total,
      lastCheckRecordedAt: lastCheck?.checkedAt.toISOString() ?? null,
    };
  }
}

/**
 * Heartbeat age to a verdict.
 *
 * `never_started` is kept distinct from `stopped` because they need different
 * responses: one is a deployment that has not been configured to run
 * monitoring at all, the other is one that was and no longer is.
 */
export function classify(heartbeatAgeMs: number | null): MonitoringRuntimeStatus {
  if (heartbeatAgeMs === null) return 'never_started';
  if (heartbeatAgeMs > STOPPED_AFTER_MS) return 'stopped';
  if (heartbeatAgeMs > DEGRADED_AFTER_MS) return 'degraded';
  return 'running';
}
