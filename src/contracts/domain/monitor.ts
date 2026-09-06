/**
 * The auxiliary monitors that run alongside uptime checking.
 *
 * Uptime is checked on its own path — every minute or five, from the website
 * document itself, because it is the product's core loop and its cadence is the
 * thing people pay for. Everything here is different in kind: a certificate
 * does not change between two Tuesdays, a WHOIS record is rate-limited by the
 * registry, and a Lighthouse run costs seconds of CPU. They run hourly at most,
 * on their own leases, in their own queue.
 *
 * Each monitor is one document per `(website, type)` pair, so a website can
 * have SSL checking on and crawling off, at different intervals, without the
 * uptime check knowing anything about either.
 */
export const MONITOR_TYPES = ['ssl', 'domain', 'performance', 'content', 'seo', 'links'] as const;

export type MonitorType = (typeof MONITOR_TYPES)[number];

export const MONITOR_TYPE_LABELS: Record<MonitorType, string> = {
  ssl: 'SSL certificate',
  domain: 'Domain expiry',
  performance: 'Performance',
  content: 'Content changes',
  seo: 'SEO health',
  links: 'Broken links',
};

export const MONITOR_TYPE_DESCRIPTIONS: Record<MonitorType, string> = {
  ssl: 'Checks the certificate chain, hostname match and how long is left before it expires.',
  domain: 'Looks up the domain registration and warns before it lapses.',
  performance: 'Measures how fast the page loads and scores it.',
  content: 'Notices when the page content changes in a way that matters.',
  seo: 'Checks the technical SEO signals a crawler reads.',
  links: 'Crawls the site and reports links that no longer resolve.',
};

/**
 * The outcome of one monitor run.
 *
 * `error` and `failing` are deliberately distinct. `failing` means the monitor
 * ran and the answer was bad — a certificate has expired. `error` means the
 * monitor could not get an answer at all — a registry timed out. Treating the
 * second as the first would page someone about an expired domain because WHOIS
 * was briefly unreachable, which is how a monitoring product loses trust.
 */
export const MONITOR_STATUSES = ['passing', 'warning', 'failing', 'error', 'unknown'] as const;

export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

export const MONITOR_STATUS_LABELS: Record<MonitorStatus, string> = {
  passing: 'Passing',
  warning: 'Warning',
  failing: 'Failing',
  error: 'Check failed',
  unknown: 'Not yet run',
};

/** Whether a status should be surfaced as a problem rather than as information. */
export function isMonitorProblem(status: MonitorStatus): boolean {
  return status === 'warning' || status === 'failing';
}

/**
 * How severe a single finding is.
 *
 * Shared by SEO checks, link results and certificate problems so one legend
 * explains all of them.
 */
export const FINDING_SEVERITIES = ['critical', 'warning', 'notice'] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_SEVERITY_LABELS: Record<FindingSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  notice: 'Notice',
};

/** One specific thing a monitor found, in a form the UI can list and count. */
export interface MonitorFinding {
  /** Stable machine-readable identifier, e.g. `seo.title_missing`. */
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  /** The URL, element or value the finding is about; null when site-wide. */
  readonly detail: string | null;
}

/**
 * Default cadence per monitor type, in seconds.
 *
 * Chosen from how fast the underlying thing can actually change, not from how
 * often we could ask. A certificate is reissued at most a few times a year and
 * a domain expires on a known date, so daily is ample and anything faster is
 * load on someone else's registry for no information. Content and performance
 * move within a day. Crawling is the most expensive thing SiteOps does to a
 * customer's site, so it is weekly by default.
 */
export const DEFAULT_MONITOR_INTERVAL_SECONDS: Record<MonitorType, number> = {
  ssl: 86_400,
  domain: 86_400,
  performance: 86_400,
  content: 21_600,
  seo: 86_400,
  links: 604_800,
};

export const MIN_MONITOR_INTERVAL_SECONDS = 3_600;
export const MAX_MONITOR_INTERVAL_SECONDS = 2_592_000;

/** Intervals offered in the dashboard, in seconds. */
export const MONITOR_INTERVALS_SECONDS = [3_600, 21_600, 43_200, 86_400, 604_800] as const;

export const MONITOR_INTERVAL_LABELS: Record<number, string> = {
  3_600: 'Every hour',
  21_600: 'Every 6 hours',
  43_200: 'Every 12 hours',
  86_400: 'Daily',
  604_800: 'Weekly',
};

/**
 * Which plan feature each monitor needs.
 *
 * Declared here rather than at each call site so a route, the worker and the
 * dashboard cannot disagree about whether a monitor is included.
 */
export const MONITOR_FEATURE: Record<
  MonitorType,
  | 'ssl_monitoring'
  | 'domain_monitoring'
  | 'performance_monitoring'
  | 'change_detection'
  | 'seo_monitoring'
  | 'broken_link_monitoring'
> = {
  ssl: 'ssl_monitoring',
  domain: 'domain_monitoring',
  performance: 'performance_monitoring',
  content: 'change_detection',
  seo: 'seo_monitoring',
  links: 'broken_link_monitoring',
};

