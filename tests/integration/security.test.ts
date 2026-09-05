import express, { type Express } from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { errorHandler } from '../../src/errors/error-handler.js';
import { notFoundHandler } from '../../src/middlewares/not-found.middleware.js';
import { rateLimit, resetRateLimiter } from '../../src/middlewares/rate-limit.middleware.js';
import { requestId } from '../../src/middlewares/request-id.middleware.js';
import { client, onboard } from '../support/api.js';
import { databaseAvailable, disconnectTestDatabase } from '../support/test-db.js';

/**
 * Cross-cutting guarantees: what a rate-limited caller sees, what an error
 * response is allowed to contain, and what a request that never matches a route
 * gets back.
 *
 * Rate limiting is exercised against a purpose-built app with a tight rule
 * rather than against the real one. The integration suite runs every request
 * from the same loopback address and would otherwise have to share — and
 * exhaust — one budget across unrelated tests, which is exactly the kind of
 * order-dependent flakiness that makes a suite untrustworthy.
 */

const available = await databaseAvailable();

afterAll(async () => {
  await disconnectTestDatabase();
});

function limitedApp(): Express {
  const app = express();
  app.use(requestId);
  app.use(rateLimit({ limit: 3, windowSeconds: 60, scope: 'security-test' }));
  app.get('/limited', (_request, response) => {
    response.json({ success: true, data: { ok: true } });
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('rate limiting', () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  it('allows requests up to the limit and then refuses them', async () => {
    const app = limitedApp();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await request(app).get('/limited').expect(200);
      expect(response.headers['ratelimit-limit']).toBe('3');
      expect(response.headers['ratelimit-remaining']).toBe(String(3 - attempt));
    }

    const refused = await request(app).get('/limited').expect(429);

    expect(refused.body).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMITED' },
    });
    // A client that cannot tell when to come back retries immediately and
    // makes the problem worse.
    expect(refused.headers['retry-after']).toBeDefined();
    expect(refused.headers['ratelimit-remaining']).toBe('0');
  });

  it('reports the standard headers on every response, not just refusals', async () => {
    const app = limitedApp();
    const response = await request(app).get('/limited').expect(200);

    expect(response.headers['ratelimit-limit']).toBeDefined();
    expect(response.headers['ratelimit-remaining']).toBeDefined();
    expect(response.headers['ratelimit-reset']).toBeDefined();
  });
});

describe('error responses', () => {
  // The limiter is process-wide and shared with the suite above, so each case
  // starts from a clean budget rather than inheriting whatever it left.
  beforeEach(() => {
    resetRateLimiter();
  });

  it('answers an unmatched path in the documented envelope', async () => {
    const response = await request(limitedApp()).get('/nothing-here').expect(404);

    expect(response.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found.' },
    });
  });

  it('echoes a correlation id the caller can quote in a bug report', async () => {
    const response = await request(limitedApp()).get('/limited').expect(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not echo a client-supplied request id that is not id-shaped', async () => {
    const response = await request(limitedApp())
      .get('/limited')
      .set('X-Request-Id', '<script>alert(1)</script>')
      .expect(200);

    // Reflecting arbitrary text into a response header is how header injection
    // and log forgery start. A well-formed id is honoured; anything else is
    // replaced with one of ours.
    expect(response.headers['x-request-id']).not.toContain('<script>');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours a well-formed client request id', async () => {
    const response = await request(limitedApp())
      .get('/limited')
      .set('X-Request-Id', 'trace-abc-123')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('trace-abc-123');
  });
});

describe.skipIf(!available)('error responses from the real API', () => {
  it('rejects a body larger than the limit without a stack trace', async () => {
    const oversized = 'x'.repeat(200_000);

    const response = await client()
      .post('/api/organizations')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ name: oversized }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('node_modules');
    expect(body).not.toContain('at Object.');
    expect(body).not.toContain('siteOps-server');
  });

  it('answers malformed JSON as a client error, never a server fault', async () => {
    const response = await client()
      .post('/api/organizations')
      .set('Content-Type', 'application/json')
      .send('{ this is not json');

    expect(response.status).toBeLessThan(500);
    expect(response.body.success).toBe(false);
  });

  it('never leaks the database or the environment through an error', async () => {
    const { agent, organizationId } = await onboard('leak-check');

    const response = await agent
      .get('/api/websites/not-a-valid-id')
      .set('X-Organization-Id', organizationId);

    const body = JSON.stringify(response.body);
    expect(body).not.toMatch(/mongodb:\/\//);
    expect(body).not.toContain('AUTH_SECRET');
    expect(body).not.toContain('E11000');
    expect(body).not.toContain('CastError');
  });
});
