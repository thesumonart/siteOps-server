import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  ContentCheckData,
  MonitorConfig,
  MonitorType,
  PerformanceCheckData,
  SeoCheckData,
} from '../../src/contracts/index.js';
import type { MonitorRunContext } from '../../src/monitoring/monitor-runner.js';
import { createSyntheticProvider } from '../../src/monitoring/performance/synthetic-provider.js';
import { createContentRunner } from '../../src/monitoring/runners/content.runner.js';
import { createPerformanceRunner } from '../../src/monitoring/runners/performance.runner.js';
import { createSeoRunner } from '../../src/monitoring/runners/seo.runner.js';
import { startMockServer, type MockServer } from '../support/mock-server.js';

/**
 * The page-fetching monitors, against a real HTTP server.
 *
 * These exercise the whole path — request, guard, parse, judge — rather than
 * the analysers alone, which are unit-tested separately. What is being proved
 * here is that the pieces are wired together correctly and that a monitor
 * reports `error` rather than a wrong answer when the fetch itself fails.
 */

const USER_AGENT = 'SiteOpsMonitor/1.0 (+https://siteops.app)';

let server: MockServer;
/** Swapped per test so one server can serve whatever the case needs. */
let currentBody = '';
let currentStatus = 200;
let robotsBody: string | null = null;
let sitemapStatus = 404;

beforeAll(async () => {
  server = await startMockServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';

    if (path === '/robots.txt') {
      if (robotsBody === null) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(robotsBody);
      return;
    }

    if (path === '/sitemap.xml') {
      response.writeHead(sitemapStatus);
      response.end();
      return;
    }

    if (path === '/style.css') {
      response.writeHead(200, { 'content-type': 'text/css' });
      response.end('body{color:red}'.repeat(100));
      return;
    }

    response.writeHead(currentStatus, { 'content-type': 'text/html' });
    response.end(currentBody);
  });
});

afterAll(async () => {
  await server.close();
});

function context(
  type: MonitorType,
  config: MonitorConfig,
  overrides: Partial<MonitorRunContext> = {},
): MonitorRunContext {
  return {
    monitor: {
      id: new Types.ObjectId(),
      organizationId: new Types.ObjectId(),
      websiteId: new Types.ObjectId(),
      type,
      intervalSeconds: 86_400,
      config,
      currentIncidentId: null,
      consecutiveErrors: 0,
      websiteName: 'Mock',
      websiteUrl: `${server.url}/`,
      websitePaused: false,
    },
    allowLoopback: true,
    userAgent: USER_AGENT,
    timeoutMs: 15_000,
    now: new Date(),
    ...overrides,
  };
}

describe('SEO runner', () => {
  const config: MonitorConfig = { type: 'seo', minScore: 70 };

  it('scores a well-formed page and finds its robots.txt and sitemap', async () => {
    currentStatus = 200;
    currentBody = `<!doctype html><html lang="en"><head>
      <title>A perfectly reasonable page title</title>
      <meta name="description" content="${'A description of a length search engines will actually display in results. '.repeat(1)}It explains the page.">
      <link rel="canonical" href="${server.url}/">
      <meta property="og:title" content="T"><meta property="og:description" content="D">
      <meta property="og:image" content="/i.png">
      </head><body><h1>Heading</h1><a href="/other">Other</a>
      <img src="a.png" alt="Described"><p>${'word '.repeat(220)}</p></body></html>`;
    robotsBody = 'User-agent: *\nDisallow:\nSitemap: /sitemap.xml';

    const result = await createSeoRunner().run(context('seo', config));
    const data = result.data as SeoCheckData;

    expect(result.status).toBe('passing');
    expect(data.robotsTxtFound).toBe(true);
    expect(data.sitemapFound).toBe(true);
    expect(data.title).toBe('A perfectly reasonable page title');
  });

  it('finds a sitemap at the conventional path when robots.txt does not declare one', async () => {
    robotsBody = 'User-agent: *\nDisallow:';
    sitemapStatus = 200;

    const result = await createSeoRunner().run(context('seo', config));

    expect((result.data as SeoCheckData).sitemapFound).toBe(true);
    sitemapStatus = 404;
  });

  it('warns when the score is below the threshold', async () => {
    currentBody = '<html><body><p>Almost nothing here.</p></body></html>';
    robotsBody = null;

    const result = await createSeoRunner().run(context('seo', config));

    expect(result.status).toBe('warning');
    expect((result.data as SeoCheckData).score).toBeLessThan(70);
  });

  it('fails, not merely warns, when the page is marked noindex', async () => {
    // A noindex left on after a deploy removes the page from search entirely,
    // which is a different order of problem from a short meta description.
    currentBody = '<html><head><meta name="robots" content="noindex"></head><body>x</body></html>';

    const result = await createSeoRunner().run(context('seo', config));

    expect(result.status).toBe('failing');
    expect((result.data as SeoCheckData).indexable).toBe(false);
  });

  it('reports an error rather than a score when the page cannot be fetched', async () => {
    currentStatus = 500;
    currentBody = '';

    const result = await createSeoRunner().run(context('seo', config));

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('500');
    currentStatus = 200;
  });

  it('reports an error for an unreachable host, never a zero score', async () => {
    const result = await createSeoRunner().run(
      context('seo', config, {
        monitor: { ...context('seo', config).monitor, websiteUrl: 'http://127.0.0.1:1/' },
      }),
    );

    expect(result.status).toBe('error');
  });
});

