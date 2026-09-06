import type {
  CursorPaginatedResult,
  ListMonitorResultsQuery,
  MonitorDto,
  MonitorResultDto,
  MonitorSummaryDto,
  MonitorType,
  UpdateMonitorInput,
} from '../contracts/index.js';
import {
  DEFAULT_MONITOR_INTERVAL_SECONDS,
  MONITOR_FEATURE,
  MONITOR_TYPES,
  defaultConfigFor,
} from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type {
  MonitorRecord,
  MonitorRepository,
  MonitorResultRecord,
} from '../repositories/monitor.repository.js';
import type { Actor } from '../types/auth.types.js';
import type { OrganizationContext } from '../types/common.types.js';
import { toObjectId } from '../utils/object-id.js';
import { decodeOptionalCursor, encodeCursor } from '../utils/pagination.js';
import type { AuditService } from './audit.service.js';
import type { EntitlementService } from './entitlement.service.js';
import type { WebsiteService } from './website.service.js';

/**
 * Configuring the auxiliary monitors, and reading what they found.
 *
 * Three rules are enforced here rather than at the route, because the worker
 * and any future API client have to obey them too:
 *
 *  1. A monitor may only be enabled if the plan includes it. The dashboard
 *     hides the toggle, but that is presentation — this is the enforcement.
 *  2. The interval may not be faster than the plan's floor. These monitors
 *     cost real money per run, and an hourly Lighthouse run on a Free account
 *     is a bill somebody else pays.
 *  3. A crawl may not exceed the plan's page cap. Clamped rather than refused:
 *     someone who asks for 500 pages on a plan that allows 50 wants a crawl,
 *     and refusing the whole request over a number they can adjust is worse
 *     service than running the crawl they are entitled to.
 */
export class MonitorConfigService {
  constructor(
    private readonly repository: MonitorRepository,
    private readonly websites: WebsiteService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every monitor for one website, including the ones never configured.
   *
   * A type with no document is returned as a disabled monitor with defaults, so
   * the settings panel renders all six rows without the client having to know
   * which ones exist. The row is only written when somebody changes it.
   */
  async listForWebsite(
    organization: OrganizationContext,
    websiteId: string,
  ): Promise<readonly MonitorDto[]> {
    const website = await this.websites.requireWebsite(organization, websiteId);

    const [stored, latest] = await Promise.all([
      this.repository.listForWebsite(organization.objectId, website._id),
      this.repository.latestResultsFor(website._id),
    ]);

    const byType = new Map(stored.map((monitor) => [monitor.type, monitor]));

    return MONITOR_TYPES.map((type) => {
      const monitor = byType.get(type);
      if (!monitor) return unconfiguredMonitor(website._id.toHexString(), type);

      const result = latest.get(monitor._id.toHexString());
      return toMonitorDto(monitor, result);
    });
  }

  /**
   * Turns a monitor on or off, or changes how it runs.
   *
   * Creating the row and changing it are the same operation: a monitor is
   * conceptually always present on a website, and whether a document exists for
   * it is an implementation detail of storing "off".
   */
  async update(
    organization: OrganizationContext,
    websiteId: string,
    type: MonitorType,
    input: UpdateMonitorInput,
    actor: Actor,
  ): Promise<MonitorDto> {
    const website = await this.websites.requireWebsite(organization, websiteId);

    // Checked whenever the monitor will end up enabled — including a config
    // change to one that is already on, so a plan downgrade cannot be worked
    // around by editing an existing monitor instead of creating one.
    if (input.enabled !== false) {
      const existing = await this.repository.findByType(organization.objectId, website._id, type);
      const willBeEnabled = input.enabled ?? existing?.enabled ?? false;
      if (willBeEnabled) this.entitlements.assertFeature(organization, MONITOR_FEATURE[type]);
    }

    if (input.config && input.config.type !== type) {
      throw ApiError.validation('The configuration does not match this monitor.', [
        { field: 'config.type', message: `Expected configuration for the ${type} monitor.` },
      ]);
    }

    const changes: {
      enabled?: boolean;
      intervalSeconds?: number;
      config?: NonNullable<UpdateMonitorInput['config']>;
    } = {};
    if (input.enabled !== undefined) changes.enabled = input.enabled;

    if (input.intervalSeconds !== undefined) {
      const floor = this.entitlements.limit(organization, 'minMonitorIntervalSeconds');
      if (input.intervalSeconds < floor) {
        throw ApiError.planLimit(
          `Your plan runs this check at most every ${String(Math.round(floor / 3600))} hours.`,
        );
      }
      changes.intervalSeconds = input.intervalSeconds;
    }

    if (input.config) changes.config = this.clampConfig(organization, input.config);

    const monitor = await this.repository.upsert({
      organizationId: organization.objectId,
      websiteId: website._id,
      type,
      defaultIntervalSeconds: DEFAULT_MONITOR_INTERVAL_SECONDS[type],
      defaultConfig: defaultConfigFor(type),
      changes,
    });

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'website.monitor_updated',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'website',
      targetId: website._id,
      targetLabel: `${website.name} · ${type}`,
    });

