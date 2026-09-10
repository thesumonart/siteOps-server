import type { ApiKeyScope } from '../contracts/index.js';

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

/**
 * The API key a public API request authenticated with.
 *
 * Set only by `requireApiKey`, only on `/api/v1`. A request there never has a
 * session: the key is the whole of its identity, and `scopes` are the whole of
 * what it may do.
 */
export interface ApiKeyContext {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
  /** The person who issued the key. Audit entries name them, alongside the key. */
  readonly createdByUserId: string;
}

/** What an audited action records about who performed it. */
export interface Actor {
  readonly id: string;
  readonly name: string;
}
