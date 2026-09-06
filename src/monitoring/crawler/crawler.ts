import type { BrokenLink } from '../../contracts/index.js';
import { findTags } from '../html/parse.js';
import { closeDispatcher, createGuardedDispatcher, fetchPage } from '../safe-request.js';
import type { RobotsRules } from './robots.js';

/**
 * A bounded, polite crawler for finding broken links.
 *
 * This is the most intrusive thing SiteOps does to a customer's site, and the
 * design is dominated by that rather than by coverage. Every one of the
 * following is a hard bound, not a default someone can raise from the UI:
 *
 *  - **Pages** — capped by the plan and re-clamped here.
 *  - **Depth** — capped, so a paginated archive cannot become infinite.
 *  - **Links checked** — capped independently of pages, because one page can
 *    carry thousands.
 *  - **Wall clock** — a deadline checked between requests, so a slow origin
 *    ends the crawl rather than holding a worker lease until it expires.
 *  - **Concurrency** — one request at a time, plus an optional crawl delay.
 *    A monitoring product that hammers the site it monitors is a denial of
 *    service with a subscription.
 *  - **Addresses** — every fetch goes through the shared guarded dispatcher, so
 *    a link to `169.254.169.254` or an internal host is refused at connect
 *    time exactly as it is everywhere else.
 *
 * URL normalization matters more than it looks. Without it a crawl of any real
 * site immediately re-visits the same page under a fragment, a tracking
 * parameter and a trailing slash, and burns its entire page budget on one
 * document.
 */

/** How many links may be *checked*, independent of how many pages are crawled. */
const MAX_LINKS_CHECKED = 1500;

/** Bytes read per page. Enough for the links; far short of a large document. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** Broken links kept in the result. The rest are counted but not listed. */
const MAX_REPORTED_LINKS = 100;

/** Per-request budget. The overall deadline is what actually bounds the crawl. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Query parameters dropped when deciding whether two URLs are the same page. */
const TRACKING_PARAMETERS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'msclkid',
  'mc_eid',
  'ref',
]);

/** Schemes that are not pages and must never be fetched. */
const NON_HTTP_SCHEME = /^(mailto|tel|sms|javascript|data|ftp|file|blob):/i;

/**
 * Extensions that are never HTML.
 *
 * Fetched with HEAD when they are linked — a broken PDF is still a broken link
 * — but never parsed for further links.
 */
const NON_HTML_EXTENSION =
  /\.(pdf|zip|gz|tar|rar|7z|docx?|xlsx?|pptx?|csv|jpe?g|png|gif|webp|avif|svg|ico|mp4|webm|mp3|wav|woff2?|ttf|eot|css|js|json|xml|rss)$/i;

export interface CrawlOptions {
  readonly startUrl: string;
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly checkExternal: boolean;
  readonly robots: RobotsRules;
  readonly userAgent: string;
  readonly allowLoopback: boolean;
  /** Absolute wall-clock budget for the whole crawl. */
  readonly deadline: number;
}

export interface CrawlResult {
  readonly pagesCrawled: number;
  readonly linksChecked: number;
  readonly brokenCount: number;
  readonly brokenLinks: readonly BrokenLink[];
  /** True when the crawl stopped at a limit rather than finishing the site. */
  readonly truncated: boolean;
}

/**
 * The canonical form of a URL, for deciding whether two links are the same page.
 *
 * Drops the fragment (never a distinct page to a server), lowercases the host,
 * removes the default port, strips tracking parameters, sorts what remains so
 * `?a=1&b=2` and `?b=2&a=1` collapse, and normalizes an empty path to `/`.
 *
 * A trailing slash is *kept*, because `/about` and `/about/` genuinely can be
 * different resources and guessing wrong means either missing a page or
 * reporting a phantom duplicate.
 */
export function normalizeCrawlUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }
  if (parsed.pathname === '') parsed.pathname = '/';

  const kept = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMETERS.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  parsed.search = '';
  for (const [key, value] of kept) parsed.searchParams.append(key, value);

  return parsed.toString();
}

