/**
 * IP address classification used by SSRF defence.
 *
 * These functions are pure and isomorphic on purpose: the API uses them to
 * reject IP-literal URLs at creation time, and the monitoring worker uses the
 * exact same predicates against DNS-resolved addresses immediately before it
 * opens a socket. One implementation means one place to audit.
 *
 * Anything that is not provably a public unicast address is treated as blocked.
 */

export type IpVersion = 4 | 6;

export interface ParsedIp {
  readonly version: IpVersion;
  /** Normalized text form, without brackets or zone index. */
  readonly address: string;
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Parses strict dotted-quad IPv4.
 *
 * Short and zero-padded forms are rejected rather than normalized: `127.1` and
 * `0177.0.0.1` are both accepted by some resolvers as loopback, so treating
 * them as invalid keeps the blocklist from being bypassed by notation.
 */
export function parseIpv4(value: string): readonly number[] | null {
  const match = IPV4_PATTERN.exec(value);
  if (!match) return null;

  const octets: number[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const raw = match[index];
    if (raw === undefined) return null;
    if (raw.length > 1 && raw.startsWith('0')) return null;
    const octet = Number(raw);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function pushHextet(target: number[], part: string): boolean {
  if (part.length === 0 || part.length > 4) return false;
  if (!/^[0-9a-fA-F]+$/.test(part)) return false;
  target.push(Number.parseInt(part, 16));
  return true;
}

function expandParts(parts: readonly string[], target: number[]): boolean {
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) return false;

    // An embedded IPv4 suffix such as ::ffff:127.0.0.1 occupies two hextets and
    // may only appear last.
    if (part.includes('.')) {
      if (index !== parts.length - 1) return false;
      const octets = parseIpv4(part);
      if (!octets) return false;
      const [a, b, c, d] = octets;
      if (a === undefined || b === undefined || c === undefined || d === undefined) return false;
      target.push((a << 8) | b, (c << 8) | d);
      continue;
    }
    if (!pushHextet(target, part)) return false;
  }
  return true;
}

/** Parses IPv6 into eight 16-bit groups, supporting `::` and embedded IPv4. */
export function parseIpv6(value: string): readonly number[] | null {
  let text = value;
  if (text.startsWith('[') && text.endsWith(']')) {
    text = text.slice(1, -1);
  }
  // A zone index (fe80::1%eth0) never makes an address public, so drop it and
  // classify the address itself.
  const zoneIndex = text.indexOf('%');
  if (zoneIndex !== -1) {
    text = text.slice(0, zoneIndex);
  }
  if (text.length === 0 || !text.includes(':')) return null;

  const doubleColonCount = text.split('::').length - 1;
  if (doubleColonCount > 1) return null;

  let head = text;
  let tail = '';
  if (doubleColonCount === 1) {
    const segments = text.split('::');
    head = segments[0] ?? '';
    tail = segments[1] ?? '';
  }

  const headParts = head.length > 0 ? head.split(':') : [];
  const tailParts = tail.length > 0 ? tail.split(':') : [];

  const groups: number[] = [];
  const trailing: number[] = [];

  if (!expandParts(headParts, groups)) return null;
  if (!expandParts(tailParts, trailing)) return null;

  if (doubleColonCount === 1) {
    const missing = 8 - groups.length - trailing.length;
    if (missing < 1) return null;
    for (let index = 0; index < missing; index += 1) groups.push(0);
  }

  groups.push(...trailing);
  if (groups.length !== 8) return null;
  return groups;
}

function ipv4ToInteger(octets: readonly number[]): number {
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  // The unsigned shift keeps values above 127.x.x.x positive.
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

interface Cidr {
  readonly base: number;
  readonly maskBits: number;
  readonly reason: string;
}

function cidr(address: string, maskBits: number, reason: string): Cidr {
  const octets = parseIpv4(address);
  if (!octets) throw new Error(`Invalid CIDR base address: ${address}`);
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return { base: (ipv4ToInteger(octets) & mask) >>> 0, maskBits, reason };
}

/**
 * Every IPv4 range a monitoring request must never reach.
 * Sources: RFC 1122, RFC 1918, RFC 3927, RFC 5735, RFC 6598, plus the
 * link-local range that carries AWS/GCP/Azure instance metadata.
 */
const BLOCKED_IPV4_RANGES: readonly Cidr[] = [
  cidr('0.0.0.0', 8, 'unspecified address'),
  cidr('10.0.0.0', 8, 'private network'),
  cidr('100.64.0.0', 10, 'carrier-grade NAT'),
  cidr('127.0.0.0', 8, 'loopback'),
  cidr('169.254.0.0', 16, 'link-local or cloud metadata endpoint'),
  cidr('172.16.0.0', 12, 'private network'),
  cidr('192.0.0.0', 24, 'IETF protocol assignments'),
  cidr('192.0.2.0', 24, 'documentation range'),
  cidr('192.88.99.0', 24, '6to4 relay anycast'),
  cidr('192.168.0.0', 16, 'private network'),
  cidr('198.18.0.0', 15, 'network benchmarking'),
  cidr('198.51.100.0', 24, 'documentation range'),
  cidr('203.0.113.0', 24, 'documentation range'),
  cidr('224.0.0.0', 4, 'multicast'),
  cidr('240.0.0.0', 4, 'reserved'),
];

export interface IpClassification {
  readonly blocked: boolean;
  readonly reason?: string;
}

const ALLOWED: IpClassification = { blocked: false };

export function classifyIpv4(value: string): IpClassification {
  const octets = parseIpv4(value);
  if (!octets) return { blocked: true, reason: 'unparseable IPv4 address' };

  const asInteger = ipv4ToInteger(octets);
  for (const range of BLOCKED_IPV4_RANGES) {
    const mask = range.maskBits === 0 ? 0 : (0xffffffff << (32 - range.maskBits)) >>> 0;
    if ((asInteger & mask) >>> 0 === range.base) {
      return { blocked: true, reason: range.reason };
    }
  }
  return ALLOWED;
}

function embeddedIpv4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

export function classifyIpv6(value: string): IpClassification {
  const groups = parseIpv6(value);
  if (!groups) return { blocked: true, reason: 'unparseable IPv6 address' };

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const hasAllZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible addresses must be judged by
  // the address they carry, otherwise ::ffff:127.0.0.1 reaches loopback.
  if (hasAllZeroPrefix && (g5 === 0xffff || g5 === 0)) {
    if (g5 === 0 && g6 === 0 && g7 <= 1) {
      return { blocked: true, reason: g7 === 1 ? 'IPv6 loopback' : 'unspecified address' };
    }
    return classifyIpv4(embeddedIpv4(g6, g7));
  }

  // NAT64 well-known prefix 64:ff9b::/96 also carries an embedded IPv4.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIpv4(embeddedIpv4(g6, g7));
  }

  // 6to4 (2002::/16) embeds the IPv4 address of the tunnel endpoint.
  if (g0 === 0x2002) {
    const embedded = classifyIpv4(embeddedIpv4(g1, g2));
    if (embedded.blocked) {
      return {
        blocked: true,
        reason: `6to4 address wrapping ${embedded.reason ?? 'a blocked range'}`,
      };
    }
    return ALLOWED;
  }

  if ((g0 & 0xfe00) === 0xfc00) return { blocked: true, reason: 'unique local address' };
  if ((g0 & 0xffc0) === 0xfe80) return { blocked: true, reason: 'link-local address' };
  if ((g0 & 0xff00) === 0xff00) return { blocked: true, reason: 'multicast address' };
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return { blocked: true, reason: 'discard-only prefix' };
  }
  if (g0 === 0x2001 && g1 === 0x0db8) return { blocked: true, reason: 'documentation range' };

  return ALLOWED;
}

/** Detects whether a string is an IP literal, without deciding if it is allowed. */
export function parseIpLiteral(value: string): ParsedIp | null {
  const unbracketed = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (parseIpv4(unbracketed)) return { version: 4, address: unbracketed };
  if (parseIpv6(unbracketed)) return { version: 6, address: unbracketed };
  return null;
}

/**
 * The single predicate every outbound monitoring request must satisfy. Accepts
 * either an IP literal taken from a URL or an address returned by DNS.
 */
export function classifyIpAddress(value: string): IpClassification {
  const parsed = parseIpLiteral(value);
  if (!parsed) return { blocked: true, reason: 'not an IP address' };
  return parsed.version === 4 ? classifyIpv4(parsed.address) : classifyIpv6(parsed.address);
}

export function isBlockedIpAddress(value: string): boolean {
  return classifyIpAddress(value).blocked;
}
