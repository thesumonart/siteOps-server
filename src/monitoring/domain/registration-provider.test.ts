import { describe, expect, it, vi } from 'vitest';

import {
  lookupRegistration,
  registrableCandidates,
  type DomainLookupResult,
  type DomainRegistrationProvider,
} from './registration-provider.js';

/**
 * How SiteOps decides which name to look up, and which answer to believe.
 *
 * Both halves matter for correctness rather than convenience. Getting the
 * registrable domain wrong means querying `co.uk` and being told it is not
 * registered; treating a transient registry failure as an answer means either
 * a false expiry warning or a real one silently cleared.
 */

function provider(name: string, result: DomainLookupResult): DomainRegistrationProvider {
  return { name, lookup: () => Promise.resolve(result) };
}

const FOUND: DomainLookupResult = {
  outcome: 'found',
  registration: {
    domain: 'example.com',
    registrar: 'Example Registrar',
    registeredAt: new Date('2010-01-01T00:00:00Z'),
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    statuses: ['clientTransferProhibited'],
    nameServers: ['ns1.example.com'],
    source: 'rdap',
  },
};

describe('registrableCandidates', () => {
  it('starts from the two-label form, which is the common case', () => {
    expect(registrableCandidates('example.com')[0]).toBe('example.com');
    expect(registrableCandidates('www.example.com')[0]).toBe('example.com');
  });

  it('widens outwards so a multi-part suffix is reachable', () => {
    const candidates = registrableCandidates('shop.example.co.uk');

    expect(candidates).toContain('co.uk');
    expect(candidates).toContain('example.co.uk');
    // The registry answers "not found" for `co.uk` and "found" for
    // `example.co.uk`, which is what makes the walk work without a suffix list.
    expect(candidates.indexOf('co.uk')).toBeLessThan(candidates.indexOf('example.co.uk'));
  });

  it('bounds the walk rather than trying every depth', () => {
    expect(registrableCandidates('a.b.c.d.e.example.com').length).toBeLessThanOrEqual(3);
  });

  it('returns nothing for a name that cannot be registrable', () => {
    expect(registrableCandidates('localhost')).toEqual([]);
    expect(registrableCandidates('com')).toEqual([]);
  });

  it('lowercases and tolerates a trailing dot', () => {
    expect(registrableCandidates('WWW.Example.COM.')[0]).toBe('example.com');
  });
});

describe('lookupRegistration', () => {
  it('returns the first answer and does not ask further providers', async () => {
    const second = vi.fn(() => Promise.resolve<DomainLookupResult>({ outcome: 'not_found' }));

    const result = await lookupRegistration(
      [provider('rdap', FOUND), { name: 'whois', lookup: second }],
      'example.com',
      { timeoutMs: 1000 },
    );

    expect(result.outcome).toBe('found');
    expect(second).not.toHaveBeenCalled();
  });

  it('keeps asking after a provider that does not cover the TLD', async () => {
    const result = await lookupRegistration(
      [
        provider('rdap', { outcome: 'unsupported', reason: 'No RDAP for this TLD.' }),
        provider('whois', FOUND),
      ],
      'example.de',
      { timeoutMs: 1000 },
    );

    expect(result.outcome).toBe('found');
  });

  it('keeps asking after a not-found, since one provider not covering a TLD says nothing', async () => {
    const result = await lookupRegistration(
      [provider('rdap', { outcome: 'not_found' }), provider('whois', FOUND)],
      'example.com',
      { timeoutMs: 1000 },
    );

    expect(result.outcome).toBe('found');
  });

  it('reports not_found when a provider said so and none did better', async () => {
    const result = await lookupRegistration(
      [
        provider('rdap', { outcome: 'not_found' }),
        provider('whois', { outcome: 'error', reason: 'timed out' }),
      ],
      'not-registered.example',
      { timeoutMs: 1000 },
    );

    // A definite "this name is not registered" outranks a transient failure:
    // the registry that answered actually knows.
    expect(result.outcome).toBe('not_found');
  });

  it('reports an error only when every provider failed', async () => {
    const result = await lookupRegistration(
      [
        provider('rdap', { outcome: 'error', reason: 'RDAP responded with HTTP 503.' }),
        provider('whois', { outcome: 'error', reason: 'WHOIS query timed out.' }),
      ],
      'example.com',
      { timeoutMs: 1000 },
    );

    expect(result.outcome).toBe('error');
  });

  it('reports an error rather than silence when there are no providers', async () => {
    const result = await lookupRegistration([], 'example.com', { timeoutMs: 1000 });

    // Never `not_found`: no provider was asked, so nothing is known, and
    // reporting "not registered" would be an invented answer.
    expect(result.outcome).toBe('error');
  });
});
