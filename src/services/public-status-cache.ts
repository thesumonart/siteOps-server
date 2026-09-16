import type { PublicStatusPageDto } from '../contracts/index.js';

/**
 * A short-lived, in-process cache for what the public status endpoints serve.
 *
 * Two things are cached, for two reasons:
 *
 *  - **Rendered pages.** A status page is read by everyone at once precisely
 *    when something is wrong, and every read is a set of aggregations over the
 *    check history. A minute of staleness costs a visitor nothing; recomputing
 *    per request during an outage costs the database a great deal.
 *  - **Hostname lookups.** Every request on a host that is not SiteOps's own
 *    asks "is this a verified custom domain". Without a cache that is a query
 *    per request, and the answer changes a few times a year.
 *
 * Per process, like the rate limiter: with several API instances a change
 * reaches each within one TTL. Changes made through this process are forgotten
 * immediately rather than waiting it out.
 */

interface PageEntry {
  readonly pageId: string;
  readonly value: PublicStatusPageDto;
  readonly expiresAt: number;
}

interface HostEntry {
  readonly pageId: string | null;
  readonly expiresAt: number;
}

/**
 * Upper bound on remembered entries of each kind.
 *
 * Host keys come from the `Host` header, which the client chooses. Without a
 * bound, a stream of made-up hostnames would grow the map forever; with one,
 * it is cleared and rebuilt, which costs a few queries and nothing else. Pages
 * are only remembered once found, so their bound is never reached in practice.
 */
const MAX_ENTRIES = 10_000;

export class PublicStatusCache {
  private readonly pages = new Map<string, PageEntry>();
  private readonly hosts = new Map<string, HostEntry>();

  constructor(private readonly ttlMs: number) {}

  /**
   * A rendered page, by whatever key the caller found it under — its slug or
   * its custom domain. Both keys carry the page id, so a change to the page
   * forgets every way it was reached.
   */
  page(key: string, now: number = Date.now()): PublicStatusPageDto | undefined {
    const entry = this.pages.get(key);
    return entry && entry.expiresAt > now ? entry.value : undefined;
  }

  rememberPage(
    key: string,
    pageId: string,
    value: PublicStatusPageDto,
    now: number = Date.now(),
  ): void {
    if (this.pages.size >= MAX_ENTRIES) this.pages.clear();
    this.pages.set(key, { pageId, value, expiresAt: now + this.ttlMs });
  }

  /** The page id a host routes to, null for "not a custom domain", undefined for "not cached". */
  host(host: string, now: number = Date.now()): string | null | undefined {
    const entry = this.hosts.get(host);
    return entry && entry.expiresAt > now ? entry.pageId : undefined;
  }

  rememberHost(host: string, pageId: string | null, now: number = Date.now()): void {
    if (this.hosts.size >= MAX_ENTRIES) this.hosts.clear();
    this.hosts.set(host, { pageId, expiresAt: now + this.ttlMs });
  }

  /** Drops every rendering of one page, under every key, after it changed. */
  forgetPage(pageId: string): void {
    for (const [key, entry] of this.pages) {
      if (entry.pageId === pageId) this.pages.delete(key);
    }
  }

  forgetHost(host: string): void {
    this.hosts.delete(host);
  }
}
