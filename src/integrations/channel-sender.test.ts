import { afterEach, describe, expect, it } from 'vitest';

import { handlers, startMockServer, type MockServer } from '../../tests/support/mock-server.js';
import { parseRetryAfter, postToChannel, type ChannelRequest } from './channel-sender.js';

/**
 * The sender against a real HTTP server on loopback.
 *
 * What matters here is the classification — which failures are worth a retry
 * and which never will be — and the SSRF boundary, which the loopback exemption
 * narrows to loopback only: every other private range stays refused.
 */

let server: MockServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function requestTo(url: string, overrides: Partial<ChannelRequest> = {}): ChannelRequest {
  return {
    url,
    body: JSON.stringify({ hello: 'world' }),
    headers: { 'x-test': '1' },
    timeoutMs: 2_000,
    allowLoopback: true,
    ...overrides,
  };
}

describe('posting to a channel', () => {
  it('reports a 2xx as delivered', async () => {
    let received = '';
    server = await startMockServer((request, response) => {
      request.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
      });
      request.on('end', () => {
        response.writeHead(204);
        response.end();
      });
    });

    const outcome = await postToChannel(requestTo(`${server.url}/hook`));

    expect(outcome).toMatchObject({ delivered: true, statusCode: 204, failureReason: null });
    expect(JSON.parse(received)).toEqual({ hello: 'world' });
  });

  it('retries a server fault, and honours the receiver own Retry-After', async () => {
    server = await startMockServer((_request, response) => {
      response.writeHead(503, { 'retry-after': '120' });
      response.end('overloaded');
    });

    const outcome = await postToChannel(requestTo(server.url));

    expect(outcome).toMatchObject({
      delivered: false,
      retryable: true,
      statusCode: 503,
      retryAfterSeconds: 120,
      failureReason: 'HTTP 503: overloaded',
    });
  });

  it('retries a rate limit', async () => {
    server = await startMockServer(handlers.status(429));
    expect((await postToChannel(requestTo(server.url))).retryable).toBe(true);
  });

  it('does not retry a request the receiver will never accept', async () => {
    server = await startMockServer((_request, response) => {
      response.writeHead(404);
      response.end('no_service');
    });

    const outcome = await postToChannel(requestTo(server.url));

    expect(outcome).toMatchObject({
      retryable: false,
      statusCode: 404,
      failureReason: 'HTTP 404: no_service',
    });
  });

  it('never lets control characters from a hostile body into the log', async () => {
    const hostile = `bad${String.fromCharCode(0)}${String.fromCharCode(27)}[31mthing`;
    server = await startMockServer((_request, response) => {
      response.writeHead(400);
      response.end(hostile);
    });

    const outcome = await postToChannel(requestTo(server.url));

    expect(outcome.failureReason).toBe('HTTP 400: bad [31mthing');
  });

  it('does not follow a redirect, and says why', async () => {
    server = await startMockServer(handlers.redirectTo('https://elsewhere.example.org/'));

    const outcome = await postToChannel(requestTo(server.url));

    expect(outcome.delivered).toBe(false);
    expect(outcome.retryable).toBe(false);
    expect(outcome.failureReason).toContain('Redirects are not followed');
  });

  it('treats a receiver that never answers as a timeout worth retrying', async () => {
    server = await startMockServer(handlers.hang());

    const outcome = await postToChannel(requestTo(server.url, { timeoutMs: 300 }));

    expect(outcome).toMatchObject({
      delivered: false,
      retryable: true,
      failureReason: 'No answer within 300 ms.',
    });
  });

  it('retries a refused connection', async () => {
    server = await startMockServer(handlers.ok());
    const { url } = server;
    await server.close();
    server = null;

    const outcome = await postToChannel(requestTo(url));

    expect(outcome.retryable).toBe(true);
    expect(outcome.failureReason).toContain('Could not connect');
  });
});

describe('the SSRF boundary', () => {
  it('refuses cloud metadata even with the loopback exemption on', async () => {
    const outcome = await postToChannel(requestTo('http://169.254.169.254/latest/meta-data/'));

    expect(outcome).toMatchObject({ delivered: false, retryable: false });
    expect(outcome.failureReason).toBe(
      'The destination resolves to an address that must not be reached.',
    );
  });

  it('refuses loopback when the exemption is off, as it is in production', async () => {
    server = await startMockServer(handlers.ok());

    const outcome = await postToChannel(requestTo(server.url, { allowLoopback: false }));

    expect(outcome).toMatchObject({ delivered: false, retryable: false });
  });
});

describe('Retry-After', () => {
  const NOW = Date.parse('2026-09-10T08:00:00.000Z');

  it('reads delta-seconds', () => {
    expect(parseRetryAfter('90', NOW)).toBe(90);
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Thu, 10 Sep 2026 08:02:00 GMT', NOW)).toBe(120);
  });

  it('reads a date already past as zero, never negative', () => {
    expect(parseRetryAfter('Thu, 10 Sep 2026 07:00:00 GMT', NOW)).toBe(0);
  });

  it('ignores anything else', () => {
    expect(parseRetryAfter(undefined, NOW)).toBeNull();
    expect(parseRetryAfter('soon', NOW)).toBeNull();
    expect(parseRetryAfter('-5', NOW)).toBeNull();
  });
});
