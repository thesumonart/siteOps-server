import { request } from 'undici';

import { createLogger } from '../../utils/logger.js';

/**
 * Reference data that domain lookups depend on, fetched once and cached.
 *
 * Two of the three things needed to look a domain up correctly are published
 * documents rather than protocols: IANA's RDAP bootstrap registry says which
 * server is authoritative for a TLD, and the Public Suffix List says where a
 * registrable name actually begins. Both are large, both change slowly, and
 * both are wrong to bundle — a copy in the repository is stale the day after it
 * is committed, and a new TLD then looks like a lookup failure.
 *
 * So they are fetched at runtime and cached in memory for a day. The important
 * property is that a failed fetch is never fatal: every caller has a documented
 * fallback that is worse but still works, because a domain monitor that stops
 * answering when publicsuffix.org has a bad afternoon is not a monitor.
 */

const logger = createLogger('domain-reference');

/** A day. Both documents change on the order of days, and neither urgently. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a failed fetch is remembered before another is attempted.
 *
 * Without this, every domain check during an outage pays the full timeout
 * again. Short enough that a recovered endpoint is picked up within the hour.
 */
const FAILURE_TTL_MS = 15 * 60 * 1000;

/** The PSL is ~250 KB and the bootstrap ~150 KB; this is generous headroom. */
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 15_000;

/** Identifies SiteOps to the endpoints below, both of which ask for one. */
const USER_AGENT = 'SiteOpsMonitor/1.0 (+https://siteops.app)';

interface CacheEntry<T> {
  readonly value: T | null;
  readonly expiresAt: number;
}

/**
 * A document fetched at most once per TTL, with concurrent callers sharing one
 * request.
 *
 * The in-flight promise matters: the worker starts six monitor types at once,
 * and without it a cold cache would issue six identical 250 KB downloads.
 */
class CachedDocument<T> {
  private entry: CacheEntry<T> | null = null;
  private inFlight: Promise<T | null> | null = null;

  constructor(
    private readonly url: string,
    private readonly parse: (body: string) => T,
    private readonly label: string,
  ) {}

  async get(): Promise<T | null> {
    const now = Date.now();
    if (this.entry && this.entry.expiresAt > now) return this.entry.value;

    this.inFlight ??= this.load().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  /** Test seam: pins a value so a unit test never touches the network. */
  seed(value: T | null, ttlMs = CACHE_TTL_MS): void {
    this.entry = { value, expiresAt: Date.now() + ttlMs };
  }

  private async load(): Promise<T | null> {
    try {
      const body = await fetchTextBounded(this.url);
      const value = this.parse(body);
      this.entry = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      logger.info({ document: this.label }, 'domain_reference.loaded');
      return value;
    } catch (error) {
      // Cached as a null so the next check does not retry immediately, and
      // logged at warn rather than error: every caller degrades rather than
      // fails, so this is a reduction in accuracy, not an outage.
      this.entry = { value: null, expiresAt: Date.now() + FAILURE_TTL_MS };
      logger.warn({ err: error, document: this.label }, 'domain_reference.unavailable');
      return null;
    }
  }
}

async function fetchTextBounded(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  try {
    const response = await request(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/plain, application/json, */*' },
    });

    if (response.statusCode !== 200) {
      await response.body.dump();
      throw new Error(`${url} responded with HTTP ${String(response.statusCode)}.`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buffer.length;
      if (total > MAX_DOCUMENT_BYTES) {
        throw new Error(`${url} exceeded ${String(MAX_DOCUMENT_BYTES)} bytes.`);
      }
      chunks.push(buffer);
    }

    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

/* --- Public Suffix List -------------------------------------------------- */

const PUBLIC_SUFFIX_LIST_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';

/**
 * The parsed list, split the way the algorithm needs to consult it.
 *
 * Sets rather than arrays because the match is by exact rule text, walked from
 * the right one label at a time — an array scan over ten thousand rules per
 * lookup would be the slowest thing in the monitor.
 */
export interface PublicSuffixRules {
  /** Ordinary rules: `com`, `co.uk`. */
  readonly normal: ReadonlySet<string>;
  /** Wildcard rules, stored without the leading `*.`: `ck` for `*.ck`. */
  readonly wildcard: ReadonlySet<string>;
  /** Exception rules, stored without the leading `!`: `www.ck` for `!www.ck`. */
  readonly exception: ReadonlySet<string>;
}

/**
 * Parses the ICANN section of the Public Suffix List, and only that section.
 *
 * The private section lists suffixes that organisations delegate under their
 * own registered name — `github.io`, `vercel.app`, `s3.amazonaws.com`. Those
 * are the right answer for cookie scoping and the wrong one here: nobody
 * *registers* `siteops.vercel.app` at a registrar, so a registration lookup for
 * it would be a guaranteed miss. What is registered is `vercel.app`, which is
 * what the ICANN section yields.
 */
export function parsePublicSuffixList(body: string): PublicSuffixRules {
  const normal = new Set<string>();
  const wildcard = new Set<string>();
  const exception = new Set<string>();

  let inIcannSection = false;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();

    if (line.startsWith('//')) {
      if (line.includes('===BEGIN ICANN DOMAINS===')) inIcannSection = true;
      else if (line.includes('===END ICANN DOMAINS===')) inIcannSection = false;
      continue;
    }

    if (!inIcannSection || line.length === 0) continue;

    // Rules are stored in Unicode in the file; the hostnames compared against
    // them arrive from `new URL()` already punycoded, so both sides are
    // lowercased and the non-ASCII rules simply never match, which is correct.
    const rule = line.toLowerCase();

    if (rule.startsWith('!')) exception.add(rule.slice(1));
    else if (rule.startsWith('*.')) wildcard.add(rule.slice(2));
    else normal.add(rule);
  }

  if (normal.size === 0) {
    throw new Error('The public suffix list contained no ICANN rules.');
  }

  return { normal, wildcard, exception };
}

const publicSuffixDocument = new CachedDocument(
  PUBLIC_SUFFIX_LIST_URL,
  parsePublicSuffixList,
  'public-suffix-list',
);

export async function loadPublicSuffixRules(): Promise<PublicSuffixRules | null> {
  return publicSuffixDocument.get();
}

/** Test seam: pins the rules so a unit test never touches the network. */
export function seedPublicSuffixRules(rules: PublicSuffixRules | null): void {
  publicSuffixDocument.seed(rules);
}

/**
 * The registrable domain for a hostname, per the Public Suffix List algorithm.
 *
 * Returns null when the hostname *is* a public suffix (`co.uk`, `com`) — there
 * is nothing to look up — and when no rule matches at all, which is the
 * caller's signal to fall back to guessing rather than to assume two labels.
 *
 * The algorithm is publicsuffix.org's, implemented in full because the shortcuts
 * are exactly where it goes wrong: the longest matching rule wins, an exception
 * rule beats every wildcard, and an unmatched name defaults to the `*` rule.
 */
export function registrableDomainFrom(hostname: string, rules: PublicSuffixRules): string | null {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length < 2) return null;

  /*
   * An exception rule wins outright, and its own leftmost label is the part
   * that is registrable — `!www.ck` means `www.ck` is a registered name under
   * the `*.ck` wildcard.
   */
  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join('.');
    if (rules.exception.has(candidate)) return candidate;
  }

  // Longest match wins, so the walk starts from the whole name and shortens.
  let suffixLabelCount = 0;
  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join('.');
    const labelCount = labels.length - index;

    if (rules.normal.has(candidate)) {
      suffixLabelCount = Math.max(suffixLabelCount, labelCount);
    }

    /*
     * A wildcard rule `*.ck` matches `anything.ck`, so the suffix is one label
     * longer than the stored `ck`.
     *
     * Evaluated even when the plain rule above already matched, because the
     * list frequently carries both — `ck` *and* `*.ck` — and the wildcard is
     * the longer, therefore prevailing, rule. Skipping it after a plain match
     * makes every second-level name under such a TLD resolve one label short.
     */
    if (index > 0 && rules.wildcard.has(candidate)) {
      suffixLabelCount = Math.max(suffixLabelCount, labelCount + 1);
    }
  }

