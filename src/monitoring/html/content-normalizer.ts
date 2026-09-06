import { createHash } from 'node:crypto';

import { extractText, extractTextLines, selectRegion, stripSelectors } from './parse.js';

/**
 * Turning a page into something that can be compared between two days.
 *
 * The whole difficulty of change detection is that almost every page differs
 * from itself on every fetch, and almost none of those differences mean
 * anything. A monitor that reports them all is worse than no monitor: people
 * turn it off within a week, and then it is not there when the pricing page
 * really does change.
 *
 * So the input is normalized aggressively before it is hashed, and each step
 * below removes a category of difference that is known to be noise. The rules
 * are listed rather than buried, because "why did it not tell me about X" is
 * the question this feature has to be able to answer.
 */

/**
 * Patterns replaced with a fixed token before hashing.
 *
 * Each is a thing that changes on its own between two fetches of an unchanged
 * page. Replaced rather than deleted so the surrounding text does not close up
 * — a deletion would join the words either side and register as an edit.
 */
const VOLATILE_PATTERNS: readonly { readonly pattern: RegExp; readonly token: string }[] = [
  // ISO timestamps, and the date-time forms most templates render.
  {
    pattern: /\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?\b/g,
    token: '«date»',
  },
  { pattern: /\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm|AM|PM)?\b/g, token: '«time»' },
  // "2 minutes ago", "updated 3 hours ago" — a relative timestamp changes on
  // every single fetch by construction.
  {
    pattern: /\b\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/gi,
    token: '«ago»',
  },
  // CSRF tokens, cache-busting hashes and build ids embedded in the markup.
  { pattern: /\b[0-9a-f]{32,}\b/gi, token: '«hash»' },
  {
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    token: '«uuid»',
  },
  // A visitor or view counter.
  { pattern: /\b\d{1,3}(,\d{3})+\b/g, token: '«number»' },
];

/** Query parameters stripped from any URL that survives into the text. */
const TRACKING_PARAMETERS = /\b(utm_[a-z]+|fbclid|gclid|msclkid|mc_eid|_ga)=[^\s&"']*/gi;

/**
 * Elements dropped from every page before comparison, on top of whatever the
 * user configured.
 *
 * These carry no page content by definition and are the usual home of a
 * rotating advert or a session-specific script tag.
 */
const ALWAYS_IGNORED: readonly string[] = ['script', 'style', 'noscript', 'svg', 'iframe'];

export interface NormalizedContent {
  /** SHA-256 of the normalized text. Comparing hashes is the change check. */
  readonly hash: string;
  readonly text: string;
  readonly lines: readonly string[];
  /**
   * Set when a `watchSelector` was configured and matched nothing. The caller
   * reports this rather than silently comparing the whole page instead — a
   * selector that stopped matching after a redesign should be visible.
   */
  readonly selectorMissed: boolean;
}

export interface NormalizeOptions {
  readonly ignoreSelectors: readonly string[];
  readonly watchSelector: string | null;
}

export function normalizeContent(html: string, options: NormalizeOptions): NormalizedContent {
  const region = options.watchSelector === null ? html : selectRegion(html, options.watchSelector);
  const selectorMissed = options.watchSelector !== null && region === null;

  const scoped = region ?? html;
  const stripped = stripSelectors(scoped, [...ALWAYS_IGNORED, ...options.ignoreSelectors]);

  const text = stabilise(extractText(stripped));
  const lines = extractTextLines(stripped).map((line) => stabilise(line));

  return {
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
    lines,
    selectorMissed,
  };
}

/** Replaces every known-volatile pattern with its token. */
function stabilise(text: string): string {
  let result = text.replace(TRACKING_PARAMETERS, '');
  for (const { pattern, token } of VOLATILE_PATTERNS) {
    result = result.replace(pattern, token);
  }
  return result.replace(/\s+/g, ' ').trim();
}

export interface ContentDiff {
  /** Share of lines that differ, 0–1. */
  readonly ratio: number;
  readonly addedLines: readonly string[];
  readonly removedLines: readonly string[];
}

/**
 * How much two normalized documents differ, at line granularity.
 *
 * A multiset comparison rather than a longest-common-subsequence diff. LCS
 * would give a prettier per-line result, but the question here is only "how
 * much of this page is different", and reordering a navigation menu is not a
 * content change — a set comparison is both cheaper and, for this purpose,
 * more correct.
 *
 * Counting is by *occurrence*, not by distinct line: a page listing the same
 * item three times and then twice has changed, and a plain `Set` would miss it.
 */
export function diffContent(
  previousLines: readonly string[],
  currentLines: readonly string[],
): ContentDiff {
  const previousCounts = countLines(previousLines);
  const currentCounts = countLines(currentLines);

  const added: string[] = [];
  const removed: string[] = [];

  for (const [line, count] of currentCounts) {
    const before = previousCounts.get(line) ?? 0;
    for (let index = 0; index < count - before; index += 1) added.push(line);
  }

  for (const [line, count] of previousCounts) {
    const after = currentCounts.get(line) ?? 0;
    for (let index = 0; index < count - after; index += 1) removed.push(line);
  }

  const total = Math.max(previousLines.length, currentLines.length);
  // An empty page that stays empty has not changed; without this guard the
  // ratio would be 0/0.
  const ratio = total === 0 ? 0 : (added.length + removed.length) / (total * 2);

  return { ratio: Math.min(1, ratio), addedLines: added, removedLines: removed };
}

function countLines(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** A short, bounded description of what changed, for the alert body. */
export function summariseDiff(diff: ContentDiff, maxLength = 300): string | null {
  const sample = [
    ...diff.addedLines.slice(0, 3).map((line) => `+ ${line}`),
    ...diff.removedLines.slice(0, 3).map((line) => `- ${line}`),
  ];
  if (sample.length === 0) return null;

  const joined = sample.join('\n');
  return joined.length > maxLength ? `${joined.slice(0, maxLength - 1)}…` : joined;
}
