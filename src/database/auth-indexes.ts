import { type Db } from 'mongodb';

import { getMongoDb } from './connection.js';

/**
 * Indexes for the collections owned by the authentication layer.
 *
 * Better Auth creates its documents but not its indexes, and its uniqueness
 * checks are read-then-write rather than atomic. Without a unique index on
 * `user.email`, two sign-ups racing on the same address can both pass the check
 * and create two accounts for one person — so the guarantee is enforced here,
 * by the database, exactly as it is for incidents and notifications.
 *
 * Email case is not a concern: Better Auth lowercases addresses before storing
 * them, so a plain unique index is sufficient and no collation is needed.
 */

export interface AuthIndexDefinition {
  readonly collection: string;
  readonly key: Record<string, 1 | -1>;
  readonly name: string;
  readonly unique?: boolean;
  readonly expireAfterSeconds?: number;
  readonly purpose: string;
}

export const AUTH_INDEXES: readonly AuthIndexDefinition[] = [
  {
    collection: 'user',
    key: { email: 1 },
    name: 'user_email_unique',
    unique: true,
    purpose: 'One account per email address, enforced against concurrent sign-ups.',
  },
  {
    collection: 'session',
    key: { token: 1 },
    name: 'session_token_unique',
    unique: true,
    purpose: 'Session lookup on every authenticated request.',
  },
  {
    collection: 'session',
    key: { userId: 1 },
    name: 'session_by_user',
    purpose: 'Revoking every session for a user, such as after a password reset.',
  },
  {
    collection: 'session',
    key: { expiresAt: 1 },
    name: 'session_ttl',
    // Mongo removes expired sessions on its own, so the collection cannot grow
    // without bound if a sign-out is never issued.
    expireAfterSeconds: 0,
    purpose: 'Automatic cleanup of expired sessions.',
  },
  {
    collection: 'account',
    key: { userId: 1 },
    name: 'account_by_user',
    purpose: 'Credential lookup during sign-in.',
  },
  {
    collection: 'verification',
    key: { identifier: 1 },
    name: 'verification_by_identifier',
    purpose: 'Verification and password-reset token lookup.',
  },
  {
    collection: 'verification',
    key: { expiresAt: 1 },
    name: 'verification_ttl',
    expireAfterSeconds: 0,
    purpose: 'Expired tokens are removed rather than left to accumulate.',
  },
];

export async function syncAuthIndexes(db: Db = getMongoDb()): Promise<number> {
  for (const definition of AUTH_INDEXES) {
    await db.collection(definition.collection).createIndex(definition.key, {
      name: definition.name,
      ...(definition.unique === true ? { unique: true } : {}),
      ...(definition.expireAfterSeconds === undefined
        ? {}
        : { expireAfterSeconds: definition.expireAfterSeconds }),
    });
  }
  return AUTH_INDEXES.length;
}