/* ------------------------------------------------------------------------ */
/* Per-monitor configuration                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Days before expiry at which an SSL monitor starts warning, and at which it
 * escalates.
 *
 * The defaults bracket Let's Encrypt's 90-day lifetime and its 30-day renewal
 * window: 30 days is "renewal should have happened by now" and 7 is "something
 * is wrong with your automation".
 */
export const DEFAULT_SSL_WARNING_DAYS = 30;
export const DEFAULT_SSL_CRITICAL_DAYS = 7;

export interface SslMonitorConfig {
  readonly warningDays: number;
  readonly criticalDays: number;
}

/** Domains lapse silently and are expensive to recover, so the window is wider. */
export const DEFAULT_DOMAIN_WARNING_DAYS = 45;
export const DEFAULT_DOMAIN_CRITICAL_DAYS = 14;

export interface DomainMonitorConfig {
  readonly warningDays: number;
  readonly criticalDays: number;
}

export interface PerformanceMonitorConfig {
  /** Score below which the monitor warns, 0–100. */
  readonly minPerformanceScore: number;
  /** Largest Contentful Paint above which the monitor warns, in milliseconds. */
  readonly maxLargestContentfulPaintMs: number;
  readonly strategy: 'mobile' | 'desktop';
}

export const DEFAULT_PERFORMANCE_CONFIG: PerformanceMonitorConfig = {
  minPerformanceScore: 50,
  maxLargestContentfulPaintMs: 4_000,
  strategy: 'mobile',
};

/**
 * How much a page has to change before it counts as a change.
 *
 * `sensitivity` is the share of the normalized text that must differ. A news
 * homepage changes constantly and should be watched at `low`; a pricing page
 * should be watched at `high`, where a single altered figure matters.
 */
export const CHANGE_SENSITIVITIES = ['low', 'medium', 'high'] as const;

export type ChangeSensitivity = (typeof CHANGE_SENSITIVITIES)[number];

export const CHANGE_SENSITIVITY_LABELS: Record<ChangeSensitivity, string> = {
  low: 'Only large changes',
  medium: 'Noticeable changes',
  high: 'Any change',
};

/** Minimum fraction of the page that must differ, per sensitivity. */
export const CHANGE_THRESHOLD: Record<ChangeSensitivity, number> = {
  low: 0.2,
  medium: 0.05,
  high: 0,
};

export interface ContentMonitorConfig {
  readonly sensitivity: ChangeSensitivity;
  /**
   * CSS-like selectors whose content is excluded before hashing. Kept as
   * simple tag/class/id selectors; see `content-normalizer.ts` for what is
   * actually supported.
   */
  readonly ignoreSelectors: readonly string[];
  /** Watch only what is inside this selector, rather than the whole document. */
  readonly watchSelector: string | null;
}

export const DEFAULT_CONTENT_CONFIG: ContentMonitorConfig = {
  sensitivity: 'medium',
  ignoreSelectors: [],
  watchSelector: null,
};

export interface SeoMonitorConfig {
  /** Score below which the monitor warns, 0–100. */
  readonly minScore: number;
}

export const DEFAULT_SEO_CONFIG: SeoMonitorConfig = { minScore: 70 };

export interface LinksMonitorConfig {
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly checkExternal: boolean;
  readonly respectRobotsTxt: boolean;
}

export const DEFAULT_LINKS_CONFIG: LinksMonitorConfig = {
  maxPages: 50,
  maxDepth: 3,
  checkExternal: true,
  respectRobotsTxt: true,
};

/**
 * The configuration of one monitor, discriminated by its type.
 *
 * Stored as an untyped subdocument, because six typed sub-schemas would buy
 * validation MongoDB does not need — the only writer is this codebase, and the
 * shape is enforced by the Zod schema every write passes through.
 */
export type MonitorConfig =
  | ({ readonly type: 'ssl' } & SslMonitorConfig)
  | ({ readonly type: 'domain' } & DomainMonitorConfig)
  | ({ readonly type: 'performance' } & PerformanceMonitorConfig)
  | ({ readonly type: 'content' } & ContentMonitorConfig)
  | ({ readonly type: 'seo' } & SeoMonitorConfig)
  | ({ readonly type: 'links' } & LinksMonitorConfig);

export function defaultConfigFor(type: MonitorType): MonitorConfig {
  switch (type) {
    case 'ssl':
      return {
        type,
        warningDays: DEFAULT_SSL_WARNING_DAYS,
        criticalDays: DEFAULT_SSL_CRITICAL_DAYS,
      };
    case 'domain':
      return {
        type,
        warningDays: DEFAULT_DOMAIN_WARNING_DAYS,
        criticalDays: DEFAULT_DOMAIN_CRITICAL_DAYS,
      };
    case 'performance':
      return { type, ...DEFAULT_PERFORMANCE_CONFIG };
    case 'content':
      return { type, ...DEFAULT_CONTENT_CONFIG };
    case 'seo':
      return { type, ...DEFAULT_SEO_CONFIG };
    case 'links':
      return { type, ...DEFAULT_LINKS_CONFIG };
  }
}

