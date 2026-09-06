import type { Types } from 'mongoose';

import type {
  ContentCheckData,
  ContentMonitorConfig,
  MonitorFinding,
} from '../../contracts/index.js';
import {
  CHANGE_THRESHOLD,
  DEFAULT_CONTENT_CONFIG,
  MAX_STORED_CONTENT_LINES,
  MAX_STORED_LINE_LENGTH,
} from '../../contracts/index.js';
import { MonitorResultModel } from '../../models/index.js';
import { diffContent, normalizeContent, summariseDiff } from '../html/content-normalizer.js';
import {
  monitorError,
  type MonitorRunContext,
  type MonitorRunResult,
  type MonitorRunner,
} from '../monitor-runner.js';
import { fetchPage } from '../safe-request.js';

/**
 * The website change monitor.
 *
 * Compares each fetch against the previous one, after normalization strips
 * everything known to change on its own — timestamps, tokens, counters,
 * tracking parameters, scripts, and whatever the user asked to ignore. See
 * `content-normalizer.ts` for the full list; that module is where the value of
 * this feature actually lives.
 *
 * A detected change is `warning`, never `failing`. A changed page is
 * information, not a fault: somebody probably meant to change it. Reporting it
 * as a failure would put a red mark on a website whose owner just published a
 * blog post.
 *
 * The previous state comes from the last stored result rather than from a
 * separate baseline document. That means the baseline moves forward with every
 * run, so a change is reported once and the next run compares against the new
 * content — the alternative, a pinned baseline, alerts on every run forever
 * until somebody clears it.
 */

const MAX_PAGE_BYTES = 3 * 1024 * 1024;

const EMPTY_DATA: ContentCheckData = {
  contentHash: '',
  previousHash: null,
  changed: false,
  changeRatio: null,
  normalizedLength: 0,
  addedLineCount: 0,
  removedLineCount: 0,
  excerpt: null,
  lines: [],
};

/**
 * Caps the stored lines on both axes.
 *
 * Without this, one watched page with a minified inline blob would write a
 * multi-megabyte document on every run, and the collection the TTL index exists
 * to bound would grow faster than it expires.
 */
function boundLines(lines: readonly string[]): readonly string[] {
  return lines
    .slice(0, MAX_STORED_CONTENT_LINES)
    .map((line) =>
      line.length > MAX_STORED_LINE_LENGTH ? line.slice(0, MAX_STORED_LINE_LENGTH) : line,
    );
}

function configOf(context: MonitorRunContext): ContentMonitorConfig {
  const config = context.monitor.config;
  return config.type === 'content' ? config : DEFAULT_CONTENT_CONFIG;
}

/** The lines the previous run recorded, for the diff. */
export interface PreviousContent {
  readonly hash: string;
  readonly lines: readonly string[];
}

export interface ContentRunnerOptions {
  /**
   * Reads the previous run's normalized content.
   *
   * Injected so the runner can be tested without a database — the diffing and
   * threshold logic is the part worth testing, and it has nothing to do with
   * how the previous state is stored.
   */
  readonly readPrevious?: (monitorId: Types.ObjectId) => Promise<PreviousContent | null>;
}

/**
 * The previous run's content, from the last stored result.
 *
 * Reading the last result rather than keeping a separate baseline document is
 * what makes the baseline move forward: a change is reported once, and the next
 * run compares against the new content. A pinned baseline would re-alert on
 * every run until somebody cleared it.
 *
 * A result written before `lines` existed, or one whose lines were truncated
 * away, yields an empty list. The hash comparison still detects the change; only
 * the line-level explanation is missing, which is the right way round.
 */
async function readPreviousFromResults(monitorId: Types.ObjectId): Promise<PreviousContent | null> {
  const latest = await MonitorResultModel.findOne({ monitorId, type: 'content' })
    .sort({ checkedAt: -1 })
    .select({ data: 1 })
    .lean<{ data: { contentHash?: unknown; lines?: unknown } }>()
    .exec();

  const hash = latest?.data.contentHash;
  if (typeof hash !== 'string' || hash.length === 0) return null;

  const lines = Array.isArray(latest?.data.lines)
    ? latest.data.lines.filter((line): line is string => typeof line === 'string')
    : [];

  return { hash, lines };
}