/** Every `href` on a page, resolved against it and normalized. */
export function extractLinks(html: string, baseUrl: string): readonly string[] {
  const links: string[] = [];
  const seen = new Set<string>();

  for (const tag of findTags(html, 'a')) {
    const href = tag.attributes.get('href')?.trim();
    if (!href || href.length === 0 || href.startsWith('#')) continue;
    if (NON_HTTP_SCHEME.test(href)) continue;

    let resolved: string;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    const normalized = normalizeCrawlUrl(resolved);
    if (normalized === null || seen.has(normalized)) continue;

    seen.add(normalized);
    links.push(normalized);
  }

  return links;
}

interface QueueEntry {
  readonly url: string;
  readonly depth: number;
  /** The page this URL was linked from, so a failure can name its source. */
  readonly foundOn: string;
}

function sameSite(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Walks the site breadth-first, checking every link it finds.
 *
 * Breadth-first rather than depth-first so that a page budget spent on a large
 * site covers the pages nearest the homepage — the ones that matter — instead
 * of descending one branch to the depth limit and stopping.
 */
export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const start = normalizeCrawlUrl(options.startUrl);
  if (start === null) {
    return { pagesCrawled: 0, linksChecked: 0, brokenCount: 0, brokenLinks: [], truncated: false };
  }

  const origin = new URL(start).origin;
  const dispatcher = createGuardedDispatcher({
    timeoutMs: REQUEST_TIMEOUT_MS,
    allowLoopback: options.allowLoopback,
  });

  const queue: QueueEntry[] = [{ url: start, depth: 0, foundOn: start }];
  const queued = new Set<string>([start]);
  /** Every URL whose status is already known, so nothing is fetched twice. */
  const checked = new Map<string, number | null>();

  const broken: BrokenLink[] = [];
  let brokenCount = 0;
  let pagesCrawled = 0;
  let linksChecked = 0;
  let truncated = false;

  const crawlDelayMs = Math.min((options.robots.crawlDelaySeconds ?? 0) * 1000, 5_000);

  const recordBroken = (link: BrokenLink): void => {
    brokenCount += 1;
    if (broken.length < MAX_REPORTED_LINKS) broken.push(link);
  };

  const outOfTime = (): boolean => Date.now() >= options.deadline;

  try {
    while (queue.length > 0) {
      if (pagesCrawled >= options.maxPages || linksChecked >= MAX_LINKS_CHECKED || outOfTime()) {
        truncated = queue.length > 0;
        break;
      }

      const entry = queue.shift();
      if (!entry) break;

      const path = new URL(entry.url).pathname;
      if (!options.robots.isAllowed(path)) continue;

      const outcome = await fetchPage(entry.url, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxRedirects: 5,
        allowLoopback: options.allowLoopback,
        userAgent: options.userAgent,
        maxBytes: MAX_PAGE_BYTES,
        dispatcher,
      });

      pagesCrawled += 1;

      if (!outcome.ok) {
        checked.set(entry.url, null);
        recordBroken({
          url: entry.url,
          foundOn: entry.foundOn,
          statusCode: null,
          reason: outcome.reason,
          external: false,
        });
        continue;
      }

      checked.set(entry.url, outcome.page.statusCode);

      /*
       * A page reached by crawling is judged by exactly the same rules as one
       * reached by a link check. Before this was shared, an internal 403 was
       * reported as broken when it happened to be crawlable and exempted when
       * it was not — the same link giving two different answers depending on
       * its depth.
       */
      if (outcome.page.statusCode >= 400) {
        const verdict = classifyStatus(outcome.page.statusCode);
        if (verdict.broken) {
          recordBroken({
            url: entry.url,
            foundOn: entry.foundOn,
            statusCode: outcome.page.statusCode,
            reason: verdict.reason,
            external: false,
          });
        }
        continue;
      }

      // Only HTML yields more links to follow.
      if (!(outcome.page.contentType ?? '').toLowerCase().includes('html')) continue;

      for (const link of extractLinks(outcome.page.body, outcome.page.finalUrl)) {
        if (linksChecked >= MAX_LINKS_CHECKED || outOfTime()) {
          truncated = true;
          break;
        }

        const internal = sameSite(link, origin);
        if (!internal && !options.checkExternal) continue;
        if (checked.has(link)) continue;

        // An internal HTML page within the depth limit is queued for crawling,
        // and its status is learned from that fetch rather than a separate one.
        const crawlable =
          internal && entry.depth + 1 <= options.maxDepth && !NON_HTML_EXTENSION.test(link);

        if (crawlable && !queued.has(link) && queued.size < options.maxPages * 4) {
          queued.add(link);
          queue.push({ url: link, depth: entry.depth + 1, foundOn: outcome.page.finalUrl });
          continue;
        }

        if (crawlDelayMs > 0) await delay(crawlDelayMs);

        const status = await checkLink(link, options, dispatcher);
        linksChecked += 1;
        checked.set(link, status.statusCode);

        if (status.broken) {
          recordBroken({
            url: link,
            foundOn: outcome.page.finalUrl,
            statusCode: status.statusCode,
            reason: status.reason,
            external: !internal,
          });
        }
      }

      if (crawlDelayMs > 0 && queue.length > 0) await delay(crawlDelayMs);
    }

    if (queue.length > 0) truncated = true;

    return { pagesCrawled, linksChecked, brokenCount, brokenLinks: broken, truncated };
  } finally {
    await closeDispatcher(dispatcher);
  }
}

