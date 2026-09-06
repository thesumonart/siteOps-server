import type { MonitorType } from '../contracts/index.js';
import { MonitorResultModel, WebsiteMonitorModel } from '../models/index.js';
import { applyMonitorIncident } from '../monitoring/monitor-incident.js';
import type { MonitorRunner } from '../monitoring/monitor-runner.js';
import { releaseMonitor, type ClaimedMonitor } from '../queues/monitor.queue.js';
import { createLogger } from '../utils/logger.js';
import type { MonitorNotifier } from './monitor-notifier.js';

const logger = createLogger('monitor-job');

/**
 * Bound on how many findings are stored with one result.
 *
 * A crawl of a broken site can find thousands. The whole list is neither
 * readable nor useful, and storing it unbounded turns an append-only collection
 * into an unbounded one — the exact failure mode the TTL index exists to
 * prevent. Runners cap their own lists; this is the backstop.
 */
const MAX_STORED_FINDINGS = 100;

/**
 * How many consecutive failed runs before the monitor's own status reflects it.
 *
 * A single unreachable registry or a one-off timeout should not turn a healthy
 * monitor red — it says nothing about the thing being monitored. Three in a row
 * is a monitor that is genuinely not working, which is worth surfacing.
 */
const ERROR_STATUS_THRESHOLD = 3;

export interface MonitorJobOptions {
  readonly allowLoopback: boolean;
  readonly userAgent: string;
  /** Wall-clock budget for one run, per monitor type. */
  readonly timeoutMs: number;
}

export interface MonitorJobDependencies {
  readonly runners: ReadonlyMap<MonitorType, MonitorRunner>;
  readonly notifier: MonitorNotifier;
}

/**
 * The full pipeline for one claimed monitor: run it, record the result, apply
 * the incident rules, notify, then always release the lease.
 *
 * The `finally` block is the reliability guarantee, exactly as in the uptime
 * job: every exception path above still leaves the monitor rescheduled
 * promptly, rather than waiting out its lease.
 */
export async function runMonitorJob(
  monitor: ClaimedMonitor,
  options: MonitorJobOptions,
  dependencies: MonitorJobDependencies,
): Promise<void> {
  const startedAt = Date.now();

  try {
    const runner = dependencies.runners.get(monitor.type);
    if (!runner) {
      // A monitor type with no runner is a wiring bug. Log it and move on
      // rather than throwing, so the rest of the batch is unaffected.
      logger.error({ monitorType: monitor.type }, 'monitor.no_runner');
      return;
    }

    /*
     * A paused website pauses everything about it. Someone who silences alerts
     * for a site being rebuilt does not expect a certificate warning from it
     * the next morning, and the result is not recorded either — a gap in the
     * history is honest about the fact that nothing was measured.
     */
    if (monitor.websitePaused) {
      logger.debug(
        { monitorId: monitor.id.toHexString(), monitorType: monitor.type },
        'monitor.skipped_website_paused',
      );
      return;
    }

    const checkedAt = new Date();
    const result = await runner.run({
      monitor,
      allowLoopback: options.allowLoopback,
      userAgent: options.userAgent,
      timeoutMs: options.timeoutMs,
      now: checkedAt,
    });

    const durationMs = Date.now() - startedAt;

    await MonitorResultModel.create({
      organizationId: monitor.organizationId,
      websiteId: monitor.websiteId,
      monitorId: monitor.id,
      type: monitor.type,
      status: result.status,
      checkedAt,
      durationMs,
      summary: result.summary,
      data: result.data,
      findings: result.findings.slice(0, MAX_STORED_FINDINGS),
      errorMessage: result.errorMessage ?? null,
    });

    const incident = await applyMonitorIncident(monitor.currentIncidentId, {
      organizationId: monitor.organizationId,
      websiteId: monitor.websiteId,
      monitorType: monitor.type,
      status: result.status,
      detail: result.incidentDetail ?? result.summary,
      checkedAt,
    });

    /*
     * An errored run leaves the monitor's displayed status alone until it has
     * failed several times in a row. Flipping a green certificate check to red
     * because one DNS lookup timed out teaches people to ignore the colour.
     */
    const consecutiveErrors = result.status === 'error' ? monitor.consecutiveErrors + 1 : 0;
    const displayStatus =
      result.status === 'error' && consecutiveErrors < ERROR_STATUS_THRESHOLD
        ? undefined
        : result.status;

    await WebsiteMonitorModel.updateOne(
      { _id: monitor.id },
      {
        $set: {
          lastRunAt: checkedAt,
          lastSummary: result.summary,
          consecutiveErrors,
          currentIncidentId: incident.openIncidentId,
          ...(displayStatus ? { status: displayStatus } : {}),
        },
      },
    ).exec();
    // Deliberately not touched here: `leaseExpiresAt` and `nextRunAt` belong to
    // the scheduler, and the `finally` below sets them even when this throws.

    // A failed alert must never roll back the incident that triggered it: both
    // are already durably written by the time this runs.
    if (incident.newlyOpenedIncidentId) {
      await dependencies.notifier
        .monitorProblem(monitor, result, incident.newlyOpenedIncidentId)
        .catch((error: unknown) => {
          logger.error(
            { err: error, monitorId: monitor.id.toHexString() },
            'monitor.problem_dispatch_failed',
          );
        });
    } else if (incident.newlyResolvedIncidentId) {
      await dependencies.notifier
        .monitorRecovered(monitor, result, incident.newlyResolvedIncidentId)
        .catch((error: unknown) => {
          logger.error(
            { err: error, monitorId: monitor.id.toHexString() },
            'monitor.recovery_dispatch_failed',
          );
        });
    }

    logger.info(
      {
        monitorId: monitor.id.toHexString(),
        websiteId: monitor.websiteId.toHexString(),
        monitorType: monitor.type,
        status: result.status,
        durationMs,
      },
      'monitor.run_completed',
    );
  } catch (error) {
    logger.error(
      { err: error, monitorId: monitor.id.toHexString(), monitorType: monitor.type },
      'monitor.run_failed',
    );
  } finally {
    await releaseMonitor(monitor.id, monitor.intervalSeconds).catch((error: unknown) => {
      // Nothing further can be done; the lease's own expiry is the backstop.
      logger.error({ err: error, monitorId: monitor.id.toHexString() }, 'monitor.release_failed');
    });
  }
}
