import { defineConfig } from 'vitest/config';

/**
 * Configuration is validated at import time, so any module that reaches
 * `src/config/env.ts` needs a valid environment. These are deliberately
 * obvious placeholders: nothing here is a real credential and no test may
 * depend on the values.
 *
 * `MONGODB_URI` points at the same local replica set `pnpm docker:up` starts.
 * Integration tests skip themselves when nothing is listening there; unit tests
 * never touch it.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    globals: false,
    testTimeout: 20_000,
    /*
     * Integration tests share one live database and wipe collections between
     * cases. Running files in parallel — Vitest's default — lets one file's
     * cleanup delete documents another is still asserting on.
     */
    fileParallelism: false,
    /*
     * Worker threads, not the default forked child processes.
     *
     * On Windows the fork pool intermittently lost a worker: the child exited
     * without reporting, *after* every one of its tests had passed, and without
     * running any JS exit handler — so no `uncaughtException`, no
     * `unhandledRejection`, nothing to read. It happened in roughly one run in
     * five, on a different file each time, and never when a file was run alone,
     * which is what ruled out any individual test as the cause.
     *
     * Measured before changing this: 4 failures in 20 runs on `forks`, 0 in 32
     * on `threads`. Threads are also a little faster here, because the module
     * graph is loaded once per thread rather than per process.
     */
    pool: 'threads',
    env: {
      NODE_ENV: 'test',
      APP_URL: 'http://localhost:3000',
      API_URL: 'http://localhost:4000',
      MONGODB_URI:
        process.env.MONGODB_URI ??
        'mongodb://localhost:27017/siteops_test?replicaSet=rs0&directConnection=true',
      AUTH_SECRET: 'test-only-secret-value-not-used-for-anything-real',
      LOG_LEVEL: 'silent',
      /*
       * Every request in the integration suite arrives from the same loopback
       * address and therefore shares one rate-limit budget, which the real
       * limits are far too tight for. Raised here rather than weakened in the
       * schema, and rate limiting itself is covered directly in
       * `tests/integration/security.test.ts` with a rule of its own.
       */
      RATE_LIMIT_MAX_REQUESTS: '100000',
      AUTH_RATE_LIMIT_MAX_REQUESTS: '100000',
    },
  },
});
