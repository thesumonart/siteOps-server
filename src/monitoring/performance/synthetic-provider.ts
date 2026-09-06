import type { PerformanceCheckData } from '../../contracts/index.js';
import { findTags } from '../html/parse.js';
import { closeDispatcher, createGuardedDispatcher, fetchPage } from '../safe-request.js';
import type {
  PerformanceMeasureOptions,
  PerformanceOutcome,
  PerformanceProvider,
} from './performance-provider.js';

/**
 * Performance measured from the server, with no browser involved.
 *
 * **What this can honestly measure**, and does: time to first byte, total
 * transfer time for the document, the document's own size, and the number and
 * combined weight of the render-blocking subresources in its head — the
 * stylesheets and synchronous scripts a browser must fetch and execute before
 * it can paint anything.
 *
 * **What it cannot measure**, and therefore reports as null rather than
 * inventing: Largest Contentful Paint, Cumulative Layout Shift, Total Blocking
 * Time, Speed Index, and any Lighthouse category score. All of those are
 * properties of a rendered page. Returning a plausible-looking guess for them
 * would be worse than returning nothing, because a number on a dashboard is
 * believed.
 *
 * The `performanceScore` it does report is **its own**, derived from the
 * measurements above and documented as such. It is a useful trend line — a
 * score that drops after a deploy means the page got heavier or slower — and it
 * is deliberately not comparable to a Lighthouse score. When a PageSpeed key is
 * configured, that provider runs instead and the real scores are used.
 */

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
/** Subresources fetched to weigh the render-blocking set. */
const MAX_SUBRESOURCES = 15;
const SUBRESOURCE_TIMEOUT_MS = 8_000;

/**
 * Reference points for the score, in milliseconds and bytes.
 *
 * Chosen from the widely published thresholds — 800 ms TTFB is Google's "needs
 * improvement" boundary, and a 2 MB page is roughly the point at which mobile
 * users on a slow connection start abandoning. Each dimension contributes
 * linearly between "good" and "poor" and is clamped at both ends.
 */
const SCORING = {
  timeToFirstByte: { good: 200, poor: 1_200, weight: 30 },
  totalTime: { good: 600, poor: 4_000, weight: 25 },
  totalBytes: { good: 500_000, poor: 3_000_000, weight: 25 },
  blockingResources: { good: 2, poor: 15, weight: 20 },
} as const;

function dimensionScore(value: number, good: number, poor: number): number {
  if (value <= good) return 1;
  if (value >= poor) return 0;
  return 1 - (value - good) / (poor - good);
}

/** Absolute URLs of the stylesheets and synchronous scripts in the head. */
function renderBlockingUrls(html: string, baseUrl: string): readonly string[] {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html)?.[1] ?? html;
  const urls: string[] = [];

  for (const tag of findTags(head, 'link')) {
    const rel = tag.attributes.get('rel')?.toLowerCase();
    const href = tag.attributes.get('href');
    // `media="print"` and preloads do not block the first paint.
    const media = tag.attributes.get('media')?.toLowerCase();
    if (rel !== 'stylesheet' || !href) continue;
    if (media !== undefined && media !== 'all' && media !== 'screen') continue;

    const resolved = resolve(href, baseUrl);
    if (resolved) urls.push(resolved);
  }

  for (const tag of findTags(head, 'script')) {
    const src = tag.attributes.get('src');
    if (!src) continue;
    // `async` and `defer` scripts explicitly do not block rendering.
    if (tag.attributes.has('async') || tag.attributes.has('defer')) continue;
    if (tag.attributes.get('type')?.toLowerCase() === 'module') continue;

    const resolved = resolve(src, baseUrl);
    if (resolved) urls.push(resolved);
  }

  return [...new Set(urls)].slice(0, MAX_SUBRESOURCES);
}

function resolve(href: string, baseUrl: string): string | null {
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function createSyntheticProvider(): PerformanceProvider {
  return {
    name: 'synthetic',
    // Always available: it needs nothing but the ability to make a request.
    available: true,

    async measure(options: PerformanceMeasureOptions): Promise<PerformanceOutcome> {
      const document = await fetchPage(options.url, {
        timeoutMs: options.timeoutMs,
        maxRedirects: 5,
        allowLoopback: options.allowLoopback,
        userAgent: options.userAgent,
        maxBytes: MAX_DOCUMENT_BYTES,
      });

      if (!document.ok) return { ok: false, reason: document.reason };

      if (document.page.statusCode >= 400) {
        return {
          ok: false,
          reason: `The page responded with HTTP ${String(document.page.statusCode)}.`,
        };
      }

      const blocking = renderBlockingUrls(document.page.body, document.page.finalUrl);
      const { bytes: subresourceBytes, count: fetchedCount } = await weighSubresources(
        blocking,
        options,
      );

      const totalBytes = document.page.byteLength + subresourceBytes;
      const requestCount = 1 + fetchedCount;

      const score = Math.round(
        dimensionScore(
          document.page.timeToFirstByteMs,
          SCORING.timeToFirstByte.good,
          SCORING.timeToFirstByte.poor,
        ) *
          SCORING.timeToFirstByte.weight +
          dimensionScore(
            document.page.totalTimeMs,
            SCORING.totalTime.good,
            SCORING.totalTime.poor,
          ) *
            SCORING.totalTime.weight +
          dimensionScore(totalBytes, SCORING.totalBytes.good, SCORING.totalBytes.poor) *
            SCORING.totalBytes.weight +
          dimensionScore(
            blocking.length,
            SCORING.blockingResources.good,
            SCORING.blockingResources.poor,
          ) *
            SCORING.blockingResources.weight,
      );

      const data: PerformanceCheckData = {
        performanceScore: score,
        // Null, not zero and not a guess: these need a rendered page, and this
        // provider does not have one.
        accessibilityScore: null,
        bestPracticesScore: null,
        seoScore: null,
        firstContentfulPaintMs: null,
        largestContentfulPaintMs: null,
        totalBlockingTimeMs: null,
        cumulativeLayoutShift: null,
        speedIndexMs: null,
        timeToFirstByteMs: document.page.timeToFirstByteMs,
        totalBytes,
        requestCount,
        source: 'synthetic',
        strategy: options.strategy,
      };

      return { ok: true, data };
    },
  };
}

/**
 * Fetches the render-blocking subresources to find their combined weight.
 *
 * Sequential and capped. Firing fifteen concurrent requests at a customer's
 * origin to measure how slow it is would be measuring our own load, and a
 * subresource that fails is simply not counted rather than failing the run —
 * a missing stylesheet is the SEO monitor's business, not this one's.
 */
async function weighSubresources(
  urls: readonly string[],
  options: PerformanceMeasureOptions,
): Promise<{ bytes: number; count: number }> {
  if (urls.length === 0) return { bytes: 0, count: 0 };

  const dispatcher = createGuardedDispatcher({
    timeoutMs: SUBRESOURCE_TIMEOUT_MS,
    allowLoopback: options.allowLoopback,
  });

  let bytes = 0;
  let count = 0;

  try {
    for (const url of urls) {
      const outcome = await fetchPage(url, {
        timeoutMs: SUBRESOURCE_TIMEOUT_MS,
        maxRedirects: 3,
        allowLoopback: options.allowLoopback,
        userAgent: options.userAgent,
        maxBytes: MAX_DOCUMENT_BYTES,
        accept: '*/*',
        dispatcher,
      });

      if (!outcome.ok || outcome.page.statusCode >= 400) continue;

      bytes += outcome.page.byteLength;
      count += 1;
    }
  } finally {
    await closeDispatcher(dispatcher);
  }

  return { bytes, count };
}