export function createContentRunner(options: ContentRunnerOptions = {}): MonitorRunner {
  const readPrevious = options.readPrevious ?? readPreviousFromResults;

  return {
    type: 'content',

    async run(context: MonitorRunContext): Promise<MonitorRunResult> {
      const config = configOf(context);

      const outcome = await fetchPage(context.monitor.websiteUrl, {
        timeoutMs: context.timeoutMs,
        maxRedirects: 5,
        allowLoopback: context.allowLoopback,
        userAgent: context.userAgent,
        maxBytes: MAX_PAGE_BYTES,
      });

      if (!outcome.ok) {
        return monitorError(outcome.reason, { type: 'content', ...EMPTY_DATA });
      }
      if (outcome.page.statusCode >= 400) {
        return monitorError(`The page responded with HTTP ${String(outcome.page.statusCode)}.`, {
          type: 'content',
          ...EMPTY_DATA,
        });
      }

      const current = normalizeContent(outcome.page.body, {
        ignoreSelectors: config.ignoreSelectors,
        watchSelector: config.watchSelector,
      });

      const findings: MonitorFinding[] = [];

      if (current.selectorMissed) {
        // Surfaced rather than silently comparing the whole page instead: a
        // selector that stopped matching after a redesign would otherwise turn
        // into a permanent stream of false changes with no explanation.
        findings.push({
          code: 'content.selector_missed',
          severity: 'warning',
          message: 'The element being watched was not found, so the whole page was compared.',
          detail: config.watchSelector,
        });
      }

      const previous = await readPrevious(context.monitor.id);

      if (previous === null) {
        // The first run establishes the baseline. Reporting a change here would
        // alert on every newly enabled monitor.
        return {
          status: 'passing',
          summary: 'Baseline recorded. Changes will be reported from the next check.',
          data: {
            type: 'content',
            ...EMPTY_DATA,
            contentHash: current.hash,
            normalizedLength: current.text.length,
            lines: boundLines(current.lines),
          },
          findings,
        };
      }

      const identical = previous.hash === current.hash;
      const diff = identical
        ? { ratio: 0, addedLines: [], removedLines: [] }
        : diffContent(previous.lines, current.lines);

      const threshold = CHANGE_THRESHOLD[config.sensitivity];
      /*
       * The hash decides *whether* anything changed; the ratio decides whether
       * it is worth reporting. A hash difference below the sensitivity
       * threshold is a real but immaterial change — a rotating testimonial on a
       * page watched at "only large changes".
       */
      const material = !identical && diff.ratio >= threshold;

      const data: ContentCheckData = {
        contentHash: current.hash,
        previousHash: previous.hash,
        changed: material,
        changeRatio: identical ? 0 : diff.ratio,
        normalizedLength: current.text.length,
        addedLineCount: diff.addedLines.length,
        removedLineCount: diff.removedLines.length,
        excerpt: material ? summariseDiff(diff) : null,
        lines: boundLines(current.lines),
      };

      if (material) {
        findings.push({
          code: 'content.changed',
          severity: 'notice',
          message: `${String(Math.round(diff.ratio * 100))}% of the page changed: ${String(diff.addedLines.length)} lines added, ${String(diff.removedLines.length)} removed.`,
          detail: summariseDiff(diff, 200),
        });
      }

      return {
        // A changed page is information, not a fault. Somebody probably meant
        // to change it.
        status: material ? 'warning' : 'passing',
        summary: material
          ? `Content changed: ${String(diff.addedLines.length)} lines added, ${String(diff.removedLines.length)} removed.`
          : identical
            ? 'No change since the last check.'
            : `Only minor changes (${String(Math.round(diff.ratio * 100))}%), below your sensitivity setting.`,
        data: { type: 'content', ...data },
        findings,
      };
    },
  };
}
