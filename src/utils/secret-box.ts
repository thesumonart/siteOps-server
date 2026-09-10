import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { env } from '../config/env.js';

/**
 * Authenticated encryption for credentials SiteOps must be able to use again.
 *
 * Most secrets here are stored as hashes — invitation tokens, and API keys —
 * because they only ever need to be *checked*. A notification channel is the
 * exception: a Slack webhook URL has to be presented to Slack, and a webhook
 * signing secret has to sign. Those must be recoverable, so they are sealed
 * with AES-256-GCM rather than kept in the clear. A leaked database, or a
 * backup left in the wrong bucket, then yields ciphertext rather than the
 * ability to post into every customer's Slack.
 *
 * GCM authenticates as well as encrypts: a tampered value fails to open rather
 * than decrypting to something else. The caller binds a context — the owning
 * organization — in as associated data, so a ciphertext copied onto another
 * tenant's document does not open there either.
 *
 * The key is derived from `AUTH_SECRET` with HKDF rather than configured
 * separately, so no deployment gains a new required variable. The consequence
 * is stated plainly: rotating `AUTH_SECRET` makes every sealed value
 * unreadable. A channel whose credentials cannot be opened fails its deliveries
 * with a reason that says to re-enter the URL — the same order of consequence
 * rotation already has for every signed-in session.
 */

// Derived once at import. HKDF over a 32+ character secret is the standard
// construction for turning a shared secret into a purpose-bound key, and the
// `info` label keeps this key distinct from anything else ever derived from it.
const KEY = Buffer.from(
  hkdfSync('sha256', env.AUTH_SECRET, 'siteops', 'sealed-credentials:v1', 32),
);

/** Leads every sealed value, so a future key or cipher change can tell old from new. */
const VERSION = 'v1';
const IV_BYTES = 12;

/** Seals a secret. `context` must be supplied again, identically, to open it. */
export function sealSecret(plaintext: string, context: string): string {
  // A fresh random IV per value. Reusing an IV under one GCM key is
  // catastrophic, and 96 random bits make a collision a non-event at any
  // number of channels this product will ever hold.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Opens a sealed secret, or returns null.
 *
 * Null rather than a throw for every failure — a malformed value, a tampered
 * one, the wrong context, a key that has since changed — because the caller's
 * only useful response to each is the same: report that the stored credential
 * is unusable. Which of them it was is not something to explain to anyone.
 */
export function openSecret(sealed: string, context: string): string | null {
  const [version, iv, tag, ciphertext, ...rest] = sealed.split(':');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined || rest.length > 0) {
    return null;
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
