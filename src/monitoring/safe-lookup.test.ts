import { describe, expect, it } from 'vitest';

import { createSafeLookup, type Resolver } from './safe-lookup.js';

function fakeResolver(addresses: readonly { address: string; family: number }[]): Resolver {
  return (_hostname, _options, callback) => {
    callback(null, [...addresses]);
  };
}

function run(
  lookup: ReturnType<typeof createSafeLookup>,
  hostname: string,
  options: { all?: boolean } = {},
): Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family?: number }> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => {
      resolve({ error, address, family });
    });
  });
}

describe('createSafeLookup — DNS rebinding', () => {
  it('refuses a hostname that resolves only to a private address', async () => {
    const lookup = createSafeLookup({
      allowLoopback: false,
      resolver: fakeResolver([{ address: '169.254.169.254', family: 4 }]),
    });

    const result = await run(lookup, 'attacker-controlled.example');

    expect(result.error).not.toBeNull();
    expect(result.error?.code).toBe('SITEOPS_BLOCKED_ADDRESS');
  });

  it('is the layer that actually stops rebinding: a hostname answering with a public address at validation time and a private one at connect time is blocked here, because this callback runs at connect time', async () => {
    // The point of installing this as the socket's own `lookup` is that there is
    // no gap between "check the address" and "connect to the address" for an
    // attacker to change the DNS answer in. This test proves the connect-time
    // resolution — simulating the attacker's second, malicious answer — is
    // rejected exactly like any other private address would be.
    const lookup = createSafeLookup({
      allowLoopback: false,
      resolver: fakeResolver([{ address: '10.0.0.5', family: 4 }]),
    });

    const result = await run(lookup, 'rebinding-target.example');

    expect(result.error?.code).toBe('SITEOPS_BLOCKED_ADDRESS');
  });

  it('drops only the blocked addresses when a hostname resolves to a mix', async () => {
    const lookup = createSafeLookup({
      allowLoopback: false,
      resolver: fakeResolver([
        { address: '169.254.169.254', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ]),
    });

    const result = await run(lookup, 'mixed.example', { all: true });

    expect(result.error).toBeNull();
    expect(result.address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('returns only the first permitted address when `all` is not requested', async () => {
    const lookup = createSafeLookup({
      allowLoopback: false,
      resolver: fakeResolver([
        { address: '169.254.169.254', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ]),
    });

    const result = await run(lookup, 'mixed.example');

    expect(result.error).toBeNull();
    expect(result.address).toBe('93.184.216.34');
    expect(result.family).toBe(4);
  });

  it('allows a genuinely public address', async () => {
    const lookup = createSafeLookup({
      allowLoopback: false,
      resolver: fakeResolver([{ address: '93.184.216.34', family: 4 }]),
    });

    const result = await run(lookup, 'example.com');

    expect(result.error).toBeNull();
    expect(result.address).toBe('93.184.216.34');
  });

  it('propagates a genuine DNS failure rather than masking it as a block', async () => {
    const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const lookup = createSafeLookup({
      allowLoopback: false,
      resolver: (_hostname, _options, callback) => {
        callback(dnsError, []);
      },
    });

    const result = await run(lookup, 'nonexistent.example');

    expect(result.error?.code).toBe('ENOTFOUND');
  });

  it('only allows loopback in test mode, never other private ranges', async () => {
    const lookup = createSafeLookup({
      allowLoopback: true,
      resolver: fakeResolver([{ address: '127.0.0.1', family: 4 }]),
    });
    const loopbackResult = await run(lookup, 'localhost');
    expect(loopbackResult.error).toBeNull();

    const privateLookup = createSafeLookup({
      allowLoopback: true,
      resolver: fakeResolver([{ address: '10.0.0.1', family: 4 }]),
    });
    const privateResult = await run(privateLookup, 'internal.example');
    expect(privateResult.error?.code).toBe('SITEOPS_BLOCKED_ADDRESS');
  });
});
