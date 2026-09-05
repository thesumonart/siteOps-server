import { afterEach, describe, expect, it } from 'vitest';

import { startMockServer, type MockServer } from '../../tests/support/mock-server.js';
import { type CheckOptions } from './http-checker.js';
import { checkWebsiteWithRetries } from './check-with-retries.js';

const BASE_OPTIONS: CheckOptions = {
  timeoutMs: 300,
  maxRedirects: 5,
  allowLoopback: true,
  userAgent: 'SiteOps-Test/1.0',
};

let server: MockServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('checkWebsiteWithRetries', () => {
  it('returns immediately on a first-attempt success, without retrying', async () => {
    let requestCount = 0;
    server = await startMockServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200);
      res.end();
    });

    const outcome = await checkWebsiteWithRetries(server.url, BASE_OPTIONS, { maxAttempts: 3 });

    expect(outcome.status).toBe('up');
    expect(requestCount).toBe(1);
  });

  it('retries a transient failure and succeeds on a later attempt', async () => {
    let requestCount = 0;
    server = await startMockServer((_req, res) => {
      requestCount += 1;
      if (requestCount < 3) {
        res.destroy();
        return;
      }
      res.writeHead(200);
      res.end();
    });

    const outcome = await checkWebsiteWithRetries(server.url, BASE_OPTIONS, { maxAttempts: 3 });

    expect(outcome.status).toBe('up');
    expect(requestCount).toBe(3);
  });

  it('gives up after maxAttempts and reports the final failure', async () => {
    let requestCount = 0;
    server = await startMockServer((_req) => {
      // Never responds — every attempt has to wait out its own timeout, so
      // counting requests proves retries actually happened rather than the
      // first attempt's result being reused.
      requestCount += 1;
    });

    const outcome = await checkWebsiteWithRetries(
      server.url,
      { ...BASE_OPTIONS, timeoutMs: 100 },
      { maxAttempts: 2 },
    );

    expect(outcome.status).toBe('timeout');
    expect(requestCount).toBe(2);
  });

  it('never retries a blocked target — retrying could not change the outcome', async () => {
    let requestCount = 0;
    server = await startMockServer((_req, res) => {
      requestCount += 1;
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      res.end();
    });

    const outcome = await checkWebsiteWithRetries(server.url, BASE_OPTIONS, { maxAttempts: 5 });

    expect(outcome.errorType).toBe('blocked_target');
    expect(requestCount).toBe(1);
  });

  it('never retries an invalid URL', async () => {
    const outcome = await checkWebsiteWithRetries('file:///etc/passwd', BASE_OPTIONS, {
      maxAttempts: 5,
    });

    expect(outcome.errorType).toBe('invalid_url');
  });

  it('retries an HTTP error status, since a 503 can be a transient deploy blip', async () => {
    let requestCount = 0;
    server = await startMockServer((_req, res) => {
      requestCount += 1;
      res.writeHead(requestCount < 2 ? 503 : 200);
      res.end();
    });

    const outcome = await checkWebsiteWithRetries(server.url, BASE_OPTIONS, { maxAttempts: 3 });

    expect(outcome.status).toBe('up');
    expect(requestCount).toBe(2);
  });

  it('makes exactly one attempt when maxAttempts is 1', async () => {
    let requestCount = 0;
    server = await startMockServer((_req, res) => {
      requestCount += 1;
      res.writeHead(500);
      res.end();
    });

    await checkWebsiteWithRetries(server.url, BASE_OPTIONS, { maxAttempts: 1 });

    expect(requestCount).toBe(1);
  });
});
