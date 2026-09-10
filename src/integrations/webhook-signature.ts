import { createHmac } from 'node:crypto';

import { generateToken } from '../utils/crypto.js';

/**
 * Signing for outgoing webhooks.
 *
 * The header is `t=<unix seconds>,v1=<hex HMAC-SHA256>`, over `${t}.${body}`.
 * That is Stripe's scheme, adopted for the reasons SiteOps already verifies
 * Stripe's own webhooks that way (see docs/SECURITY.md):
 *
 *  - The signature covers the exact bytes sent, so a receiver must verify the
 *    raw body before parsing it — which is the only way verification means
 *    anything.
 *  - The timestamp is inside the signed string. Without it a captured request
 *    stays valid forever and can be replayed at the receiver; with it, the
 *    receiver refuses anything older than its tolerance.
 *  - `v1` names the scheme, so a future one can be sent alongside it during a
 *    migration without breaking a receiver that only knows this one.
 *
 * Verification is the receiver's job and is not implemented here: SiteOps
 * never receives its own webhooks. The reference implementation receivers can
 * copy lives in docs/API.md, and the test suite verifies deliveries exactly as
 * it describes.
 */

/** Marks a value as a SiteOps signing secret wherever it is pasted. */
export const SIGNING_SECRET_PREFIX = 'so_whsec_';

/** 256 bits of randomness. Shown once, then stored sealed. */
export function generateSigningSecret(): string {
  return `${SIGNING_SECRET_PREFIX}${generateToken()}`;
}

export function signWebhookBody(secret: string, body: string, timestampSeconds: number): string {
  const digest = createHmac('sha256', secret)
    .update(`${String(timestampSeconds)}.${body}`)
    .digest('hex');

  return `t=${String(timestampSeconds)},v1=${digest}`;
}
