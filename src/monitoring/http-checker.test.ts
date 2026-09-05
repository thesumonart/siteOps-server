import { afterEach, describe, expect, it } from 'vitest';

import { handlers, startMockServer, type MockServer } from '../../tests/support/mock-server.js';
import { checkWebsite, type CheckOptions } from './http-checker.js';

const BASE_OPTIONS: CheckOptions = {
  timeoutMs: 1_000,
  maxRedirects: 5,
  allowLoopback: true,
  userAgent: 'SiteOps-Test/1.0',
};

let server: MockServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('checkWebsite — success and HTTP status', () => {
  it('reports up for a 200 response', async () => {
    server = await startMockServer(handlers.ok());

    const outcome = await checkWebsite(server.url, BASE_OPTIONS);

    expect(outcome.status).toBe('up');
    expect(outcome.statusCode).toBe(200);
    expect(outcome.errorType).toBeNull();
    expect(outcome.responseTimeMs).not.toBeNull();
    expect(outcome.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it.each([200, 201, 204, 299, 301, 399])('treats HTTP %i as up', async (code) => {
    // 3xx here means "not a redirect Location header" fixtures, i.e. the
    // boundary of the up/down split, not a followed redirect.
    server = await startMockServer(handlers.status(code));

    const outcome = await checkWebsite(server.url, BASE_OPTIONS);

    expect(outcome.status).toBe('up');
    expect(outcome.statusCode).toBe(code);
  });

  it.each([400, 401, 403, 404, 500, 502, 503])('treats HTTP %i as down', async (code) => {
    server = await startMockServer(handlers.status(code));

    const outcome = await checkWebsite(server.url, BASE_OPTIONS);

    expect(outcome.status).toBe('down');
    expect(outcome.statusCode).toBe(code);
    expect(outcome.errorType).toBe('http_error');
  });
});

describe('checkWebsite — redirects', () => {
  it('follows a redirect to a successful target and reports the final status', async () => {
    const target = await startMockServer(handlers.ok());
    server = await startMockServer(handlers.redirectTo(target.url));

    try {
      const outcome = await checkWebsite(server.url, BASE_OPTIONS);

      expect(outcome.status).toBe('up');
      expect(outcome.redirectCount).toBe(1);
      expect(outcome.finalUrl).toBe(`${target.url}/`);
    } finally {
      await target.close();
    }
  });

  it('counts a chain of redirects', async () => {
    const final = await startMockServer(handlers.ok());
    const middle = await startMockServer(handlers.redirectTo(final.url));
    server = await startMockServer(handlers.redirectTo(middle.url));

    try {
      const outcome = await checkWebsite(server.url, BASE_OPTIONS);

      expect(outcome.status).toBe('up');
      expect(outcome.redirectCount).toBe(2);
    } finally {
      await middle.close();
      await final.close();
    }
  });

  it('stops after the configured redirect limit', async () => {
    // A → B → A: an infinite loop, which must be bounded rather than hung.
    server = await startMockServer((req, res) => {
      res.writeHead(302, { location: req.url === '/a' ? '/b' : '/a' });
      res.end();
    });

    const outcome = await checkWebsite(`${server.url}/a`, { ...BASE_OPTIONS, maxRedirects: 3 });

    expect(outcome.status).toBe('down');
    expect(outcome.errorType).toBe('too_many_redirects');
    expect(outcome.redirectCount).toBe(3);
  });

  /**
   * The core SSRF guarantee for this module: a URL that is publicly reachable
   * when the website is added can still redirect into private address space at
   * check time. Every hop must be re-validated, not just the first one.
   */
  it('refuses a redirect into a blocked address, even from an otherwise-public origin', async () => {
    server = await startMockServer(handlers.redirectTo('http://169.254.169.254/latest/meta-data/'));

    // allowLoopback is true (so the *origin* on 127.0.0.1 is reachable in this
    // test), but the metadata range is never permitted by the address guard
    // regardless of that flag — see address-guard.test.ts.
    const outcome = await checkWebsite(server.url, BASE_OPTIONS);

    expect(outcome.status).not.toBe('up');
    expect(outcome.errorType).toBe('blocked_target');
    expect(outcome.redirectCount).toBe(1);
  });

  it('refuses a redirect to a non-http(s) scheme', async () => {
    server = await startMockServer(handlers.redirectTo('file:///etc/passwd'));

    const outcome = await checkWebsite(server.url, BASE_OPTIONS);

    expect(outcome.status).not.toBe('up');
    expect(['blocked_target', 'invalid_url']).toContain(outcome.errorType);
  });
});

describe('checkWebsite — network failures', () => {
  it('reports a timeout for a request that never responds', async () => {
    server = await startMockServer(handlers.hang());

    const outcome = await checkWebsite(server.url, { ...BASE_OPTIONS, timeoutMs: 200 });

    expect(outcome.status).toBe('timeout');
    expect(outcome.errorType).toBe('timeout');
    expect(outcome.statusCode).toBeNull();
  }, 5_000);

  it('reports connection_refused when nothing is listening', async () => {
    // A port that was briefly bound and released; nothing listens on it now.
    const probe = await startMockServer(handlers.ok());
    const deadPort = probe.port;
    await probe.close();

    const outcome = await checkWebsite(`http://127.0.0.1:${deadPort}`, BASE_OPTIONS);

    expect(outcome.status).toBe('error');
    expect(outcome.errorType).toBe('connection_refused');
  });

  it('reports connection_reset when the server closes the connection mid-request', async () => {
    // undici surfaces this as UND_ERR_SOCKET rather than ECONNRESET. A real
    // monitoring run against a crashed application server produced exactly
    // this, and it was classified 'unknown' until the code was mapped.
    server = await startMockServer((req) => {
      req.destroy();
    });

    const outcome = await checkWebsite(server.url, BASE_OPTIONS);

    expect(outcome.status).toBe('error');
    expect(outcome.errorType).toBe('connection_reset');
  });

  it('reports dns_failure for an unresolvable hostname', async () => {
    const outcome = await checkWebsite(
      'http://this-host-does-not-exist.invalid.siteops-test',
      BASE_OPTIONS,
    );

    expect(outcome.status).toBe('error');
    expect(outcome.errorType).toBe('dns_failure');
  }, 10_000);

  it('reports a slow-but-successful response with the correct outcome', async () => {
    server = await startMockServer(handlers.slow(50));

    const outcome = await checkWebsite(server.url, { ...BASE_OPTIONS, timeoutMs: 1_000 });

    expect(outcome.status).toBe('up');
    expect(outcome.responseTimeMs).toBeGreaterThanOrEqual(50);
  });
});

describe('checkWebsite — SSRF at the origin', () => {
  it('refuses to even attempt a request to a blocked target when allowLoopback is off', async () => {
    const outcome = await checkWebsite('http://169.254.169.254/', {
      ...BASE_OPTIONS,
      allowLoopback: false,
    });

    expect(outcome.status).not.toBe('up');
    expect(outcome.errorType).toBe('blocked_target');
  });

  it('refuses a private-network origin outright, string validation catching it before any socket opens', async () => {
    const outcome = await checkWebsite('http://10.0.0.5/', {
      ...BASE_OPTIONS,
      allowLoopback: false,
    });

    expect(outcome.status).not.toBe('up');
    expect(['blocked_target', 'invalid_url']).toContain(outcome.errorType);
  });
});
