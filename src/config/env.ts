import { describeEnvIssues, envSchema, type Env } from './env.schema.js';

/**
 * The loaded, validated configuration for this process.
 *
 * Parsing happens once at import time, so a misconfigured process fails at
 * startup rather than on its first request. This is the only module permitted
 * to read the raw environment; an ESLint rule enforces that everywhere else.
 */
function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Names and messages only, never values — see `describeEnvIssues`, which
    // also names the offending variables in the first line, so a log viewer
    // that shows one line still says what is wrong.
    throw new Error(describeEnvIssues(parsed.error.issues));
  }

  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Every browser origin allowed to send credentialed requests to this API. */
export const trustedOrigins: readonly string[] = [
  env.APP_URL,
  ...(env.ADDITIONAL_TRUSTED_ORIGINS ?? []),
];
