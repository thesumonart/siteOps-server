import type { PerformanceCheckData } from '../../contracts/index.js';

/**
 * Where performance numbers come from.
 *
 * **This is the honest version of "Lighthouse monitoring", and the distinction
 * matters enough to state at the top of the file.**
 *
 * Real Lighthouse scores and real Core Web Vitals require running Chrome
 * against the page. SiteOps does not bundle a browser: a headless Chrome per
 * worker is hundreds of megabytes of image, a gigabyte of RAM per concurrent
 * run and a second thing to patch, and it would make the worker undeployable on
 * the class of host this product targets.
 *
 * So there are two providers, and the result always says which one produced it:
 *
 *  - **`pagespeed`** — Google's PageSpeed Insights API, which runs real
 *    Lighthouse on Google's infrastructure and returns genuine performance,
 *    accessibility, best-practices and SEO scores plus real Core Web Vitals.
 *    Used when `PAGESPEED_API_KEY` is configured. This is the recommended
 *    setup and the one the documentation points at.
 *  - **`synthetic`** — server-side measurement of what a fetch can honestly
 *    measure: time to first byte, total transfer time, document size, and the
 *    count and weight of render-blocking subresources. It reports **no**
 *    Lighthouse score and **no** LCP or CLS, because it cannot know them, and
 *    returning a plausible-looking invented number would be worse than
 *    returning null.
 *
 * A monitor configured with no API key still works and still catches the thing
 * that matters most in practice — a site that got slower — it simply reports
 * fewer fields and says so.
 */

export interface PerformanceMeasureOptions {
  readonly url: string;
  readonly strategy: 'mobile' | 'desktop';
  readonly timeoutMs: number;
  readonly allowLoopback: boolean;
  readonly userAgent: string;
}

export type PerformanceOutcome =
  | { readonly ok: true; readonly data: PerformanceCheckData }
  | { readonly ok: false; readonly reason: string };

export interface PerformanceProvider {
  readonly name: string;
  /** False when the provider is not configured, so the caller can fall back. */
  readonly available: boolean;
  measure(options: PerformanceMeasureOptions): Promise<PerformanceOutcome>;
}

/**
 * Tries each provider in order and returns the first usable answer.
 *
 * A configured provider that fails falls through to the next rather than
 * failing the run: a Google API outage should degrade the monitor to synthetic
 * measurement, not silence it.
 */
export async function measurePerformance(
  providers: readonly PerformanceProvider[],
  options: PerformanceMeasureOptions,
): Promise<PerformanceOutcome> {
  let lastReason = 'No performance provider is available.';

  for (const provider of providers) {
    if (!provider.available) continue;

    const outcome = await provider.measure(options);
    if (outcome.ok) return outcome;
    lastReason = `${provider.name}: ${outcome.reason}`;
  }

  return { ok: false, reason: lastReason };
}
