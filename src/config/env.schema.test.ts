import { describe, expect, it } from 'vitest';

import { envSchema } from './env.schema.js';

/**
 * Regression coverage for the production sign-in failure.
 *
 * SiteOps was deployed to Render without `NODE_ENV`, so it ran in development
 * mode on a public https host. `config/auth.ts` ties both `useSecureCookies`
 * and the cookie's `secure` attribute to that one value, so every session
 * cookie went out without `Secure` and without the `__Secure-` prefix. Nothing
 * failed loudly: the process started, the database connected, sign-in answered
 * 200 with a valid session — and no browser kept the cookie.
 *
 * The schema now refuses that combination at startup, which is the only place
 * it can be caught before a person discovers it by not being able to sign in.
 */

/** The smallest configuration that parses, so each case varies one thing. */
function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    APP_URL: 'http://localhost:3000',
    API_URL: 'http://localhost:4000',
    MONGODB_URI: 'mongodb://localhost:27017/siteops',
    AUTH_SECRET: 'a-test-only-secret-of-at-least-32-characters',
    ...overrides,
  };
}

describe('envSchema production detection', () => {
  it('refuses a remote https deployment that is not in production mode', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'development',
        APP_URL: 'https://siteops-client.vercel.app',
      }),
    );

    expect(result.success).toBe(false);
    const issue = result.error?.issues.find((candidate) => candidate.path[0] === 'NODE_ENV');
    expect(issue?.message).toMatch(/NODE_ENV must be "production"/);
  });

  it('accepts the same deployment once it says it is production', () => {
    const result = envSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        APP_URL: 'https://siteops-client.vercel.app',
        API_URL: 'https://siteops-server.onrender.com',
        // Required in production so verification and alert mail is deliverable.
        RESEND_API_KEY: 'test-only-placeholder',
      }),
    );

    expect(result.success).toBe(true);
  });

  it('leaves local development alone', () => {
    // The everyday case: plain http on loopback, no NODE_ENV set at all.
    expect(envSchema.safeParse(baseEnv()).success).toBe(true);
  });

  it('allows https on loopback, which is still this machine', () => {
    const result = envSchema.safeParse(
      baseEnv({ NODE_ENV: 'development', APP_URL: 'https://localhost:3000' }),
    );

    expect(result.success).toBe(true);
  });
});
