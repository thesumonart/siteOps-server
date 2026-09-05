import type { Request, Response } from 'express';

import { ApiResponse } from '../responses/ApiResponse.js';
import type { AuthService } from '../services/auth.service.js';

/**
 * Session introspection for the browser.
 *
 * Sign-in, sign-up, verification and password reset are served by Better Auth's
 * own handler, mounted as middleware in `app.ts` — it needs the unparsed
 * request body, which a controller would already have consumed. Only the read
 * is here.
 */
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * The signed-in user with their organizations, or `{ user: null }`.
   *
   * Public and null-returning by design: the browser needs to distinguish
   * "signed out" from "request failed", and a 401 here would make every first
   * paint look like an error. `emailVerified` is included so the dashboard can
   * route an unverified account to the confirmation screen rather than the
   * dashboard it cannot use.
   */
  currentSession = async (request: Request, response: Response): Promise<void> => {
    const session = await this.auth.describeSession(request.headers);
    ApiResponse.ok(response, session);
  };
}
