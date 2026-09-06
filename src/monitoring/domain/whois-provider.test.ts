import { describe, expect, it } from 'vitest';

import { looksLikeNotFound, parseWhoisDate, parseWhoisFields } from './whois-provider.js';

/**
 * WHOIS parsing.
 *
 * WHOIS has no schema, so this is heuristics over free text, and the heuristics
 * are the whole risk. A date parsed wrongly could read years into the future
 * and silence a genuine expiry warning — which is why anything unrecognised
 * must become null rather than a guess.
 */

describe('parseWhoisFields', () => {
  it('reads label/value pairs', () => {
    const fields = parseWhoisFields(
      ['Domain Name: EXAMPLE.COM', 'Registrar: Example Registrar, Inc.'].join('\n'),
    );

    expect(fields.get('domain name')).toEqual(['EXAMPLE.COM']);
    expect(fields.get('registrar')).toEqual(['Example Registrar, Inc.']);
  });

  it('collects repeated labels rather than overwriting', () => {
    const fields = parseWhoisFields(
      ['Name Server: ns1.example.com', 'Name Server: ns2.example.com'].join('\n'),
    );

    expect(fields.get('name server')).toEqual(['ns1.example.com', 'ns2.example.com']);
  });

  it('skips the legal boilerplate every registry appends', () => {
    const fields = parseWhoisFields(
      [
        '% This data is provided for information purposes only.',
        '# Terms of use: https://example.test/tos',
        '>>> Last update of WHOIS database: 2026-01-01 <<<',
        'Registrar: Real Value',
      ].join('\n'),
    );

    expect(fields.size).toBe(1);
    expect(fields.get('registrar')).toEqual(['Real Value']);
  });

  it('keeps a value containing a colon intact', () => {
    const fields = parseWhoisFields('Registrar URL: https://example.test/whois');
    expect(fields.get('registrar url')).toEqual(['https://example.test/whois']);
  });

  it('handles CRLF line endings, which most registries send', () => {
    const fields = parseWhoisFields('Registrar: Example\r\nName Server: ns1.example.com\r\n');
    expect(fields.get('registrar')).toEqual(['Example']);
    expect(fields.get('name server')).toEqual(['ns1.example.com']);
  });
});

describe('parseWhoisDate', () => {
  it('parses ISO 8601, with and without a time', () => {
    expect(parseWhoisDate('2030-03-04T12:00:00Z')?.toISOString()).toBe('2030-03-04T12:00:00.000Z');
    expect(parseWhoisDate('2030-03-04')?.toISOString()).toBe('2030-03-04T00:00:00.000Z');
    expect(parseWhoisDate('2030-03-04 12:00:00')).not.toBeNull();
  });

  it('parses the dd-Mon-yyyy form several registries still use', () => {
    expect(parseWhoisDate('04-Mar-2030')?.toISOString()).toBe('2030-03-04T00:00:00.000Z');
  });

  it('parses the dotted year-first form', () => {
    expect(parseWhoisDate('2030.03.04')?.toISOString()).toBe('2030-03-04T00:00:00.000Z');
  });

  it('refuses an ambiguous slash-separated date rather than guessing', () => {
    // 04/03/2030 is 4 March in most of the world and 3 April in the US. A wrong
    // guess here is a month of missing warning, so neither reading is taken.
    expect(parseWhoisDate('04/03/2030')).toBeNull();
  });

  it('returns null for anything unrecognised', () => {
    expect(parseWhoisDate('not a date')).toBeNull();
    expect(parseWhoisDate('')).toBeNull();
    expect(parseWhoisDate(null)).toBeNull();
  });

  it('returns null for a well-shaped but impossible date', () => {
    expect(parseWhoisDate('2030-13-45')).toBeNull();
  });
});

describe('looksLikeNotFound', () => {
  it('recognises the common phrasings', () => {
    for (const response of [
      'No match for "NOTREGISTERED.COM".',
      'NOT FOUND',
      'No entries found in the registry.',
      'Domain not found.',
      'Status: free',
    ]) {
      expect(looksLikeNotFound(response)).toBe(true);
    }
  });

  it('does not mistake a real record for an absence', () => {
    expect(
      looksLikeNotFound('Domain Name: EXAMPLE.COM\nRegistry Expiry Date: 2030-01-01T00:00:00Z'),
    ).toBe(false);
  });
});
