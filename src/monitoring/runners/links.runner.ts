import type { LinksCheckData, LinksMonitorConfig, MonitorFinding } from '../../contracts/index.js';
import { DEFAULT_LINKS_CONFIG } from '../../contracts/index.js';
import { crawlSite } from '../crawler/crawler.js';
import { parseRobots, permissiveRobots, type RobotsRules } from '../crawler/robots.js';
import {
  monitorError,
  type MonitorRunContext,
  type MonitorRunResult,
  type MonitorRunner,
} from '../monitor-runner.js';
import { fetchPage } from '../safe-request.js';

/**
 * The broken-link monitor.
 *
 * A crawl is the most intrusive thing SiteOps does to a customer's site, and
 * every bound that makes it safe lives in `crawler.ts`. This runner's job is to
 * fetch `robots.txt`, set the deadline, and turn the crawl's result into a
 * verdict.
 *
 * Broken links are `warning`, not `failing`. A site with a dead link is not
 * down, and a red mark for one 404 in a blog archive would make the status
 * colour meaningless. The exception is when the *starting page itself* cannot
 * be fetched — that is a real problem with the site, not with its links.
 */

const MAX_ROBOTS_BYTES = 512 * 1024;
const ROBOTS_TIMEOUT_MS = 10_000;

/** Leave this much of the run's budget for writing the result. */
const DEADLINE_MARGIN_MS = 10_000;

const EMPTY_DATA: LinksCheckData = {
  pagesCrawled: 0,
  linksChecked: 0,
  brokenCount: 0,
  brokenLinks: [],
  truncated: false,
};

function configOf(context: MonitorRunContext): LinksMonitorConfig {
  const config = context.monitor.config;
  return config.type === 'links' ? config : DEFAULT_LINKS_CONFIG;
}

export function createLinksRunner(): MonitorRunner {
  return {
    type: 'links',

    async run(context: MonitorRunContext): Promise<MonitorRunResult> {
      const config = configOf(context);
      const startedAt = Date.now();

      const robots = config.respectRobotsTxt
        ? await loadRobots(context)
        : /*
           * Ignoring robots.txt is opt-in and the dialog warns about it: it is
           * legitimate for a site you own — plenty of staging sites disallow
           * everything — and not for one you do not.
           */
          permissiveRobots(false);

      const result = await crawlSite({
        startUrl: context.monitor.websiteUrl,
        maxPages: config.maxPages,
        maxDepth: config.maxDepth,
        checkExternal: config.checkExternal,
        robots,
        userAgent: context.userAgent,
        allowLoopback: context.allowLoopback,
        deadline: startedAt + Math.max(0, context.timeoutMs - DEADLINE_MARGIN_MS),
      });

      if (result.pagesCrawled === 0) {
        return monitorError(
          robots.found && !robots.isAllowed(pathOf(context.monitor.websiteUrl))
            ? 'The site’s robots.txt disallows crawling this page.'
            : 'The starting page could not be fetched.',
          { type: 'links', ...EMPTY_DATA },
        );
      }

      const data: LinksCheckData = {
        pagesCrawled: result.pagesCrawled,
        linksChecked: result.linksChecked,
        brokenCount: result.brokenCount,
        brokenLinks: result.brokenLinks,
        truncated: result.truncated,
      };

      const findings: MonitorFinding[] = result.brokenLinks.map((link) => ({
        code: link.external ? 'links.external_broken' : 'links.internal_broken',
        // An internal broken link is the site's own fault and its own to fix;
        // an external one may simply be a site that has since moved.
        severity: link.external ? 'notice' : 'warning',
        message: `${link.url} — ${link.reason}`,
        detail: `Linked from ${link.foundOn}`,
      }));

      if (result.truncated) {
        findings.push({
          code: 'links.crawl_truncated',
          severity: 'notice',
          message: 'The crawl stopped at its limit before covering the whole site.',
          detail: `Crawled ${String(result.pagesCrawled)} pages of a maximum ${String(config.maxPages)}`,
        });
      }

      return {
        status: result.brokenCount > 0 ? 'warning' : 'passing',
        summary:
          result.brokenCount === 0
            ? `No broken links across ${String(result.pagesCrawled)} pages and ${String(result.linksChecked)} links.`
            : `${String(result.brokenCount)} broken ${result.brokenCount === 1 ? 'link' : 'links'} across ${String(result.pagesCrawled)} pages.`,
        data: { type: 'links', ...data },
        findings,
      };
    },
  };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

/**
 * Fetches and parses `robots.txt`.
 *
 * A missing file means no restrictions, which is the standard's own reading. A
 * file we could not *fetch* — a timeout, a 500 — is treated the same way rather
 * than refusing to crawl, because a site whose robots.txt is briefly
 * unreachable has not asked us to stay away; it has simply failed to answer.
 */
async function loadRobots(context: MonitorRunContext): Promise<RobotsRules> {
  let origin: string;
  try {
    origin = new URL(context.monitor.websiteUrl).origin;
  } catch {
    return permissiveRobots(false);
  }

  const outcome = await fetchPage(`${origin}/robots.txt`, {
    timeoutMs: ROBOTS_TIMEOUT_MS,
    maxRedirects: 3,
    allowLoopback: context.allowLoopback,
    userAgent: context.userAgent,
    maxBytes: MAX_ROBOTS_BYTES,
    accept: 'text/plain,*/*',
  });

  if (!outcome.ok || outcome.page.statusCode >= 400) return permissiveRobots(false);

  return parseRobots(outcome.page.body, context.userAgent);
}
