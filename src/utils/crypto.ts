import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token generation and comparison for bearer credentials the API mints itself.
 *
 * Only invitation tokens live here. Passwords, sessions and email-verification
 * tokens are Better Auth's, and re-implementing any of them is how
 * authentication bugs happen — see `src/services/auth.service.ts`.
 */

/** 32 bytes of entropy, URL-safe. Long enough that guessing is not a threat model. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 of a token, for storage.
 *
 * A token is a bearer credential: anyone holding it can act on the invitation.
 * Storing only the hash means a leaked database does not yield working links.
 * No salt and no key stretching, deliberately — the input is 256 bits of
 * randomness, not a password, so there is nothing for a rainbow table or a
 * brute-force to shorten.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time string comparison.
 *
 * Used where a mismatch would otherwise be observable by timing — comparing the
 * address an invitation was sent to against the address that is signed in, for
 * example. Lengths are compared first because `timingSafeEqual` throws on
 * unequal buffers, and a length difference is not the secret being protected.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Case- and whitespace-insensitive constant-time comparison of two addresses. */
export function emailsMatch(a: string, b: string): boolean {
  return safeEqual(a.trim().toLowerCase(), b.trim().toLowerCase());
}
