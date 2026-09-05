import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'node:http';

import type { Auth } from '../config/auth.js';
import type { SessionDto, UserDto } from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type { RequestAuthContext } from '../types/auth.types.js';
import type { OrganizationService } from './organization.service.js';

/**
 * Session reads for the rest of the application.
 *
 * Sign-in, sign-up, verification and password reset are served by Better Auth's
 * own handler, mounted as raw middleware — it needs the unparsed request body,
 * which a route handler would already have consumed. What is left is
 * introspection, and this is the only place the rest of the codebase touches
 * the auth library: everything downstream sees a narrow
 * {@link RequestAuthContext} and never the raw session record.
 */
export class AuthService {
  constructor(
    private readonly auth: Auth,
    private readonly organizations: OrganizationService,
  ) {}

  /**
   * Resolves the session, or null when there is none.
   *
   * Never throws for "signed out": the session endpoint has to be able to tell
   * the browser that nobody is signed in without that looking like a failure.
   */
  async getSession(headers: IncomingHttpHeaders): Promise<RequestAuthContext | null> {
    const result = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!result) return null;

    return {
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        emailVerified: result.user.emailVerified,
      },
      session: {
        id: result.session.id,
        expiresAt: result.session.expiresAt,
      },
    };
  }

  /**
   * Resolves the session or refuses the request.
   *
   * An account that has not proven its address is refused too, with a distinct
   * code so the dashboard can route it to the confirmation screen rather than
   * the sign-in form. That check is here rather than only at sign-in because a
   * session can outlive a change to the account: verification must be
   * re-established on every request, not assumed from how the session started.
   */
  async requireSession(headers: IncomingHttpHeaders): Promise<RequestAuthContext> {
    const context = await this.getSession(headers);
    if (!context) throw ApiError.unauthenticated();

    if (!context.user.emailVerified) {
      throw new ApiError(403, 'Confirm your email address to continue.', 'EMAIL_NOT_VERIFIED');
    }

    return context;
  }

  /**
   * Everything the dashboard needs to render its shell on first paint.
   *
   * Memberships are omitted until the address is confirmed — an unverified
   * account cannot reach organization data anyway, and sending the list would
   * suggest otherwise.
   */
  async describeSession(headers: IncomingHttpHeaders): Promise<SessionDto | { user: null }> {
    const result = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!result) return { user: null };

    const user: UserDto = {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
      emailVerified: result.user.emailVerified,
      image: result.user.image ?? null,
      createdAt: result.user.createdAt.toISOString(),
    };

    if (!user.emailVerified) {
      return { user, memberships: [] };
    }

    return { user, memberships: await this.organizations.listForUser(user.id) };
  }
}
