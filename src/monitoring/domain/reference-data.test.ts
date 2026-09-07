import { describe, expect, it } from 'vitest';

import {
  parsePublicSuffixList,
  parseRdapBootstrap,
  registrableDomainFrom,
} from './reference-data.js';

/**
 * Where a registrable domain begins, and which server to ask about it.
 *
 * Both of these were wrong in production and both failures were silent. The
 * suffix rules decide whether `www.bbc.co.uk` is looked up as `bbc.co.uk` or as
 * `co.uk` — and `co.uk` is a real RDAP object that answers HTTP 200 with a
 * registrar and no expiry date, so getting it wrong produces a confident wrong
 * answer rather than an obvious failure.
 */

const LIST = [
  '// This Source Code Form is subject to the terms of the MPL.',
  '',
  '// ===BEGIN ICANN DOMAINS===',
  '',
  '// com : https://example',
  'com',
  '',
  '// uk',
  'uk',
  'co.uk',
  'ac.uk',
  '',
  '// bd : no second level list published',
  '*.bd',
  '',
  '// ck',
  'ck',
  '*.ck',
  '!www.ck',
  '',
  '// ===END ICANN DOMAINS===',
  '',
  '// ===BEGIN PRIVATE DOMAINS===',
  'github.io',
  'vercel.app',
  '// ===END PRIVATE DOMAINS===',
].join('\n');

const rules = parsePublicSuffixList(LIST);

describe('parsePublicSuffixList', () => {
  it('reads only the ICANN section', () => {
    expect(rules.normal.has('com')).toBe(true);
    /*
     * The private section is the right answer for cookie scoping and the wrong
     * one here: nobody registers `siteops.vercel.app` at a registrar, so
     * treating it as a suffix would turn every such lookup into a guaranteed
     * miss. What is registered is `vercel.app`.
     */
    expect(rules.normal.has('github.io')).toBe(false);
    expect(rules.normal.has('vercel.app')).toBe(false);
  });

  it('separates wildcard and exception rules from ordinary ones', () => {
    expect(rules.wildcard.has('bd')).toBe(true);
    expect(rules.exception.has('www.ck')).toBe(true);
    expect(rules.normal.has('*.bd')).toBe(false);
  });

  it('refuses a document with no rules rather than caching an empty list', () => {
    // An empty result would silently disable every suffix decision, which is
    // indistinguishable from the bug this module exists to fix.
    expect(() => parsePublicSuffixList('// nothing here')).toThrow(/no ICANN rules/i);
  });
});

describe('registrableDomainFrom', () => {
  it('takes one label below a single-label suffix', () => {
    expect(registrableDomainFrom('example.com', rules)).toBe('example.com');
    expect(registrableDomainFrom('www.example.com', rules)).toBe('example.com');
    expect(registrableDomainFrom('a.b.c.example.com', rules)).toBe('example.com');
  });

  it('prefers the longest matching rule', () => {
    // Both `uk` and `co.uk` match; `co.uk` is longer and wins.
    expect(registrableDomainFrom('www.bbc.co.uk', rules)).toBe('bbc.co.uk');
    expect(registrableDomainFrom('dept.ox.ac.uk', rules)).toBe('ox.ac.uk');
  });

  it('resolves a wildcard suffix to the right depth', () => {
    // `*.bd` makes `com.bd` the suffix, so three labels are registrable.
    expect(registrableDomainFrom('example.com.bd', rules)).toBe('example.com.bd');
    expect(registrableDomainFrom('www.shop.example.com.bd', rules)).toBe('example.com.bd');
  });

  it('lets an exception rule beat its wildcard', () => {
    expect(registrableDomainFrom('www.ck', rules)).toBe('www.ck');
    expect(registrableDomainFrom('sub.www.ck', rules)).toBe('www.ck');
    // Still governed by `*.ck` where the exception does not apply.
    expect(registrableDomainFrom('a.foo.ck', rules)).toBe('a.foo.ck');
  });

  it('returns null for a name that is itself a public suffix', () => {
    expect(registrableDomainFrom('co.uk', rules)).toBeNull();
    expect(registrableDomainFrom('com', rules)).toBeNull();
    expect(registrableDomainFrom('com.bd', rules)).toBeNull();
  });

  it('returns null for an unlisted suffix instead of guessing two labels', () => {
    /*
     * The specification's default is the `*` rule, which would make
     * `example.invalidtld` registrable. Answering "unknown" instead is what
     * lets the caller fall back to asking the registry, which is authoritative
     * where a stale list is not.
     */
    expect(registrableDomainFrom('example.invalidtld', rules)).toBeNull();
    expect(registrableDomainFrom('a.b.unknown', rules)).toBeNull();
  });

  it('lowercases and tolerates a trailing dot', () => {
    expect(registrableDomainFrom('WWW.Example.COM.', rules)).toBe('example.com');
  });

  it('returns null for a single label', () => {
    expect(registrableDomainFrom('localhost', rules)).toBeNull();
  });
});

describe('parseRdapBootstrap', () => {
  const document = JSON.stringify({
    description: 'RDAP bootstrap file',
    services: [
      [['dev', 'app'], ['https://pubapi.registry.google/rdap/']],
      [['uk'], ['https://rdap.nominet.uk/uk/']],
      // A registry publishing both; https must win, or a domain query travels
      // in clear text.
      [['example'], ['http://rdap.example/', 'https://rdap.example/']],
      // Malformed entries must be skipped, not throw.
      [['broken']],
      'nonsense',
    ],
  });

  it('maps every TLD in a service entry to its base URL', () => {
    const bootstrap = parseRdapBootstrap(document);

    expect(bootstrap.get('dev')).toBe('https://pubapi.registry.google/rdap');
    expect(bootstrap.get('app')).toBe('https://pubapi.registry.google/rdap');
    expect(bootstrap.get('uk')).toBe('https://rdap.nominet.uk/uk');
  });

  it('prefers https over plaintext', () => {
    expect(parseRdapBootstrap(document).get('example')).toBe('https://rdap.example');
  });

  it('skips malformed entries without failing the whole document', () => {
    expect(parseRdapBootstrap(document).has('broken')).toBe(false);
  });

  it('refuses a document that lists nothing', () => {
    expect(() => parseRdapBootstrap('{"services":[]}')).toThrow(/listed no services/i);
    expect(() => parseRdapBootstrap('{}')).toThrow(/no services array/i);
  });
});
