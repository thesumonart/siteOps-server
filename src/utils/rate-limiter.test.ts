import { describe, expect, it } from 'vitest';

import { RateLimiter, type RateLimitRule } from './rate-limiter.js';

const rule: RateLimitRule = { windowMs: 60_000, limit: 3 };

describe('RateLimiter', () => {
  it('allows requests up to the limit', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    expect(limiter.consume('a', rule, now).allowed).toBe(true);
    expect(limiter.consume('a', rule, now).allowed).toBe(true);
    expect(limiter.consume('a', rule, now).allowed).toBe(true);
  });

  it('blocks the request that exceeds the limit', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    for (let i = 0; i < rule.limit; i += 1) limiter.consume('a', rule, now);
    const verdict = limiter.consume('a', rule, now);

    expect(verdict.allowed).toBe(false);
    expect(verdict.remaining).toBe(0);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reports remaining budget accurately', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    expect(limiter.consume('a', rule, now).remaining).toBe(2);
    expect(limiter.consume('a', rule, now).remaining).toBe(1);
    expect(limiter.consume('a', rule, now).remaining).toBe(0);
  });

  it('keeps separate budgets per key', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    for (let i = 0; i < rule.limit; i += 1) limiter.consume('attacker', rule, now);

    expect(limiter.consume('attacker', rule, now).allowed).toBe(false);
    expect(limiter.consume('someone-else', rule, now).allowed).toBe(true);
  });

  it('starts a fresh window once the old one expires', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    for (let i = 0; i < rule.limit; i += 1) limiter.consume('a', rule, now);
    expect(limiter.consume('a', rule, now).allowed).toBe(false);

    const afterWindow = now + rule.windowMs + 1;
    expect(limiter.consume('a', rule, afterWindow).allowed).toBe(true);
  });

  it('does not leak memory for keys whose window has passed', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    for (let i = 0; i < 50; i += 1) limiter.consume(`key-${i}`, rule, now);
    expect(limiter.size).toBe(50);

    // A later request triggers the sweep, which drops the expired windows.
    limiter.consume('fresh', rule, now + rule.windowMs + 61_000);
    expect(limiter.size).toBe(1);
  });

  it('can be reset for a single key or entirely', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    for (let i = 0; i < rule.limit; i += 1) limiter.consume('a', rule, now);
    limiter.reset('a');
    expect(limiter.consume('a', rule, now).allowed).toBe(true);

    limiter.reset();
    expect(limiter.size).toBe(0);
  });
});
