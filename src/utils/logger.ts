import { pino, type Logger } from 'pino';

import { env, isProduction } from '../config/env.js';

/**
 * Structured application logger.
 *
 * Production emits newline-delimited JSON for log aggregation; development uses
 * a readable single-line format. Redaction is declared here rather than at call
 * sites so a secret cannot be logged by an author who forgets — the list is the
 * guarantee, not the discipline of whoever writes the next log line.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'password',
  'newPassword',
  'currentPassword',
  '*.password',
  'token',
  'sessionToken',
  'tokenHash',
  '*.token',
  'secret',
  'apiKey',
  'MONGODB_URI',
  'AUTH_SECRET',
  'RESEND_API_KEY',
];

/**
 * Whether to run the human-readable pretty printer.
 *
 * `pino-pretty` is a *transport*, which pino runs in a worker thread. That is
 * fine for a long-lived server and wrong everywhere else: a short-lived process
 * — a script, a test worker — can exit while the transport thread is still
 * starting or flushing, and thread-stream aborts the process when that happens.
 * It dies without running an exit handler, so it surfaces as an unexplained
 * "worker exited unexpectedly" rather than as an error anyone can read.
 *
 * So the transport is attached only when it has something to print: never in
 * production, which wants JSON, and never at `silent`, which is what the test
 * runner sets.
 */
const usePrettyTransport = !isProduction && env.LOG_LEVEL !== 'silent';

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  name: 'siteops',
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(usePrettyTransport
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

/** Child logger tagged with a subsystem name. */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}
