import { describe, expect, it } from 'vitest';

import { classifyIpAddress, isBlockedIpAddress, parseIpv4, parseIpv6 } from './ip.js';

describe('parseIpv4', () => {
  it('parses dotted-quad addresses', () => {
    expect(parseIpv4('93.184.216.34')).toEqual([93, 184, 216, 34]);
    expect(parseIpv4('0.0.0.0')).toEqual([0, 0, 0, 0]);
    expect(parseIpv4('255.255.255.255')).toEqual([255, 255, 255, 255]);
  });

  it('rejects zero-padded octets that resolvers may read as octal', () => {
    expect(parseIpv4('0177.0.0.1')).toBeNull();
    expect(parseIpv4('010.0.0.1')).toBeNull();
    expect(parseIpv4('127.000.000.001')).toBeNull();
  });

  it('rejects short and oversized forms', () => {
    expect(parseIpv4('127.1')).toBeNull();
    expect(parseIpv4('1.2.3')).toBeNull();
    expect(parseIpv4('1.2.3.4.5')).toBeNull();
    expect(parseIpv4('256.1.1.1')).toBeNull();
    expect(parseIpv4('-1.1.1.1')).toBeNull();
  });
});

describe('parseIpv6', () => {
  it('expands compressed addresses to eight groups', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('2606:2800:220:1:248:1893:25c8:1946')).toHaveLength(8);
    expect(parseIpv6('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('handles brackets and zone indices', () => {
    expect(parseIpv6('[::1]')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('parses embedded IPv4 suffixes', () => {
    expect(parseIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
  });

  it('rejects malformed input', () => {
    expect(parseIpv6('1::2::3')).toBeNull();
    expect(parseIpv6('12345::1')).toBeNull();
    expect(parseIpv6('gggg::1')).toBeNull();
    expect(parseIpv6('1.2.3.4')).toBeNull();
    expect(parseIpv6('1:2:3:4:5:6:7')).toBeNull();
  });
});

describe('classifyIpAddress — blocked ranges', () => {
  const blocked = [
    ['0.0.0.0', 'unspecified'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback anywhere in 127/8'],
    ['10.0.0.1', 'RFC1918 10/8'],
    ['172.16.0.1', 'RFC1918 172.16/12'],
    ['172.31.255.254', 'RFC1918 upper bound'],
    ['192.168.1.1', 'RFC1918 192.168/16'],
    ['169.254.169.254', 'AWS/GCP/Azure metadata endpoint'],
    ['169.254.0.1', 'link-local'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.100.100.200', 'Alibaba Cloud metadata inside CGNAT'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['198.18.0.1', 'benchmarking range'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast inside 240/4'],
  ] as const;

  it.each(blocked)('blocks %s (%s)', (address) => {
    expect(isBlockedIpAddress(address)).toBe(true);
  });

  const blockedV6 = [
    ['::1', 'IPv6 loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'unique local'],
    ['fd00::1', 'unique local'],
    ['fd00:ec2::254', 'AWS IPv6 metadata endpoint'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata endpoint'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['64:ff9b::127.0.0.1', 'NAT64-wrapped loopback'],
    ['2002:7f00:0001::', '6to4-wrapped loopback'],
    ['2002:a00:1::', '6to4-wrapped RFC1918'],
    ['0100::1', 'discard-only prefix'],
    ['2001:db8::1', 'documentation range'],
  ] as const;

  it.each(blockedV6)('blocks %s (%s)', (address) => {
    expect(isBlockedIpAddress(address)).toBe(true);
  });
});

describe('classifyIpAddress — allowed public addresses', () => {
  const allowed = [
    '93.184.216.34',
    '1.1.1.1',
    '8.8.8.8',
    '172.32.0.1',
    '172.15.255.255',
    '192.169.0.1',
    '100.63.255.255',
    '101.0.0.1',
    '2606:2800:220:1:248:1893:25c8:1946',
    '2002:5db8:1::',
  ] as const;

  it.each(allowed)('allows %s', (address) => {
    expect(isBlockedIpAddress(address)).toBe(false);
  });
});

describe('classifyIpAddress — non-addresses', () => {
  it('blocks anything that is not a parseable IP', () => {
    expect(classifyIpAddress('acme.com').blocked).toBe(true);
    expect(classifyIpAddress('').blocked).toBe(true);
    expect(classifyIpAddress('not-an-ip').blocked).toBe(true);
  });

  it('explains why an address was blocked', () => {
    expect(classifyIpAddress('127.0.0.1').reason).toContain('loopback');
    expect(classifyIpAddress('169.254.169.254').reason).toContain('metadata');
  });
});
