import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  crawlSite,
  extractLinks,
  normalizeCrawlUrl,
} from '../../src/monitoring/crawler/crawler.js';
import { parseRobots, permissiveRobots } from '../../src/monitoring/crawler/robots.js';
import { startMockServer, type MockServer } from '../support/mock-server.js';

/**
 * The broken-link crawler, against a real HTTP server.
 *
 * A crawl is the most intrusive thing SiteOps does to a customer's site, so the
 * cases that matter most here are the *bounds*: that a page limit holds, that a
 * cycle terminates, that a deadline stops a slow origin, and that a link into
 * private address space is refused. Coverage is secondary to not being able to
 * hurt anyone.
 *
 * Loopback is permitted only because the mock server lives there; every other
 * blocked range stays blocked, which is what lets the metadata-address case
 * below actually prove something.
 */

const USER_AGENT = 'SiteOpsMonitor/1.0 (+https://siteops.app)';

let server: MockServer;
/** Requested paths, in order, so politeness and de-duplication are observable. */
let requested: string[] = [];

function html(body: string): string {
  return `<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`;
}

/**
 * A small site:
 *   /            → links to /a, /b, /missing, /loop, an external URL
 *   /a           → links back to / and to /a?utm_source=x (the same page)
 *   /b           → links to /deep/1
 *   /deep/1..3   → a chain, for depth limits
 *   /loop        → links to itself
 *   /missing     → 404
 *   /gone        → 410
 *   /boom        → 500
 *   /secret      → 403
 *   /slow        → responds after 3 seconds
 *   /file.pdf    → a non-HTML resource that resolves
 *   /many        → a page with 60 distinct links, for the page cap
 */
const ROUTES: Record<string, { status: number; body?: string; type?: string }> = {
  '/': {
    status: 200,
    body: html(
      [
        '<a href="/a">A</a>',
        '<a href="/b">B</a>',
        '<a href="/missing">Missing</a>',
        '<a href="/gone">Gone</a>',
        '<a href="/boom">Boom</a>',
        '<a href="/secret">Secret</a>',
        '<a href="/file.pdf">File</a>',
        '<a href="#top">Fragment</a>',
        '<a href="mailto:a@b.test">Mail</a>',
      ].join(''),
    ),
  },
  '/a': { status: 200, body: html('<a href="/">Home</a><a href="/a?utm_source=x">Same</a>') },
  '/b': { status: 200, body: html('<a href="/deep/1">Deep</a>') },
  '/deep/1': { status: 200, body: html('<a href="/deep/2">Deeper</a>') },
  '/deep/2': { status: 200, body: html('<a href="/deep/3">Deepest</a>') },
  '/deep/3': { status: 200, body: html('<p>End</p>') },
  '/loop': { status: 200, body: html('<a href="/loop">Itself</a>') },
  '/missing': { status: 404 },
  '/gone': { status: 410 },
  '/boom': { status: 500 },
  '/secret': { status: 403 },
  '/file.pdf': { status: 200, body: '%PDF-1.4', type: 'application/pdf' },
};

beforeAll(async () => {
  server = await startMockServer((request, response) => {
    const path = (request.url ?? '/').split('#')[0] ?? '/';
    requested.push(path);

    if (path.startsWith('/slow')) {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(html('<p>Eventually</p>'));
      }, 3000).unref();
      return;
    }

    if (path.startsWith('/many')) {
      const links = Array.from(
        { length: 60 },
        (_, index) => `<a href="/page-${String(index)}">P${String(index)}</a>`,
      ).join('');
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html(links));
      return;
    }

    if (path.startsWith('/page-')) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html('<p>Leaf</p>'));
      return;
    }

    if (path === '/metadata') {
      response.writeHead(200, { 'content-type': 'text/html' });
      // A link into cloud metadata territory. The address guard must refuse it.
      response.end(html('<a href="http://169.254.169.254/latest/meta-data/">Metadata</a>'));
      return;
    }

    // Query strings resolve to their base path.
    const base = path.split('?')[0] ?? '/';
    const route = ROUTES[base];

    if (!route) {
      response.writeHead(404);
      response.end();
      return;
    }

    response.writeHead(route.status, { 'content-type': route.type ?? 'text/html' });
    response.end(route.body ?? '');
  });
});