  // No rule matched. The specification's default is the `*` rule — one label —
  // but applying it silently is how `example.com.bd` becomes `com.bd`. Saying
  // "unknown" instead lets the caller fall back to asking the registry.
  if (suffixLabelCount === 0) return null;

  // The name is itself a public suffix, or shorter than one. Nothing to look up.
  if (suffixLabelCount >= labels.length) return null;

  return labels.slice(labels.length - suffixLabelCount - 1).join('.');
}

/* --- IANA RDAP bootstrap ------------------------------------------------- */

const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

/** TLD (without a dot) to the base URL of its authoritative RDAP service. */
export type RdapBootstrap = ReadonlyMap<string, string>;

interface BootstrapDocument {
  readonly services?: unknown;
}

/**
 * Parses IANA's bootstrap registry into a TLD lookup table.
 *
 * The document's shape is an array of `[[tld, …], [url, …]]` pairs. The first
 * URL is taken; where a registry publishes both, https is preferred, because
 * the alternative is sending a domain query in clear text.
 */
export function parseRdapBootstrap(body: string): RdapBootstrap {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The RDAP bootstrap document was not an object.');
  }

  const services = (parsed as BootstrapDocument).services;
  if (!Array.isArray(services)) {
    throw new Error('The RDAP bootstrap document had no services array.');
  }

  const map = new Map<string, string>();

  for (const service of services as unknown[]) {
    if (!Array.isArray(service) || service.length < 2) continue;
    // Indexed rather than destructured: `JSON.parse` yields `any`, and
    // destructuring it would spread that `any` into two bindings the compiler
    // then stops checking. Both are narrowed on the next line.
    const tlds: unknown = service[0];
    const urls: unknown = service[1];
    if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;

    const secure = urls.find(
      (url): url is string => typeof url === 'string' && url.startsWith('https://'),
    );
    const anyUrl = urls.find((url): url is string => typeof url === 'string');
    const base = (secure ?? anyUrl)?.replace(/\/$/, '');
    if (!base) continue;

    for (const tld of tlds) {
      if (typeof tld === 'string' && tld.length > 0) map.set(tld.toLowerCase(), base);
    }
  }

  if (map.size === 0) throw new Error('The RDAP bootstrap document listed no services.');

  return map;
}

const rdapBootstrapDocument = new CachedDocument(
  RDAP_BOOTSTRAP_URL,
  parseRdapBootstrap,
  'rdap-bootstrap',
);

export async function loadRdapBootstrap(): Promise<RdapBootstrap | null> {
  return rdapBootstrapDocument.get();
}

/** Test seam: pins the bootstrap table so a unit test never touches the network. */
export function seedRdapBootstrap(bootstrap: RdapBootstrap | null): void {
  rdapBootstrapDocument.seed(bootstrap);
}
