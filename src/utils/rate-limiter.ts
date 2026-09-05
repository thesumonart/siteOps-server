/**
 * Fixed-window rate limiter backed by an in-process map.
 *
 * The limits SiteOps needs are simple enough that a dependency is not worth
 * carrying. The trade-off is that counters are per-process: with several API
 * instances the effective limit is `limit × instances`. That is acceptable for
 * a single-instance deployment, and this interface is narrow enough — one
 * `consume` call — to be re-implemented over a shared store without touching
 * any caller. See docs/SECURITY.md.
 */

export interface RateLimitRule {
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Requests permitted per key per window. */
  readonly limit: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Epoch milliseconds at which the current window ends. */
  readonly resetAt: number;
  readonly retryAfterSeconds: number;
}

interface WindowState {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, WindowState>();
  private lastSweepAt = 0;

  /**
   * Entries are evicted lazily during a sweep rather than by a timer, so the
   * limiter holds no handles and cannot keep the process alive.
   */
  private static readonly SWEEP_INTERVAL_MS = 60_000;

  consume(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitVerdict {
    this.sweep(now);

    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) {
      const resetAt = now + rule.windowMs;
      this.windows.set(key, { count: 1, resetAt });
      return {
        allowed: true,
        limit: rule.limit,
        remaining: rule.limit - 1,
        resetAt,
        retryAfterSeconds: 0,
      };
    }

    existing.count += 1;
    const allowed = existing.count <= rule.limit;

    return {
      allowed,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - existing.count),
      resetAt: existing.resetAt,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.windows.clear();
      return;
    }
    this.windows.delete(key);
  }

  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < RateLimiter.SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;

    for (const [key, state] of this.windows) {
      if (state.resetAt <= now) this.windows.delete(key);
    }
  }
}