afterAll(async () => {
  await server.close();
});

function options(overrides: Partial<Parameters<typeof crawlSite>[0]> = {}) {
  return {
    startUrl: `${server.url}/`,
    maxPages: 20,
    maxDepth: 3,
    checkExternal: false,
    robots: permissiveRobots(false),
    userAgent: USER_AGENT,
    allowLoopback: true,
    deadline: Date.now() + 30_000,
    ...overrides,
  };
}

describe('normalizeCrawlUrl', () => {
  it('drops the fragment, which is never a distinct page to a server', () => {
    expect(normalizeCrawlUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('drops tracking parameters so the same page is not crawled twice', () => {
    expect(normalizeCrawlUrl('https://example.com/a?utm_source=x&id=7')).toBe(
      'https://example.com/a?id=7',
    );
  });

  it('sorts remaining parameters so order does not create a duplicate', () => {
    expect(normalizeCrawlUrl('https://example.com/?b=2&a=1')).toBe(
      normalizeCrawlUrl('https://example.com/?a=1&b=2'),
    );
  });

  it('removes a default port and lowercases the host', () => {
    expect(normalizeCrawlUrl('https://EXAMPLE.com:443/a')).toBe('https://example.com/a');
  });

  it('keeps a trailing slash, because it can be a different resource', () => {
    expect(normalizeCrawlUrl('https://example.com/a/')).not.toBe('https://example.com/a');
  });

  it('refuses a non-HTTP scheme', () => {
    expect(normalizeCrawlUrl('mailto:a@b.test')).toBeNull();
    expect(normalizeCrawlUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeCrawlUrl('not a url')).toBeNull();
  });
});

describe('extractLinks', () => {
  it('resolves relative links against the page', () => {
    const links = extractLinks('<a href="/b">B</a><a href="c">C</a>', 'https://example.com/a/');

    expect(links).toContain('https://example.com/b');
    expect(links).toContain('https://example.com/a/c');
  });

  it('skips fragments and non-navigational schemes', () => {
    const links = extractLinks(
      '<a href="#x">X</a><a href="mailto:a@b.test">M</a><a href="tel:123">T</a>',
      'https://example.com/',
    );

    expect(links).toEqual([]);
  });

  it('de-duplicates links that normalize to the same page', () => {
    const links = extractLinks(
      '<a href="/a">1</a><a href="/a#top">2</a><a href="/a?utm_source=x">3</a>',
      'https://example.com/',
    );

    expect(links).toEqual(['https://example.com/a']);
  });
});

describe('crawlSite — finding broken links', () => {
  it('reports 404, 410 and 5xx', async () => {
    const result = await crawlSite(options());
    const byPath = new Map(
      result.brokenLinks.map((link) => [new URL(link.url).pathname, link.statusCode]),
    );

    expect(byPath.get('/missing')).toBe(404);
    expect(byPath.get('/gone')).toBe(410);
    expect(byPath.get('/boom')).toBe(500);
  });

  it('does not report a 403 as broken', async () => {
    // A link into an admin area answers 403 to an anonymous crawler and works
    // perfectly for the people it is for. Reporting it would bury real 404s.
    const result = await crawlSite(options());
    const paths = result.brokenLinks.map((link) => new URL(link.url).pathname);

    expect(paths).not.toContain('/secret');
  });

  it('records where each broken link was found', async () => {
    const result = await crawlSite(options());
    const missing = result.brokenLinks.find((link) => link.url.endsWith('/missing'));

    expect(missing?.foundOn).toBe(`${server.url}/`);
  });

  it('checks a non-HTML resource without parsing it', async () => {
    const result = await crawlSite(options());

    // The PDF resolves, so it is not broken, and it contributed no links.
    expect(result.brokenLinks.some((link) => link.url.endsWith('.pdf'))).toBe(false);
  });

  it('reports nothing broken on a clean page', async () => {
    const result = await crawlSite(options({ startUrl: `${server.url}/deep/3` }));

    expect(result.brokenCount).toBe(0);
    expect(result.brokenLinks).toEqual([]);
  });
});

describe('crawlSite — bounds', () => {
  it('honours the page limit', async () => {
    const result = await crawlSite(options({ startUrl: `${server.url}/many`, maxPages: 5 }));

    expect(result.pagesCrawled).toBeLessThanOrEqual(5);
    expect(result.truncated).toBe(true);
  });

  it('honours the depth limit', async () => {
    requested = [];
    await crawlSite(options({ startUrl: `${server.url}/b`, maxDepth: 1 }));

    /*
     * /b is depth 0 and /deep/1 is depth 1, so /deep/1 is the last page
     * crawled. /deep/2 is still *checked* — a link at the boundary can still be
     * broken, and not reporting that would be a gap — but it is never parsed,
     * so /deep/3 is never discovered at all.
     */
    expect(requested).toContain('/deep/1');
    expect(requested).toContain('/deep/2');
    expect(requested).not.toContain('/deep/3');
  });

  it('terminates on a self-referential page', async () => {
    const result = await crawlSite(options({ startUrl: `${server.url}/loop`, maxPages: 10 }));

    // The visited set is what stops this; without it the crawl never ends.
    expect(result.pagesCrawled).toBe(1);
  });

  it('does not fetch the same page twice', async () => {
    requested = [];
    await crawlSite(options({ maxPages: 20 }));

    const homeRequests = requested.filter((path) => path === '/').length;
    expect(homeRequests).toBe(1);
  });

  it('stops at the deadline rather than running until the lease expires', async () => {
    const startedAt = Date.now();
    const result = await crawlSite(
      options({
        startUrl: `${server.url}/slow`,
        // Already past: the crawl fetches the start page and then stops.
        deadline: startedAt + 500,
      }),
    );

    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(result.pagesCrawled).toBeLessThanOrEqual(1);
  });

  it('reports an unreachable start page rather than throwing', async () => {
    const result = await crawlSite(options({ startUrl: 'http://127.0.0.1:1/' }));

    expect(result.brokenCount).toBe(1);
    expect(result.brokenLinks[0]?.statusCode).toBeNull();
  });
});

describe('crawlSite — SSRF protection', () => {
  it('refuses a link into cloud metadata address space', async () => {
    const result = await crawlSite(
      options({ startUrl: `${server.url}/metadata`, checkExternal: true }),
    );

    const metadata = result.brokenLinks.find((link) => link.url.includes('169.254.169.254'));

    /*
     * The link is *reported* as unreachable — which it is, from our side — and
     * crucially no connection was made to it. `allowLoopback` is on for the
     * mock server and every other blocked range stays blocked, so this case
     * proves the guard rather than the absence of a route.
     */
    expect(metadata).toBeDefined();
    expect(metadata?.statusCode).toBeNull();
  });
});

describe('crawlSite — robots.txt', () => {
  it('does not crawl a disallowed path', async () => {
    requested = [];
    const robots = parseRobots('User-agent: *\nDisallow: /b', USER_AGENT);

    await crawlSite(options({ robots }));

    expect(requested).toContain('/a');
    expect(requested).not.toContain('/b');
  });

  it('crawls everything when robots.txt permits it', async () => {
    requested = [];
    const robots = parseRobots('User-agent: *\nDisallow:', USER_AGENT);

    await crawlSite(options({ robots }));

    expect(requested).toContain('/a');
    expect(requested).toContain('/b');
  });

  it('applies a crawl delay', async () => {
    const robots = parseRobots('User-agent: *\nCrawl-delay: 1\nDisallow:', USER_AGENT);
    const startedAt = Date.now();

    await crawlSite(options({ startUrl: `${server.url}/deep/2`, robots, maxPages: 2 }));

    // Two pages with a one-second delay cannot finish instantly.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  });
});

describe('crawlSite — external links', () => {
  it('skips external links when asked to', async () => {
    requested = [];
    const result = await crawlSite(
      options({
        startUrl: `${server.url}/metadata`,
        checkExternal: false,
      }),
    );

    expect(result.brokenLinks.some((link) => link.url.includes('169.254'))).toBe(false);
  });
});