describe('content runner', () => {
  const config: MonitorConfig = {
    type: 'content',
    sensitivity: 'medium',
    ignoreSelectors: [],
    watchSelector: null,
  };

  it('records a baseline on the first run without reporting a change', async () => {
    currentStatus = 200;
    currentBody = '<html><body><p>Original content here</p></body></html>';

    const runner = createContentRunner({ readPrevious: () => Promise.resolve(null) });
    const result = await runner.run(context('content', config));
    const data = result.data as ContentCheckData;

    expect(result.status).toBe('passing');
    expect(data.changed).toBe(false);
    expect(data.contentHash).not.toBe('');
    expect(result.summary).toContain('Baseline');
  });

  it('reports a real change against the previous run', async () => {
    currentBody = '<html><body><p>Completely different words now</p></body></html>';

    const runner = createContentRunner({
      readPrevious: () =>
        Promise.resolve({ hash: 'a-different-hash', lines: ['Original content here'] }),
    });
    const result = await runner.run(context('content', config));
    const data = result.data as ContentCheckData;

    expect(result.status).toBe('warning');
    expect(data.changed).toBe(true);
    expect(data.excerpt).toContain('Completely different words now');
  });

  it('reports no change when the page is unchanged', async () => {
    currentBody = '<html><body><p>Steady content</p></body></html>';

    const baseline = await createContentRunner({
      readPrevious: () => Promise.resolve(null),
    }).run(context('content', config));
    const baselineData = baseline.data as ContentCheckData;

    const second = await createContentRunner({
      readPrevious: () =>
        Promise.resolve({ hash: baselineData.contentHash, lines: baselineData.lines }),
    }).run(context('content', config));

    expect((second.data as ContentCheckData).changed).toBe(false);
    expect(second.status).toBe('passing');
  });

  it('bounds the stored lines so one page cannot write an unbounded document', async () => {
    currentBody = `<html><body>${'<p>line</p>'.repeat(1000)}</body></html>`;

    const result = await createContentRunner({ readPrevious: () => Promise.resolve(null) }).run(
      context('content', config),
    );

    expect((result.data as ContentCheckData).lines.length).toBeLessThanOrEqual(400);
  });

  it('reports an error when the page cannot be fetched', async () => {
    currentStatus = 503;

    const result = await createContentRunner({ readPrevious: () => Promise.resolve(null) }).run(
      context('content', config),
    );

    expect(result.status).toBe('error');
    currentStatus = 200;
  });
});

describe('performance runner — synthetic provider', () => {
  const config: MonitorConfig = {
    type: 'performance',
    minPerformanceScore: 50,
    maxLargestContentfulPaintMs: 4000,
    strategy: 'mobile',
  };

  const runner = createPerformanceRunner({ providers: [createSyntheticProvider()] });

  it('measures what a server-side fetch can honestly measure', async () => {
    currentStatus = 200;
    currentBody =
      '<html><head><link rel="stylesheet" href="/style.css"></head><body><p>Fast</p></body></html>';

    const result = await runner.run(context('performance', config));
    const data = result.data as PerformanceCheckData;

    expect(data.source).toBe('synthetic');
    expect(data.timeToFirstByteMs).not.toBeNull();
    expect(data.totalBytes).toBeGreaterThan(0);
    // The stylesheet is render-blocking, so it was fetched and weighed.
    expect(data.requestCount).toBe(2);
    expect(data.performanceScore).not.toBeNull();
  });

  it('reports null for everything it cannot measure, rather than inventing it', async () => {
    const result = await runner.run(context('performance', config));
    const data = result.data as PerformanceCheckData;

    /*
     * LCP, CLS, TBT, Speed Index and the Lighthouse category scores are all
     * properties of a rendered page. A plausible-looking guess would be
     * believed, which is worse than an absence.
     */
    expect(data.largestContentfulPaintMs).toBeNull();
    expect(data.cumulativeLayoutShift).toBeNull();
    expect(data.totalBlockingTimeMs).toBeNull();
    expect(data.speedIndexMs).toBeNull();
    expect(data.accessibilityScore).toBeNull();
    expect(data.seoScore).toBeNull();
  });

  it('names its source in the summary, so a synthetic score is not mistaken for Lighthouse', async () => {
    const result = await runner.run(context('performance', config));

    expect(result.summary).toContain('synthetic');
  });

  it('does not count an async or deferred script as render-blocking', async () => {
    currentBody =
      '<html><head><script src="/style.css" defer></script></head><body><p>x</p></body></html>';

    const result = await runner.run(context('performance', config));

    // Only the document itself was fetched.
    expect((result.data as PerformanceCheckData).requestCount).toBe(1);
  });

  it('reports an error when the page cannot be fetched', async () => {
    currentStatus = 502;

    const result = await runner.run(context('performance', config));

    expect(result.status).toBe('error');
    currentStatus = 200;
  });

  it('falls through to the next provider when the first is unavailable', async () => {
    currentBody = '<html><body><p>x</p></body></html>';

    const unavailable = {
      name: 'stub',
      available: false,
      measure: () => Promise.reject(new Error('must not be called')),
    };
    const withFallback = createPerformanceRunner({
      providers: [unavailable, createSyntheticProvider()],
    });

    const result = await withFallback.run(context('performance', config));

    expect((result.data as PerformanceCheckData).source).toBe('synthetic');
  });

  it('falls through when a configured provider fails, rather than silencing the monitor', async () => {
    const failing = {
      name: 'stub',
      available: true,
      measure: () => Promise.resolve({ ok: false as const, reason: 'quota exceeded' }),
    };
    const withFallback = createPerformanceRunner({
      providers: [failing, createSyntheticProvider()],
    });

    const result = await withFallback.run(context('performance', config));

    // A Google outage degrades the monitor to synthetic measurement; it does
    // not turn it off.
    expect((result.data as PerformanceCheckData).source).toBe('synthetic');
  });
});
