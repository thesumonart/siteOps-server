import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { logger } from '../utils/logger.js';

/** Client-supplied ids are echoed only if they look like ids, never raw. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Assigns every request a correlation id and logs its completion.
 *
 * The id is echoed in `X-Request-Id` so a user-reported failure can be traced
 * to the exact log line, and it is attached to `req.id` for the error handler.
 *
 * Request bodies are never logged: they carry passwords and tokens. Neither are
 * query strings — a verification or reset link puts a working credential in
 * one, and a log aggregator is exactly the wrong place for that to end up.
 */
export function requestId(request: Request, response: Response, next: NextFunction): void {
  const inbound = request.header('x-request-id');
  const id = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();

  request.id = id;
  response.setHeader('X-Request-Id', id);

  const startedAt = process.hrtime.bigint();

  response.on('finish', () => {
    // Failures are logged in detail by the error handler; logging them here as
    // well would double every error line.
    if (response.statusCode >= 400) return;

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    logger.info(
      {
        requestId: id,
        method: request.method,
        path: request.originalUrl.split('?')[0] ?? request.originalUrl,
        status: response.statusCode,
        durationMs: Math.round(durationMs),
        userId: request.auth?.user.id,
        organizationId: request.organization?.id,
      },
      'request.completed',
    );
  });

  next();
}
