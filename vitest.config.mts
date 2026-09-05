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
       * `tests/integration/rate-limit.test.ts` with a rule of its own.
       */
      RATE_LIMIT_MAX_REQUESTS: '100000',
      AUTH_RATE_LIMIT_MAX_REQUESTS: '100000',
    },
  },
});
