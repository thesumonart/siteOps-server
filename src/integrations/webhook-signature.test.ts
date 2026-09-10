import { createHmac, timingSafeEqual } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from '../contracts/index.js';
import {
  SIGNING_SECRET_PREFIX,
  generateSigningSecret,
  signWebhookBody,
} from './webhook-signature.js';

/**
 * Verifies a signature the way docs/API.md tells a receiver to.
 *
 * Written here rather than exported from the source, because SiteOps never
 * receives its own webhooks. It is the reference a receiver copies, so these
 * tests prove the documented procedure accepts what SiteOps sends and refuses
 * what it should.
 */
function verify(header: string, body: string, secret: string, nowSeconds: number): boolean {
  const parts = new Map(
    header.split(',').map((part) => {
      const [key, ...value] = part.split('=');
      return [key ?? '', value.join('=')] as const;
    }),
  );

  const timestamp = Number(parts.get('t'));
  const signature = parts.get('v1') ?? '';
  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

const SECRET = 'so_whsec_test-secret';
const BODY = JSON.stringify({ type: 'website.down', data: { website: { name: 'Acme' } } });
const NOW = 1_760_000_000;

describe('webhook signatures', () => {
  it('uses the t=…,v1=… header format receivers parse', () => {
    expect(signWebhookBody(SECRET, BODY, NOW)).toMatch(/^t=1760000000,v1=[0-9a-f]{64}$/);
  });

  it('verifies with the documented receiver procedure', () => {
    const header = signWebhookBody(SECRET, BODY, NOW);
    expect(verify(header, BODY, SECRET, NOW)).toBe(true);
  });

  it('fails verification when a single byte of the body changes', () => {
    const header = signWebhookBody(SECRET, BODY, NOW);
    expect(verify(header, BODY.replace('Acme', 'Acmf'), SECRET, NOW)).toBe(false);
  });

  it('fails verification under another secret', () => {
    const header = signWebhookBody(SECRET, BODY, NOW);
    expect(verify(header, BODY, 'so_whsec_someone-else', NOW)).toBe(false);
  });

  it('binds the timestamp, so a captured request cannot be replayed later', () => {
    const header = signWebhookBody(SECRET, BODY, NOW);
    // Inside the tolerance it is accepted; beyond it, the same bytes are not.
    expect(verify(header, BODY, SECRET, NOW + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS)).toBe(true);
    expect(verify(header, BODY, SECRET, NOW + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1)).toBe(false);

    // And moving the timestamp forward to dodge that breaks the signature.
    const forged = header.replace(`t=${String(NOW)}`, `t=${String(NOW + 3600)}`);
    expect(verify(forged, BODY, SECRET, NOW + 3600)).toBe(false);
  });

  it('generates prefixed, high-entropy secrets that never repeat', () => {
    const first = generateSigningSecret();
    const second = generateSigningSecret();

    expect(first.startsWith(SIGNING_SECRET_PREFIX)).toBe(true);
    // 32 random bytes, base64url: 43 characters after the prefix.
    expect(first.length).toBe(SIGNING_SECRET_PREFIX.length + 43);
    expect(first).not.toBe(second);
  });
});