    const latest = await this.repository.latestResultsFor(website._id);
    return toMonitorDto(monitor, latest.get(monitor._id.toHexString()));
  }

  /**
   * Makes a monitor due immediately.
   *
   * The run itself still happens on the worker — nothing expensive is done
   * inside a request handler — so this returns as soon as the schedule is
   * moved, and the dashboard polls for the result.
   */
  async runNow(
    organization: OrganizationContext,
    websiteId: string,
    type: MonitorType,
  ): Promise<MonitorDto> {
    const website = await this.websites.requireWebsite(organization, websiteId);
    const monitor = await this.repository.findByType(organization.objectId, website._id, type);

    if (!monitor) {
      throw ApiError.notFound('MONITOR_NOT_FOUND', 'That monitor is not configured.');
    }
    if (!monitor.enabled) {
      throw ApiError.conflict('MONITOR_DISABLED', 'Turn this monitor on before running it.');
    }

    this.entitlements.assertFeature(organization, MONITOR_FEATURE[type]);

    const updated = await this.repository.scheduleNow(organization.objectId, monitor._id);
    if (!updated) {
      throw ApiError.notFound('MONITOR_NOT_FOUND', 'That monitor is not configured.');
    }

    const latest = await this.repository.latestResultsFor(website._id);
    return toMonitorDto(updated, latest.get(updated._id.toHexString()));
  }

  /** One monitor's result history, newest first. */
  async listResults(
    organization: OrganizationContext,
    monitorId: string,
    query: ListMonitorResultsQuery,
  ): Promise<CursorPaginatedResult<MonitorResultDto>> {
    const monitor = await this.repository.findById(organization.objectId, monitorId);
    if (!monitor) {
      throw ApiError.notFound('MONITOR_NOT_FOUND', 'That monitor is not configured.');
    }

    const rows = await this.repository.listResults({
      organizationId: organization.objectId,
      monitorId: monitor._id,
      pageSize: query.pageSize,
      status: query.status,
      cursor: decodeOptionalCursor(query.cursor),
    });

    const hasNextPage = rows.length > query.pageSize;
    const items = hasNextPage ? rows.slice(0, query.pageSize) : rows;
    const last = items.at(-1);

    return {
      items: items.map(toMonitorResultDto),
      pagination: {
        nextCursor: hasNextPage && last ? encodeCursor(last.checkedAt, last._id) : null,
        hasNextPage,
        pageSize: query.pageSize,
      },
    };
  }

  /** Enabled monitors grouped by type and status, for the overview cards. */
  async summary(organization: OrganizationContext): Promise<readonly MonitorSummaryDto[]> {
    const counts = await this.repository.countByTypeAndStatus(organization.objectId);

    return MONITOR_TYPES.map((type) => {
      const forType = counts.filter((count) => count.type === type);
      const of = (status: string): number =>
        forType.find((count) => count.status === status)?.count ?? 0;

      return {
        type,
        passing: of('passing'),
        warning: of('warning'),
        failing: of('failing'),
        error: of('error'),
        unknown: of('unknown'),
      };
    });
  }

  /**
   * Applies the plan's ceiling to a crawl configuration.
   *
   * Clamped, not refused: a request for more pages than the plan allows is a
   * reasonable thing to ask, and running the crawl the customer is entitled to
   * is better service than rejecting it over a number they cannot see.
   */
  private clampConfig(
    organization: OrganizationContext,
    config: NonNullable<UpdateMonitorInput['config']>,
  ): NonNullable<UpdateMonitorInput['config']> {
    if (config.type !== 'links') return config;

    const cap = this.entitlements.limit(organization, 'maxCrawlPages');
    return { ...config, maxPages: Math.min(config.maxPages, cap) };
  }
}

/** A monitor type that has never been configured, rendered from its defaults. */
function unconfiguredMonitor(websiteId: string, type: MonitorType): MonitorDto {
  return {
    // No document exists yet, so there is no id to give. The client addresses
    // these by `(websiteId, type)`, never by id, precisely so this case needs
    // no placeholder identifier.
    id: '',
    websiteId,
    type,
    enabled: false,
    intervalSeconds: DEFAULT_MONITOR_INTERVAL_SECONDS[type],
    status: 'unknown',
    lastRunAt: null,
    lastSummary: null,
    nextRunAt: null,
    config: defaultConfigFor(type),
    latestResult: null,
  };
}

export function toMonitorDto(monitor: MonitorRecord, latest?: MonitorResultRecord): MonitorDto {
  return {
    id: monitor._id.toHexString(),
    websiteId: monitor.websiteId.toHexString(),
    type: monitor.type,
    enabled: monitor.enabled,
    intervalSeconds: monitor.intervalSeconds,
    status: monitor.status,
    lastRunAt: monitor.lastRunAt?.toISOString() ?? null,
    lastSummary: monitor.lastSummary,
    // Only meaningful while enabled; a paused monitor's stored date is a
    // leftover, and showing it would promise a run that will not happen.
    nextRunAt: monitor.enabled ? monitor.nextRunAt.toISOString() : null,
    config: monitor.config,
    latestResult: latest ? toMonitorResultDto(latest) : null,
  };
}

export function toMonitorResultDto(result: MonitorResultRecord): MonitorResultDto {
  return {
    id: result._id.toHexString(),
    monitorId: result.monitorId.toHexString(),
    websiteId: result.websiteId.toHexString(),
    type: result.type,
    status: result.status,
    checkedAt: result.checkedAt.toISOString(),
    durationMs: result.durationMs,
    summary: result.summary,
    data: result.data,
    findings: result.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      detail: finding.detail,
    })),
    errorMessage: result.errorMessage,
  };
}
