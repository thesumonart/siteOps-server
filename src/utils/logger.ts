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

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  name: 'siteops',
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

/** Child logger tagged with a subsystem name. */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}
