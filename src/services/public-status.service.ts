import {
  calculateUptimePercentage,
  limitsFor,
  overallPublicStatus,
  planHasFeature,
  publicStatusOf,
  type PublicIncidentDto,
  type PublicStatusComponentDto,
  type PublicStatusPageDto,
  type PublicUptimeDayDto,
  type StatusPageHistoryDays,
} from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type {
  DailyCheckCounts,
  StatusPageRecord,
  StatusPageRepository,
} from '../repositories/status-page.repository.js';
import type { BrandingService } from './branding.service.js';
import type { PublicStatusCache } from './public-status-cache.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PublicStatusServiceOptions {
  readonly repository: StatusPageRepository;
  readonly branding: BrandingService;
  readonly cache: PublicStatusCache;
  readonly now?: () => Date;
}

/**
 * Renders published status pages for anyone on the internet.
 *
 * Everything here is written against one question: what may a stranger learn?
 * The answer is a component's name, whether it works, how reliably it has, and
 * that an outage or slowdown is open. Not the URL being monitored, not response
 * times, status codes or error messages, not which organization owns the page,
 * and not any id that could be tried against another endpoint.
 *
 * A page that is unpublished, does not exist, or belongs to a plan that no
 * longer includes status pages is the same 404. So is a custom domain on a plan
 * that no longer includes custom domains — the slug keeps working.
 */
export class PublicStatusService {
  private readonly repository: StatusPageRepository;
  private readonly branding: BrandingService;
  private readonly cache: PublicStatusCache;
  private readonly now: () => Date;

  constructor(options: PublicStatusServiceOptions) {
    this.repository = options.repository;
    this.branding = options.branding;
    this.cache = options.cache;
    this.now = options.now ?? (() => new Date());
  }

  async bySlug(slug: string, days: StatusPageHistoryDays): Promise<PublicStatusPageDto> {
    const key = `slug:${slug}:${String(days)}`;
    const cached = this.cache.page(key);
    if (cached) return cached;

    const page = await this.repository.findPublishedBySlug(slug);
    const rendered = page ? await this.render(page, days, { viaCustomDomain: false }) : null;
    if (!page || !rendered) throw statusPageNotFound();

    this.cache.rememberPage(key, page._id.toHexString(), rendered);
    return rendered;
  }

  /** The page a verified custom domain serves. `pageId` comes from the host, never the request. */
  async byCustomDomain(pageId: string, days: StatusPageHistoryDays): Promise<PublicStatusPageDto> {
    const key = `domain:${pageId}:${String(days)}`;
    const cached = this.cache.page(key);
    if (cached) return cached;

    const page = await this.repository.findPublishedById(pageId);
    const rendered = page ? await this.render(page, days, { viaCustomDomain: true }) : null;
    if (!page || !rendered) throw statusPageNotFound();

    this.cache.rememberPage(key, pageId, rendered);
    return rendered;
  }

  private async render(
    page: StatusPageRecord,
    requestedDays: StatusPageHistoryDays,
    options: { readonly viaCustomDomain: boolean },
  ): Promise<PublicStatusPageDto | null> {
    // The plan is read from the organization every render, never cached on the
    // page: a downgrade must take the page down within one cache TTL.
    const plan = await this.repository.planOf(page.organizationId);
    if (!plan || !planHasFeature(plan, 'status_pages')) return null;
    if (options.viaCustomDomain && !planHasFeature(plan, 'custom_domains')) return null;

    // Showing ninety days of bars for an organization whose checks are kept for
    // thirty would draw sixty days of "no data" that are really "deleted".
    const historyDays = Math.min(requestedDays, limitsFor(plan).checkRetentionDays);
    const now = this.now();
    const days = utcDays(now, historyDays);
    const firstDay = days[0] ?? now.toISOString().slice(0, 10);
    const since = new Date(`${firstDay}T00:00:00.000Z`);

    const requestedIds = page.components.map((component) => component.websiteId);
    // Tenant-scoped first, so every later read uses only ids proven to be this
    // organization's — whatever the stored page happens to contain.
    const statuses = await this.repository.websiteStatuses(page.organizationId, requestedIds);
    const ownedIds = requestedIds.filter((id) => statuses.has(id.toHexString()));

    const [counts, incidents, branding] = await Promise.all([
      this.repository.dailyCheckCounts(ownedIds, since),
      this.repository.openPublicIncidents(page.organizationId, ownedIds),
      this.branding.forOrganizationId(page.organizationId),
    ]);

    const components: PublicStatusComponentDto[] = [];
    const names = new Map<string, string>();
    for (const component of page.components) {
      const key = component.websiteId.toHexString();
      const status = statuses.get(key);
      if (status === undefined) continue;

      names.set(key, component.displayName);
      components.push({
        name: component.displayName,
        status: publicStatusOf(status),
        ...history(days, counts.get(key)),
      });
    }

    const activeIncidents: PublicIncidentDto[] = incidents.flatMap((incident) => {
      const componentName = names.get(incident.websiteId.toHexString());
      if (componentName === undefined) return [];
      return [
        {
          componentName,
          kind: incident.category === 'anomaly' ? 'degraded' : 'outage',
          startedAt: incident.startedAt.toISOString(),
        },
      ];
    });

    return {
      slug: page.slug,
      title: page.title,
      description: page.description,
      theme: { mode: page.theme.mode, accentColor: page.theme.accentColor },
      status: overallPublicStatus(components.map((component) => component.status)),
      components,
      activeIncidents,
      historyDays,
      showPoweredBy: branding.showPoweredBy,
      generatedAt: now.toISOString(),
    };
  }
}

/** The last `count` UTC dates, oldest first, ending today. */
function utcDays(now: Date, count: number): readonly string[] {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: count }, (_, index) =>
    new Date(todayStart - (count - 1 - index) * DAY_MS).toISOString().slice(0, 10),
  );
}

function history(
  days: readonly string[],
  counts: ReadonlyMap<string, DailyCheckCounts> | undefined,
): Pick<PublicStatusComponentDto, 'uptimePercentage' | 'history'> {
  let total = 0;
  let successful = 0;

  const perDay: PublicUptimeDayDto[] = days.map((date) => {
    const day = counts?.get(date);
    if (!day) return { date, uptimePercentage: null };
    total += day.total;
    successful += day.successful;
    return { date, uptimePercentage: calculateUptimePercentage(day.successful, day.total) };
  });

  return { uptimePercentage: calculateUptimePercentage(successful, total), history: perDay };
}

function statusPageNotFound(): ApiError {
  return ApiError.notFound('STATUS_PAGE_NOT_FOUND', 'Status page not found.');
}