interface LinkStatus {
  readonly broken: boolean;
  readonly statusCode: number | null;
  readonly reason: string;
}

/**
 * Whether an HTTP status means the link is broken.
 *
 * Shared by the crawl path and the link-check path, because the same URL must
 * get the same verdict whether it happened to be crawlable or not.
 *
 * Three statuses are deliberately *not* broken:
 *
 *  - **401 and 403** — a link into an admin area or a paywalled page answers
 *    this way to an anonymous crawler while working perfectly for the people it
 *    is meant for. Reporting them would bury the real 404s.
 *  - **429** — the site asking us to slow down, not a broken link. Reporting it
 *    would turn our own crawl rate into the customer's problem.
 */
function classifyStatus(statusCode: number): { broken: boolean; reason: string } {
  if (statusCode < 400) return { broken: false, reason: '' };
  if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
    return { broken: false, reason: '' };
  }

  return {
    broken: true,
    reason:
      statusCode === 404
        ? 'Not found.'
        : statusCode === 410
          ? 'Gone.'
          : statusCode >= 500
            ? `Server error (HTTP ${String(statusCode)}).`
            : `Responded with HTTP ${String(statusCode)}.`,
  };
}

/**
 * Checks one link without downloading it.
 *
 * `HEAD` first, because a link check only needs the status and downloading
 * every linked PDF would be both slow and rude. A `405` or `501` means the
 * origin does not implement HEAD, which is common enough to be worth one
 * `GET` retry — reporting those as broken would fill the report with false
 * positives.
 */
async function checkLink(
  url: string,
  options: CrawlOptions,
  dispatcher: ReturnType<typeof createGuardedDispatcher>,
): Promise<LinkStatus> {
  const base = {
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxRedirects: 5,
    allowLoopback: options.allowLoopback,
    userAgent: options.userAgent,
    // Nothing is read from a link check, so the cap is nominal.
    maxBytes: 1024,
    dispatcher,
  };

  let outcome = await fetchPage(url, { ...base, method: 'HEAD' });

  if (outcome.ok && (outcome.page.statusCode === 405 || outcome.page.statusCode === 501)) {
    outcome = await fetchPage(url, { ...base, method: 'GET' });
  }

  if (!outcome.ok) {
    return { broken: true, statusCode: null, reason: outcome.reason };
  }

  const { statusCode } = outcome.page;
  const verdict = classifyStatus(statusCode);
  return { broken: verdict.broken, statusCode, reason: verdict.reason };
}
