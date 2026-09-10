import { describe, expect, it } from 'vitest';

import { retryDelaySeconds } from './channel-delivery.job.js';

describe('the retry schedule', () => {
  it('backs off by a factor of four from the base delay', () => {
    expect([1, 2, 3, 4].map((attempt) => retryDelaySeconds(attempt, 30, null))).toEqual([
      30, 120, 480, 1920,
    ]);
  });

  it('waits longer when the receiver asks for longer', () => {
    expect(retryDelaySeconds(1, 30, 600)).toBe(600);
  });

  it('never waits less than the backoff because a receiver asked for less', () => {
    expect(retryDelaySeconds(3, 30, 5)).toBe(480);
  });

  it('caps any single wait, including one a receiver asked for', () => {
    const sixHours = 6 * 60 * 60;
    expect(retryDelaySeconds(20, 30, null)).toBe(sixHours);
    expect(retryDelaySeconds(1, 30, 60 * 60 * 24 * 365)).toBe(sixHours);
  });
});
