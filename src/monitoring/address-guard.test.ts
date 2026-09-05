import { describe, expect, it } from 'vitest';

import { checkAddress } from './address-guard.js';

/**
 * This is the last line of defence against SSRF: whatever a hostname resolves
 * to, right before the socket connects, passes through here. Every range in
 * SECURITY.md is exercised, plus the loopback-allowance carve-out used only by
 * the integration suite.
 */
describe('checkAddress — production mode (allowLoopback: false)', () => {
  const opts = { allowLoopback: false } as const;

  it.each([
    '127.0.0.1',
    '127.0.0.53',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '240.0.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
  ])('blocks %s', (address) => {
    expect(checkAddress(address, opts).allowed).toBe(false);
  });

  it.each(['93.184.216.34', '1.1.1.1', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946'])(
    'allows %s',
    (address) => {
      expect(checkAddress(address, opts).allowed).toBe(true);
    },
  );

  it('reports why an address was blocked', () => {
    const verdict = checkAddress('169.254.169.254', opts);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('metadata');
  });
});

describe('checkAddress — test mode (allowLoopback: true)', () => {
  const opts = { allowLoopback: true } as const;

  it.each(['127.0.0.1', '127.1.2.3', '::1'])(
    'allows loopback %s for the mock server',
    (address) => {
      expect(checkAddress(address, opts).allowed).toBe(true);
    },
  );

  it.each([
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    'fe80::1',
    'fc00::1',
    '::ffff:10.0.0.1',
  ])(
    'still blocks %s — loopback allowance is not a general private-network allowance',
    (address) => {
      expect(checkAddress(address, opts).allowed).toBe(false);
    },
  );
});
