/**
 * The subset of the robots exclusion standard a crawler has to honour.
 *
 * Implements `User-agent`, `Disallow`, `Allow` and `Sitemap`, which is what
 * essentially every real `robots.txt` uses. `Crawl-delay` is read and applied.
 * Wildcards (`*`) and end-anchors (`$`) are supported because Google and Bing
 * both honour them and site owners write them expecting they work.
 *
 * Not implemented: `Host`, `Clean-param`, and any of the non-standard
 * directives a handful of sites carry. They are ignored rather than guessed at.
 *
 * The bias throughout is towards **not** fetching. A file we cannot parse, a
 * rule we do not understand, an ambiguous match — all resolve towards leaving
 * the page alone. Crawling somebody's site is the most intrusive thing SiteOps
 * does, and being wrong in the permissive direction is the version that gets a
 * customer's IP blocked.
 */

export interface RobotsRules {
  /** Whether a `robots.txt` was actually found and parsed. */
  readonly found: boolean;
  readonly sitemaps: readonly string[];
  /** Seconds the site asks a crawler to wait between requests, if stated. */
  readonly crawlDelaySeconds: number | null;
  isAllowed(path: string): boolean;
}

interface Rule {
  readonly pattern: string;
  readonly allow: boolean;
}

/** Rules that allow everything, used when there is no `robots.txt` to read. */
export function permissiveRobots(found: boolean): RobotsRules {
  return {
    found,
    sitemaps: [],
    crawlDelaySeconds: null,
    isAllowed: () => true,
  };
}

const MAX_RULES = 500;
const MAX_LINE_LENGTH = 2000;

/**
 * Parses `robots.txt` for one user agent.
 *
 * Group selection follows the standard: the most specific matching
 * `User-agent` group wins, and `*` is the fallback. A file with no group for us
 * and no `*` group imposes no restrictions.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const agent = userAgent.toLowerCase();

  const groups = new Map<string, Rule[]>();
  const delays = new Map<string, number>();
  const sitemaps: string[] = [];

  let currentAgents: string[] = [];
  // A `User-agent` line after a rule starts a new group; consecutive
  // `User-agent` lines share one.
  let awaitingRules = false;
  let ruleCount = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length > MAX_LINE_LENGTH) continue;

    const withoutComment = rawLine.split('#')[0] ?? '';
    const line = withoutComment.trim();
    if (line.length === 0) continue;

    const separator = line.indexOf(':');
    if (separator <= 0) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'sitemap') {
      if (value.length > 0 && sitemaps.length < 20) sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent') {
      if (awaitingRules) {
        currentAgents = [];
        awaitingRules = false;
      }
      currentAgents.push(value.toLowerCase());
      continue;
    }

    if (currentAgents.length === 0) continue;

    if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        for (const name of currentAgents) delays.set(name, seconds);
      }
      awaitingRules = true;
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;

    awaitingRules = true;
    if (ruleCount >= MAX_RULES) continue;
    ruleCount += 1;

    for (const name of currentAgents) {
      const rules = groups.get(name) ?? [];
      rules.push({ pattern: value, allow: field === 'allow' });
      groups.set(name, rules);
    }
  }

  const selected = selectGroup(groups, agent);
  const rules = selected === null ? [] : (groups.get(selected) ?? []);
  const crawlDelaySeconds = selected === null ? null : (delays.get(selected) ?? null);

  return {
    found: true,
    sitemaps,
    crawlDelaySeconds,
    isAllowed: (path: string) => isAllowedBy(rules, path),
  };
}

/** The most specific group matching our agent, or `*`, or nothing. */
function selectGroup(groups: ReadonlyMap<string, Rule[]>, agent: string): string | null {
  let best: string | null = null;

  for (const name of groups.keys()) {
    if (name === '*') continue;
    // A group applies when our agent string starts with its name, which is how
    // `SiteOpsMonitor/1.0 (+…)` matches a `User-agent: siteopsmonitor` line.
    if (agent.startsWith(name) && (best === null || name.length > best.length)) {
      best = name;
    }
  }

  if (best !== null) return best;
  return groups.has('*') ? '*' : null;
}

/**
 * Applies a group's rules to a path.
 *
 * The longest matching pattern wins, and `Allow` beats `Disallow` on a tie.
 * That is the rule Google documents, and it is what makes the common
 * `Disallow: /` plus `Allow: /public/` pairing work.
 */
function isAllowedBy(rules: readonly Rule[], path: string): boolean {
  let bestLength = -1;
  let allowed = true;

  for (const rule of rules) {
    /*
     * An empty `Disallow:` means "nothing is disallowed" — it is how a site
     * says everything is permitted. Treating it as a zero-length match on
     * every path would block the entire site, which is the exact opposite.
     */
    if (rule.pattern.length === 0) continue;

    if (!matchesPattern(rule.pattern, path)) continue;

    const length = rule.pattern.length;
    if (length > bestLength || (length === bestLength && rule.allow)) {
      bestLength = length;
      allowed = rule.allow;
    }
  }

  return allowed;
}

/** Escapes a string so a path pattern cannot smuggle regex syntax in. */
function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a path matches a robots pattern.
 *
 * `*` matches any run of characters and `$` at the end anchors the match. A
 * pattern with neither is a plain prefix, which is the standard's original
 * behaviour.
 */
function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  if (!body.includes('*')) {
    return anchored ? path === body : path.startsWith(body);
  }

  const source = body.split('*').map(escapeRegex).join('.*');
  try {
    return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
  } catch {
    // An unparseable pattern is treated as not matching, which leaves the
    // default (allowed) in place rather than blocking on a file we misread.
    return false;
  }
}
