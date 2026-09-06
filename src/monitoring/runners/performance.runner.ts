import type {
  MonitorFinding,
  PerformanceCheckData,
  PerformanceMonitorConfig,
} from '../../contracts/index.js';
import { DEFAULT_PERFORMANCE_CONFIG } from '../../contracts/index.js';
import {
  monitorError,
  type MonitorRunContext,
  type MonitorRunResult,
  type MonitorRunner,
} from '../monitor-runner.js';
import {
  measurePerformance,
  type PerformanceProvider,
} from '../performance/performance-provider.js';

/**
 * The performance monitor.
 *
 * Thresholds are compared only against fields the provider actually returned. A
 * synthetic run has no Largest Contentful Paint, and treating a null as "under
 * the threshold" would report a page as fast on the basis of a measurement that
 * was never taken.
 */

const EMPTY_DATA: Omit<PerformanceCheckData, 'strategy'> = {
  performanceScore: null,
  accessibilityScore: null,
  bestPracticesScore: null,
  seoScore: null,
  firstContentfulPaintMs: null,
  largestContentfulPaintMs: null,
  totalBlockingTimeMs: null,
  cumulativeLayoutShift: null,
  speedIndexMs: null,
  timeToFirstByteMs: null,
  totalBytes: null,
  requestCount: null,
  source: 'none',
};

/** Google's "poor" boundary for Cumulative Layout Shift. */
const CLS_POOR = 0.25;

function configOf(context: MonitorRunContext): PerformanceMonitorConfig {
  const config = context.monitor.config;
  return config.type === 'performance' ? config : DEFAULT_PERFORMANCE_CONFIG;
}

export interface PerformanceRunnerOptions {
  /** Tried in order; the first available one that succeeds wins. */
  readonly providers: readonly PerformanceProvider[];
}

export function createPerformanceRunner(options: PerformanceRunnerOptions): MonitorRunner {
  return {
    type: 'performance',

    async run(context: MonitorRunContext): Promise<MonitorRunResult> {
      const config = configOf(context);

      const outcome = await measurePerformance(options.providers, {
        url: context.monitor.websiteUrl,
        strategy: config.strategy,
        timeoutMs: context.timeoutMs,
        allowLoopback: context.allowLoopback,
        userAgent: context.userAgent,
      });

      if (!outcome.ok) {
        return monitorError(outcome.reason, {
          type: 'performance',
          ...EMPTY_DATA,
          strategy: config.strategy,
        });
      }

      const data = outcome.data;
      const findings: MonitorFinding[] = [];
      let status: 'passing' | 'warning' = 'passing';

      if (data.performanceScore !== null && data.performanceScore < config.minPerformanceScore) {
        findings.push({
          code: 'performance.score_below_threshold',
          severity: data.performanceScore < config.minPerformanceScore / 2 ? 'critical' : 'warning',
          message: `The performance score is ${String(data.performanceScore)}, below your threshold of ${String(config.minPerformanceScore)}.`,
          detail: `Measured by ${data.source} as ${data.strategy}`,
        });
        status = 'warning';
      }

      if (
        data.largestContentfulPaintMs !== null &&
        data.largestContentfulPaintMs > config.maxLargestContentfulPaintMs
      ) {
        findings.push({
          code: 'performance.lcp_above_threshold',
          severity: 'warning',
          message: `Largest Contentful Paint is ${formatMs(data.largestContentfulPaintMs)}, above your threshold of ${formatMs(config.maxLargestContentfulPaintMs)}.`,
          detail: null,
        });
        status = 'warning';
      }

      if (data.cumulativeLayoutShift !== null && data.cumulativeLayoutShift > CLS_POOR) {
        findings.push({
          code: 'performance.layout_shift',
          severity: 'warning',
          message: `Cumulative Layout Shift is ${String(data.cumulativeLayoutShift)}, in the range Google classes as poor.`,
          detail: 'Content moves while the page loads.',
        });
        status = 'warning';
      }

      /*
       * Only reported when the provider gave no score of its own. With a
       * Lighthouse score present, a slow first byte is already reflected in it,
       * and saying so twice is noise.
       */
      if (
        data.performanceScore === null &&
        data.timeToFirstByteMs !== null &&
        data.timeToFirstByteMs > 1_200
      ) {
        findings.push({
          code: 'performance.slow_first_byte',
          severity: 'warning',
          message: `The server took ${formatMs(data.timeToFirstByteMs)} to send the first byte.`,
          detail: null,
        });
        status = 'warning';
      }

      return {
        status,
        summary: summarise(data),
        data: { type: 'performance', ...data },
        findings,
      };
    },
  };
}

function formatMs(value: number): string {
  return value < 1000 ? `${String(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

function summarise(data: PerformanceCheckData): string {
  const parts: string[] = [];

  if (data.performanceScore !== null) parts.push(`Score ${String(data.performanceScore)}`);
  if (data.largestContentfulPaintMs !== null) {
    parts.push(`LCP ${formatMs(data.largestContentfulPaintMs)}`);
  }
  if (data.timeToFirstByteMs !== null) parts.push(`TTFB ${formatMs(data.timeToFirstByteMs)}`);
  if (data.totalBytes !== null) parts.push(`${(data.totalBytes / 1_048_576).toFixed(2)} MB`);

  // The source is always named, so nobody mistakes a synthetic score for a
  // Lighthouse one.
  return parts.length > 0
    ? `${parts.join(' · ')} (${data.source})`
    : `Measured by ${data.source}, no scores returned.`;
}
