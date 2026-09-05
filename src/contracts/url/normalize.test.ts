import { describe, expect, it } from 'vitest';

import { displayUrl, isMonitorableUrl, normalizeWebsiteUrl } from './normalize.js';

function expectRejected(input: string, reason: string): void {
  const result = normalizeWebsiteUrl(input);
  expect(result.ok, `expected "${input}" to be rejected`).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

function expectAccepted(input: string): string {
  const result = normalizeWebsiteUrl(input);
  expect(result.ok, `expected "${input}" to be accepted`).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  return result.value.href;
}

describe('normalizeWebsiteUrl — accepted input', () => {
  it('defaults a bare domain to https', () => {
    expect(expectAccepted('acme.com')).toBe('https://acme.com/');
    expect(expectAccepted('  acme.com  ')).toBe('https://acme.com/');
    expect(expectAccepted('//acme.com')).toBe('https://acme.com/');
  });

  it('preserves an explicit http scheme', () => {
    expect(expectAccepted('http://acme.com')).toBe('http://acme.com/');
  });

  it('lowercases the hostname but keeps path case', () => {
    expect(expectAccepted('https://ACME.com/Status')).toBe('https://acme.com/Status');
  });

  it('drops default ports and keeps non-default ones', () => {
    expect(expectAccepted('https://acme.com:443/')).toBe('https://acme.com/');
    expect(expectAccepted('http://acme.com:80/')).toBe('http://acme.com/');
    expect(expectAccepted('https://acme.com:8443/')).toBe('https://acme.com:8443/');
  });

  it('removes the fragment, which never reaches the server', () => {
    expect(expectAccepted('https://acme.com/page#section')).toBe('https://acme.com/page');
  });

  it('keeps the query string', () => {
    expect(expectAccepted('https://acme.com/health?deep=1')).toBe('https://acme.com/health?deep=1');
  });

  it('accepts a public IP literal', () => {
    expect(expectAccepted('http://93.184.216.34')).toBe('http://93.184.216.34/');
  });

  it('accepts a trailing root dot and normalizes it away', () => {
    expect(expectAccepted('https://acme.com./')).toBe('https://acme.com/');
  });
});

describe('normalizeWebsiteUrl — canonical key', () => {
  const keyOf = (input: string): string => {
    const result = normalizeWebsiteUrl(input);
    if (!result.ok) throw new Error(result.detail);
    return result.value.canonicalKey;
  };

  it('treats scheme, www and trailing slash as the same website', () => {
    const expected = 'acme.com';
    expect(keyOf('https://acme.com')).toBe(expected);
    expect(keyOf('http://acme.com/')).toBe(expected);
    expect(keyOf('https://www.acme.com/')).toBe(expected);
    expect(keyOf('ACME.com')).toBe(expected);
  });

  it('keeps distinct paths and ports distinct', () => {
    expect(keyOf('https://acme.com/status')).toBe('acme.com/status');
    expect(keyOf('https://acme.com:8443')).toBe('acme.com:8443');
    expect(keyOf('https://shop.acme.com')).toBe('shop.acme.com');
  });
});

describe('normalizeWebsiteUrl — dangerous protocols', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://acme.com',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'gopher://acme.com',
    'ws://acme.com',
    'chrome://settings',
  ])('rejects %s', (input) => {
    const result = normalizeWebsiteUrl(input);
    expect(result.ok).toBe(false);
  });
});

describe('normalizeWebsiteUrl — SSRF targets', () => {
  it.each([
    'http://localhost',
    'http://localhost:3000',
    'https://LOCALHOST',
    'http://app.localhost',
    'http://printer.local',
    'http://db.internal',
    'http://jenkins.corp',
    'http://nas.lan',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://instance-data',
    'http://something.onion',
  ])('rejects internal hostname %s', (input) => {
    expectRejected(input, 'blocked_hostname');
  });

  it.each([
    'http://127.0.0.1',
    'http://127.0.0.1:8080/admin',
    'http://10.0.0.5',
    'http://192.168.1.1',
    'http://172.16.0.1',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/',
    'http://[::1]',
    'http://[fe80::1]',
    'http://[fd00:ec2::254]',
    'http://[::ffff:127.0.0.1]',
    'http://0.0.0.0',
  ])('rejects internal address %s', (input) => {
    expectRejected(input, 'blocked_ip');
  });

  it('rejects single-label hostnames resolved through search domains', () => {
    expectRejected('http://intranet', 'blocked_hostname');
    expectRejected('http://router', 'blocked_hostname');
  });

  it('rejects embedded credentials rather than silently stripping them', () => {
    expectRejected('https://admin:hunter2@acme.com', 'credentials_present');
  });

  it('rejects decimal and octal encodings of loopback', () => {
    // 2130706433 === 127.0.0.1. It is not a dotted quad, so it is treated as a
    // single-label hostname and refused before any DNS lookup happens.
    expect(isMonitorableUrl('http://2130706433')).toBe(false);
    expect(isMonitorableUrl('http://0177.0.0.1')).toBe(false);
    expect(isMonitorableUrl('http://127.1')).toBe(false);
  });
});

describe('normalizeWebsiteUrl — malformed input', () => {
  it('rejects empty input', () => {
    expectRejected('', 'empty');
    expectRejected('   ', 'empty');
  });

  it('rejects an over-long URL', () => {
    expectRejected(`https://acme.com/${'a'.repeat(2100)}`, 'too_long');
  });

  it('rejects values that cannot be parsed as a URL', () => {
    expect(isMonitorableUrl('https://')).toBe(false);
    expect(isMonitorableUrl('http://[not-an-address]')).toBe(false);
  });
});

describe('displayUrl', () => {
  it('strips the scheme and trailing slash', () => {
    expect(displayUrl('https://acme.com/')).toBe('acme.com');
    expect(displayUrl('http://acme.com/status')).toBe('acme.com/status');
  });

  it('truncates long URLs', () => {
    expect(displayUrl(`https://acme.com/${'a'.repeat(80)}`, 20)).toHaveLength(20);
  });
});
