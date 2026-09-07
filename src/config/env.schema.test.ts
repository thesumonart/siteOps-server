import { describe, expect, it } from 'vitest';

import { describeEnvIssues, envSchema } from './env.schema.js';

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

/**
 * Parses a configuration that is expected to be refused, and returns the
 * formatted failure. Narrows the result rather than asserting non-null, and
 * gives the header its own name so no test indexes into a possibly-empty split.
 */
function describeFailure(env: Record<string, string>): { header: string; full: string } {
  const result = envSchema.safeParse(env);
  if (result.success) throw new Error('Expected this configuration to be refused, but it parsed.');

  const full = describeEnvIssues(result.error.issues);
  return { header: full.split('\n')[0] ?? '', full };
}

describe('describeEnvIssues', () => {
  it('names every offending variable in the first line', () => {
    // The first line is often all a deployment log shows. SiteOps failed to
    // start on Render behind a header that named nothing at all.
    const { header } = describeFailure({});

    expect(header).toContain('APP_URL');
    expect(header).toContain('API_URL');
    expect(header).toContain('MONGODB_URI');
    expect(header).toContain('AUTH_SECRET');
    expect(header).toContain('4 problems');
  });

  it('lists each problem on its own line', () => {
    const { header, full } = describeFailure(baseEnv({ AUTH_SECRET: 'too-short' }));

    expect(full).toMatch(/^ {2}- AUTH_SECRET: .+$/m);
    expect(header).toContain('1 problem with: AUTH_SECRET');
  });

  it('never repeats a variable in the header', () => {
    const { header } = describeFailure(baseEnv({ AUTH_SECRET: '' }));

    expect(header.match(/AUTH_SECRET/g)).toHaveLength(1);
  });

  it('does not echo the offending value', () => {
    // This output reaches deployment logs, and the value that failed is very
    // often the secret itself.
    const secret = 'sk-live-do-not-log-this-value';

    expect(describeFailure(baseEnv({ AUTH_SECRET: secret })).full).not.toContain(secret);
  });
});
