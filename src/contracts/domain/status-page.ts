import type { WebsiteStatus } from './website.js';

/**
 * Public status pages: what an agency's clients, and their customers, see.
 *
 * The line this module draws is between what a visitor is told and what the
 * agency knows. A visitor learns whether each component is working, how
 * reliably it has worked, and whether something is wrong right now. They do not
 * learn a URL, a response time, a status code, an error message, or that
 * monitoring was paused — each of those is either internal or a way to tell a
 * competitor exactly what broke.
 */

/** How much history a page shows. Bounded by the plan's retention, since older checks no longer exist. */
export const STATUS_PAGE_HISTORY_DAYS = [30, 60, 90] as const;

export type StatusPageHistoryDays = (typeof STATUS_PAGE_HISTORY_DAYS)[number];

export const DEFAULT_STATUS_PAGE_HISTORY_DAYS: StatusPageHistoryDays = 90;

export const STATUS_PAGE_THEMES = ['light', 'dark', 'auto'] as const;

export type StatusPageTheme = (typeof STATUS_PAGE_THEMES)[number];

/** Components on one page. A page past this is a dashboard, not a status page. */
export const MAX_STATUS_PAGE_COMPONENTS = 50;

/**
 * The only statuses a visitor ever sees.
 *
 * `paused` and `unknown` both read as `unknown`. A visitor has no use for
 * knowing that monitoring was switched off, and "this site is not being watched
 * right now" is not something an agency should be publishing about a client.
 */
export const PUBLIC_COMPONENT_STATUSES = ['operational', 'degraded', 'down', 'unknown'] as const;

export type PublicComponentStatus = (typeof PUBLIC_COMPONENT_STATUSES)[number];

export const PUBLIC_COMPONENT_STATUS_LABELS: Record<PublicComponentStatus, string> = {
  operational: 'Operational',
  degraded: 'Degraded performance',
  down: 'Outage',
  unknown: 'No data',
};

export function publicStatusOf(status: WebsiteStatus): PublicComponentStatus {
  switch (status) {
    case 'operational':
      return 'operational';
    case 'degraded':
      return 'degraded';
    case 'down':
      return 'down';
    case 'paused':
    case 'unknown':
      return 'unknown';
  }
}

const PUBLIC_STATUS_RANK: Record<PublicComponentStatus, number> = {
  unknown: 0,
  operational: 1,
  degraded: 2,
  down: 3,
};

/**
 * The page's headline: its worst component.
 *
 * `unknown` ranks lowest, so one unmeasured component does not turn a page of
 * working ones grey — but a page where nothing is measured says so rather than
 * claiming to be operational.
 */
export function overallPublicStatus(
  statuses: readonly PublicComponentStatus[],
): PublicComponentStatus {
  return statuses.reduce<PublicComponentStatus>(
    (worst, status) => (PUBLIC_STATUS_RANK[status] > PUBLIC_STATUS_RANK[worst] ? status : worst),
    'unknown',
  );
}

/**
 * What a visitor is told an open incident is.
 *
 * Only availability and response-time anomalies are published. An expiring
 * certificate, a changed page or an SEO regression is the agency's business,
 * not something to announce to the client's customers.
 */
export const PUBLIC_INCIDENT_KINDS = ['outage', 'degraded'] as const;

export type PublicIncidentKind = (typeof PUBLIC_INCIDENT_KINDS)[number];

/**
 * A custom domain proves ownership with a TXT record at
 * `_siteops-challenge.<domain>` whose value is `siteops-verification=<token>`.
 * Until that record resolves, the domain routes nowhere.
 */
export const CUSTOM_DOMAIN_CHALLENGE_LABEL = '_siteops-challenge';
export const CUSTOM_DOMAIN_CHALLENGE_PREFIX = 'siteops-verification=';

export const CUSTOM_DOMAIN_STATUSES = ['pending', 'verified'] as const;

export type CustomDomainStatus = (typeof CUSTOM_DOMAIN_STATUSES)[number];
