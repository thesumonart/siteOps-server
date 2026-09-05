import type { Request, Response } from 'express';

import { pingDatabase } from '../database/connection.js';
import { ApiError } from '../errors/ApiError.js';
import { ApiResponse } from '../responses/ApiResponse.js';

/**
 * Liveness and readiness probes.
 *
 * `/health` answers "is this process running" and must never touch a
 * dependency — a slow database would otherwise make the platform restart a
 * perfectly healthy API and turn a degraded system into an outage. `/health/ready`
 * answers "can this process serve traffic" and does check dependencies, so a
 * deploy is not routed traffic before MongoDB is reachable.
 *
 * Both are outside the API prefix and outside authentication: a probe that
 * needed a session would fail for the platform running it.
 */
export class HealthController {
  liveness = (_request: Request, response: Response): void => {
    ApiResponse.ok(response, { status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  };

  readiness = async (_request: Request, response: Response): Promise<void> => {
    const databaseReachable = await pingDatabase();
    if (!databaseReachable) {
      throw ApiError.serviceUnavailable('The database is not reachable.');
    }
    ApiResponse.ok(response, { status: 'ready', checks: { database: 'ok' } });
  };
}
