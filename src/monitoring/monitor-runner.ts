import type {
  MonitorCheckData,
  MonitorFinding,
  MonitorStatus,
  MonitorType,
} from '../contracts/index.js';
import type { ClaimedMonitor } from '../queues/monitor.queue.js';

/**
 * What every auxiliary monitor implements.
 *
 * One interface for six very different checks — a TLS handshake, a WHOIS query,
 * a Lighthouse run, a site crawl — so the scheduler, the result writer, the
 * incident rules and the notification path are written once and none of them
 * knows what any monitor actually does.
 *
 * A runner returns a verdict. It does not write to the database, raise
 * incidents or send anything; those are the pipeline's job, and keeping them
 * out means every runner is testable by calling it and reading the result.
 */

export interface MonitorRunContext {
  readonly monitor: ClaimedMonitor;
  /** Test-only: see AddressGuardOptions. Refused in production at startup. */
  readonly allowLoopback: boolean;
  readonly userAgent: string;
  /** Wall-clock budget for the whole run, including any network it does. */
  readonly timeoutMs: number;
  /** Injected so a test can pin "now" without touching the system clock. */
  readonly now: Date;
}

/**
 * The verdict of one run.
 *
 * `status: 'error'` means the monitor could not reach an answer. Everything
 * else means it did, and `data` describes what it found. The distinction is
 * load-bearing: an unreachable registry must not resolve an open
 * domain-expiring incident, because nothing was learned.
 */
export interface MonitorRunResult {
  readonly status: MonitorStatus;
  /** One line for the UI and for the notification subject. */
  readonly summary: string;
  readonly data: MonitorCheckData;
  readonly findings: readonly MonitorFinding[];
  /** Set only when `status` is `error`. */
  readonly errorMessage?: string;
  /**
   * Overrides the incident detail line. Defaults to `summary`, which is
   * usually right; a monitor sets this when the alert needs different wording
   * from the dashboard row.
   */
  readonly incidentDetail?: string;
}

export interface MonitorRunner {
  readonly type: MonitorType;
  run(context: MonitorRunContext): Promise<MonitorRunResult>;
}

/**
 * A run that could not produce an answer.
 *
 * Every runner reaches for this rather than throwing, so the reason survives
 * into the result document and the operator can see *why* a monitor has been
 * silent, instead of finding a stack trace in a log.
 */
export function monitorError(reason: string, data: MonitorCheckData): MonitorRunResult {
  return {
    status: 'error',
    summary: reason,
    data,
    findings: [],
    errorMessage: reason,
  };
}

/**
 * Escalates a status only upwards.
 *
 * Findings are collected independently and each implies a status; the run's
 * overall status is the worst of them. Written as an explicit ranking rather
 * than as a chain of comparisons because getting it backwards would report a
 * failing check as passing, which is the one direction that must never happen.
 */
const STATUS_RANK: Record<MonitorStatus, number> = {
  unknown: 0,
  passing: 1,
  warning: 2,
  error: 3,
  failing: 4,
};

export function worstStatus(...statuses: readonly MonitorStatus[]): MonitorStatus {
  return statuses.reduce<MonitorStatus>(
    (worst, status) => (STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst),
    'passing',
  );
}
