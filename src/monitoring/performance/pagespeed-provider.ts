import { request } from 'undici';

import type { PerformanceCheckData } from '../../contracts/index.js';
import type {
  PerformanceMeasureOptions,
  PerformanceOutcome,
  PerformanceProvider,
} from './performance-provider.js';

/**
 * Real Lighthouse scores, via Google's PageSpeed Insights API.
 *
 * Google runs Lighthouse in a real Chrome on their own infrastructure and
 * returns the full report. That gives genuine performance, accessibility,
 * best-practices and SEO scores and genuine Core Web Vitals, with no browser to
 * ship, patch or pay for on our side.
 *
 * The trade-offs are real and worth knowing:
 *
 *  - It is rate-limited (25,000 requests a day with a key), which is why the
 *    monitor's default cadence is daily rather than hourly.
 *  - Google must be able to reach the URL, so it cannot measure a staging site
 *    behind a firewall. Those fall back to the synthetic provider.
 *  - A run takes 10–40 seconds, which is why the performance monitor's timeout
 *    is 90 seconds and its concurrency is 2.
 *
 * No address guard is applied to *our* request here: it goes to
 * `googleapis.com`, not to the customer's site. Google fetches the target,
 * which also means this path cannot be used for SSRF against our own network —
 * the only thing that reaches the customer's URL is Google.
 */

const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The categories requested. All four are returned in one run. */
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'] as const;

interface LighthouseAudit {
  readonly numericValue?: unknown;
}

interface LighthouseCategory {
  readonly score?: unknown;
}

interface LighthouseResult {
  readonly categories?: Record<string, LighthouseCategory | undefined>;
  readonly audits?: Record<string, LighthouseAudit | undefined>;
}

interface PageSpeedResponse {
  readonly lighthouseResult?: LighthouseResult;
  readonly error?: { readonly message?: unknown };
}

/** Lighthouse category scores are 0–1; the product reports 0–100. */
function scoreOf(result: LighthouseResult, category: string): number | null {
  const score = result.categories?.[category]?.score;
  return typeof score === 'number' ? Math.round(score * 100) : null;
}

function auditValue(result: LighthouseResult, audit: string): number | null {
  const value = result.audits?.[audit]?.numericValue;
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

/** CLS is unitless and small, so it keeps its decimals where the others do not. */
function auditRatio(result: LighthouseResult, audit: string): number | null {
  const value = result.audits?.[audit]?.numericValue;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1000) / 1000
    : null;
}

export interface PageSpeedProviderOptions {
  readonly apiKey: string | undefined;
  /** Overridden in tests to point at a stub. */
  readonly endpoint?: string;
}

export function createPageSpeedProvider(options: PageSpeedProviderOptions): PerformanceProvider {
  const endpoint = options.endpoint ?? ENDPOINT;
  const apiKey = options.apiKey;

  return {
    name: 'pagespeed',
    // Without a key the API allows a handful of anonymous requests an hour and
    // then rejects everything, which would present as an intermittently broken
    // monitor. Better to report the provider as unavailable and fall through.
    available: apiKey !== undefined && apiKey.length > 0,

    async measure(measureOptions: PerformanceMeasureOptions): Promise<PerformanceOutcome> {
      if (apiKey === undefined || apiKey.length === 0) {
        return { ok: false, reason: 'No PageSpeed API key is configured.' };
      }

      const query = new URLSearchParams({
        url: measureOptions.url,
        strategy: measureOptions.strategy,
        key: apiKey,
      });
      for (const category of CATEGORIES) query.append('category', category);

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, measureOptions.timeoutMs);

      try {
        const response = await request(`${endpoint}?${query.toString()}`, {
          method: 'GET',
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });

        const text = await readBounded(response.body);
        if (text === null) {
          return { ok: false, reason: 'The PageSpeed response was too large to read.' };
        }

        if (response.statusCode !== 200) {
          // The key never appears in a log line: it is a credential, and the
          // query string it lives in is exactly the thing that gets logged.
          return {
            ok: false,
            reason: `PageSpeed responded with HTTP ${String(response.statusCode)}.`,
          };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return { ok: false, reason: 'The PageSpeed response was not valid JSON.' };
        }

        const body = parsed as PageSpeedResponse;
        const result = body.lighthouseResult;

        if (!result) {
          const message = typeof body.error?.message === 'string' ? body.error.message : null;
          return { ok: false, reason: message ?? 'PageSpeed returned no Lighthouse result.' };
        }

        const data: PerformanceCheckData = {
          performanceScore: scoreOf(result, 'performance'),
          accessibilityScore: scoreOf(result, 'accessibility'),
          bestPracticesScore: scoreOf(result, 'best-practices'),
          seoScore: scoreOf(result, 'seo'),
          firstContentfulPaintMs: auditValue(result, 'first-contentful-paint'),
          largestContentfulPaintMs: auditValue(result, 'largest-contentful-paint'),
          totalBlockingTimeMs: auditValue(result, 'total-blocking-time'),
          cumulativeLayoutShift: auditRatio(result, 'cumulative-layout-shift'),
          speedIndexMs: auditValue(result, 'speed-index'),
          timeToFirstByteMs: auditValue(result, 'server-response-time'),
          totalBytes: auditValue(result, 'total-byte-weight'),
          requestCount: null,
          source: 'pagespeed',
          strategy: measureOptions.strategy,
        };

        return { ok: true, data };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return { ok: false, reason: 'The PageSpeed run timed out.' };
        }
        return {
          ok: false,
          reason: error instanceof Error ? error.message : 'The PageSpeed request failed.',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** A full Lighthouse report is large; this caps it rather than trusting it. */
async function readBounded(body: NodeJS.ReadableStream): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_RESPONSE_BYTES) return null;
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}