/* ------------------------------------------------------------------------ */
/* Per-monitor result payloads                                               */
/* ------------------------------------------------------------------------ */

export interface SslCheckData {
  readonly valid: boolean;
  readonly issuer: string | null;
  readonly subject: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly daysRemaining: number | null;
  readonly hostnameMatches: boolean;
  readonly selfSigned: boolean;
  readonly protocol: string | null;
  readonly keyAlgorithm: string | null;
  readonly serialNumber: string | null;
  readonly subjectAlternativeNames: readonly string[];
  /** Why the chain was rejected, verbatim from OpenSSL. Null when it verified. */
  readonly validationError: string | null;
}

export interface DomainCheckData {
  readonly domain: string;
  readonly registrar: string | null;
  readonly registeredAt: string | null;
  readonly expiresAt: string | null;
  readonly daysRemaining: number | null;
  readonly statuses: readonly string[];
  readonly nameServers: readonly string[];
  /** Which lookup answered: `rdap` or `whois`. */
  readonly source: string;
}

export interface PerformanceCheckData {
  /** 0–100, or null when the provider did not return one. */
  readonly performanceScore: number | null;
  readonly accessibilityScore: number | null;
  readonly bestPracticesScore: number | null;
  readonly seoScore: number | null;
  readonly firstContentfulPaintMs: number | null;
  readonly largestContentfulPaintMs: number | null;
  readonly totalBlockingTimeMs: number | null;
  readonly cumulativeLayoutShift: number | null;
  readonly speedIndexMs: number | null;
  readonly timeToFirstByteMs: number | null;
  /** Total bytes of the HTML document and the subresources that were measured. */
  readonly totalBytes: number | null;
  readonly requestCount: number | null;
  /** Which provider produced this: `pagespeed` or `synthetic`. */
  readonly source: string;
  readonly strategy: 'mobile' | 'desktop';
}

/** Normalized lines kept with a content result, so the next run can diff. */
export const MAX_STORED_CONTENT_LINES = 400;
/** Longest single line kept, so one minified blob cannot dominate a document. */
export const MAX_STORED_LINE_LENGTH = 400;

export interface ContentCheckData {
  readonly contentHash: string;
  readonly previousHash: string | null;
  readonly changed: boolean;
  /** Share of the normalized text that differs from the previous run, 0–1. */
  readonly changeRatio: number | null;
  readonly normalizedLength: number;
  readonly addedLineCount: number;
  readonly removedLineCount: number;
  /** A short, bounded excerpt of what changed, for the notification body. */
  readonly excerpt: string | null;
  /**
   * The normalized lines this run saw, so the *next* run can produce a
   * line-level diff rather than only "the hash differs".
   *
   * Bounded on both axes ({@link MAX_STORED_CONTENT_LINES} and
   * {@link MAX_STORED_LINE_LENGTH}). Storing a full copy of every watched page
   * on every run would make this the largest collection in the product; the cap
   * means a very long page's diff covers its opening rather than all of it,
   * which is where a meaningful change almost always is. The hash is computed
   * over the *whole* normalized text regardless, so detection is never
   * truncated — only the explanation is.
   */
  readonly lines: readonly string[];
}

export interface SeoCheckData {
  readonly score: number;
  readonly title: string | null;
  readonly titleLength: number | null;
  readonly metaDescription: string | null;
  readonly metaDescriptionLength: number | null;
  readonly canonical: string | null;
  readonly robotsMeta: string | null;
  readonly indexable: boolean;
  readonly robotsTxtFound: boolean;
  readonly sitemapFound: boolean;
  readonly h1Count: number;
  readonly imageCount: number;
  readonly imagesMissingAlt: number;
  readonly internalLinkCount: number;
  readonly openGraphComplete: boolean;
  readonly https: boolean;
  readonly wordCount: number;
}

export interface BrokenLink {
  readonly url: string;
  /** The page the link was found on. */
  readonly foundOn: string;
  readonly statusCode: number | null;
  readonly reason: string;
  readonly external: boolean;
}

export interface LinksCheckData {
  readonly pagesCrawled: number;
  readonly linksChecked: number;
  readonly brokenCount: number;
  readonly brokenLinks: readonly BrokenLink[];
  /** True when the crawl stopped at a limit rather than finishing the site. */
  readonly truncated: boolean;
}

/** A monitor result payload, discriminated by monitor type. */
export type MonitorCheckData =
  | ({ readonly type: 'ssl' } & SslCheckData)
  | ({ readonly type: 'domain' } & DomainCheckData)
  | ({ readonly type: 'performance' } & PerformanceCheckData)
  | ({ readonly type: 'content' } & ContentCheckData)
  | ({ readonly type: 'seo' } & SeoCheckData)
  | ({ readonly type: 'links' } & LinksCheckData);

/** The incident type a failing monitor of each kind raises. */
export const MONITOR_INCIDENT_TYPE = {
  ssl: 'ssl_invalid',
  domain: 'domain_expiring',
  performance: 'performance_degraded',
  content: 'content_changed',
  seo: 'seo_regression',
  links: 'broken_links',
} as const;
