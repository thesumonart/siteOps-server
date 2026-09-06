import type { SeoCheckData, SeoMonitorConfig } from '../../contracts/index.js';
import { DEFAULT_SEO_CONFIG } from '../../contracts/index.js';
import { analyzeSeo } from '../html/seo-analyzer.js';
import {
  monitorError,
  type MonitorRunContext,
  type MonitorRunResult,
  type MonitorRunner,
} from '../monitor-runner.js';
import { fetchPage } from '../safe-request.js';

/**
 * The SEO health monitor.
 *
 * Fetches the page, plus `robots.txt` and a sitemap probe, and runs the checks
 * in `seo-analyzer.ts`. The scope of those checks is documented there and is
 * deliberately narrow: machine-readable signals off one HTML document, nothing
 * about rankings, content quality or a rendered page.
 *
 * A score below the configured threshold is `warning`, never `failing` — an
 * imperfect SEO score is not an outage, and colouring it the same as a down
 * site would devalue the colour. The one exception is a page that has become
 * unindexable, which is `failing`: a `noindex` left on after a deploy removes
 * the page from search entirely and is worth waking someone for.
 */

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const AUXILIARY_TIMEOUT_MS = 10_000;

const EMPTY_DATA: SeoCheckData = {
  score: 0,
  title: null,
  titleLength: null,
  metaDescription: null,
  metaDescriptionLength: null,
  canonical: null,
  robotsMeta: null,
  indexable: true,
  robotsTxtFound: false,
  sitemapFound: false,
  h1Count: 0,
  imageCount: 0,
  imagesMissingAlt: 0,
  internalLinkCount: 0,
  openGraphComplete: false,
  https: false,
  wordCount: 0,
};

function configOf(context: MonitorRunContext): SeoMonitorConfig {
  const config = context.monitor.config;
  return config.type === 'seo' ? config : DEFAULT_SEO_CONFIG;
}

export function createSeoRunner(): MonitorRunner {
  return {
    type: 'seo',

    async run(context: MonitorRunContext): Promise<MonitorRunResult> {
      const config = configOf(context);

      const page = await fetchPage(context.monitor.websiteUrl, {
        timeoutMs: context.timeoutMs,
        maxRedirects: 5,
        allowLoopback: context.allowLoopback,
        userAgent: context.userAgent,
        maxBytes: MAX_PAGE_BYTES,
      });

      if (!page.ok) return monitorError(page.reason, { type: 'seo', ...EMPTY_DATA });
      if (page.page.statusCode >= 400) {
        return monitorError(`The page responded with HTTP ${String(page.page.statusCode)}.`, {
          type: 'seo',
          ...EMPTY_DATA,
        });
      }

      const origin = originOf(page.page.finalUrl);
      const { robotsTxtFound, sitemapFound } = await probeSiteFiles(origin, context);

      const analysis = analyzeSeo({
        html: page.page.body,
        finalUrl: page.page.finalUrl,
        robotsTxtFound,
        sitemapFound,
        robotsHeader: null,
      });

      const status = !analysis.data.indexable
        ? 'failing'
        : analysis.data.score < config.minScore
          ? 'warning'
          : 'passing';

      return {
        status,
        summary: !analysis.data.indexable
          ? 'This page tells search engines not to index it.'
          : `Score ${String(analysis.data.score)}/100, ${String(analysis.findings.length)} ${analysis.findings.length === 1 ? 'issue' : 'issues'}.`,
        data: { type: 'seo', ...analysis.data },
        findings: analysis.findings,
      };
    },
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Looks for `robots.txt` and a sitemap.
 *
 * The sitemap is looked for in `robots.txt` first — a `Sitemap:` line is the
 * declared location and may point anywhere — and only then at the conventional
 * `/sitemap.xml`. Checking the conventional path alone would report "no
 * sitemap" for the many sites that publish one somewhere else and say so.
 *
 * Neither probe failing is an error for this monitor: both simply resolve to
 * "not found", which is a finding rather than a broken check.
 */
async function probeSiteFiles(
  origin: string | null,
  context: MonitorRunContext,
): Promise<{ robotsTxtFound: boolean; sitemapFound: boolean }> {
  if (origin === null) return { robotsTxtFound: false, sitemapFound: false };

  const base = {
    timeoutMs: AUXILIARY_TIMEOUT_MS,
    maxRedirects: 3,
    allowLoopback: context.allowLoopback,
    userAgent: context.userAgent,
    maxBytes: MAX_ROBOTS_BYTES,
    accept: 'text/plain,*/*',
  };

  const robots = await fetchPage(`${origin}/robots.txt`, base);
  const robotsTxtFound = robots.ok && robots.page.statusCode < 400;

  if (robotsTxtFound && /^\s*sitemap\s*:/im.test(robots.page.body)) {
    return { robotsTxtFound, sitemapFound: true };
  }

  const sitemap = await fetchPage(`${origin}/sitemap.xml`, {
    ...base,
    method: 'HEAD',
    accept: 'application/xml,text/xml,*/*',
  });

  return { robotsTxtFound, sitemapFound: sitemap.ok && sitemap.page.statusCode < 400 };
}
