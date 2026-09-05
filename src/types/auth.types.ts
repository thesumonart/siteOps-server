/**
 * The authenticated principal, as resolved from the session cookie.
 *
 * Deliberately narrow: handlers get an id, an address, a display name and a
 * verification flag — never the raw session record. Anything more would tempt
 * callers to trust a field the client can influence.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
}

export interface AuthenticatedSession {
  readonly id: string;
  readonly expiresAt: Date;
}

export interface RequestAuthContext {
  readonly user: AuthenticatedUser;
  readonly session: AuthenticatedSession;
}

/** What an audited action records about who performed it. */
export interface Actor {
  readonly id: string;
  readonly name: string;
}
