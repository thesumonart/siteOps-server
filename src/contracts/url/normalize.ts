import { classifyIpAddress, parseIpLiteral } from './ip.js';

/**
 * URL normalization and string-level validation for monitored websites.
 *
 * This is the first of two SSRF defences and it is not sufficient on its own.
 * It rejects targets that are provably unsafe from the URL text alone, which
 * gives the user immediate feedback when adding a website. The authoritative
 * check happens in the monitoring worker, which validates the actual resolved
 * IP address immediately before connecting — that is the only place a DNS
 * rebinding attack can be stopped.
 */

export const ALLOWED_URL_PROTOCOLS = ['http:', 'https:'] as const;

export type UrlRejectionReason =
  | 'empty'
  | 'malformed'
  | 'unsupported_protocol'
  | 'credentials_present'
  | 'missing_hostname'
  | 'blocked_hostname'
  | 'blocked_ip'
  | 'too_long';

export interface NormalizedUrl {
  /** Canonical absolute URL used for outbound requests and display. */
  readonly href: string;
  readonly protocol: 'http:' | 'https:';
  readonly hostname: string;
  readonly port: string;
  /**
   * Comparison key for duplicate detection within an organization. Ignores
   * protocol, `www.`, default ports and trailing slashes so `https://acme.com`
   * and `http://www.acme.com/` are recognised as the same website.
   */
  readonly canonicalKey: string;
}

export type UrlValidationResult =
  | { readonly ok: true; readonly value: NormalizedUrl }
  | { readonly ok: false; readonly reason: UrlRejectionReason; readonly detail: string };

export const MAX_URL_LENGTH = 2048;

/**
 * Hostnames that resolve to internal infrastructure on virtually every network.
 * Matched case-insensitively, on the full hostname or as a dotted suffix.
 */
const BLOCKED_HOSTNAMES: readonly string[] = [
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
];

/** Reserved and internal-only TLDs (RFC 6761, RFC 8375) plus common intranet suffixes. */
const BLOCKED_HOSTNAME_SUFFIXES: readonly string[] = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.corp',
  '.home',
  '.home.arpa',
  '.lan',
  '.private',
  '.test',
  '.example',
  '.invalid',
  '.onion',
  '.in-addr.arpa',
  '.ip6.arpa',
];

function reject(reason: UrlRejectionReason, detail: string): UrlValidationResult {
  return { ok: false, reason, detail };
}

/** Strips one trailing dot from a fully-qualified name so `acme.com.` matches `acme.com`. */
function stripRootDot(hostname: string): string {
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = stripRootDot(hostname.toLowerCase());
  if (host.length === 0) return true;
  if (BLOCKED_HOSTNAMES.includes(host)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * A bare hostname with no dot (`intranet`, `router`) is almost always an
 * internal single-label name resolved through a search domain. IP literals are
 * handled separately and are not affected by this rule.
 */
function isSingleLabelHostname(hostname: string): boolean {
  return !stripRootDot(hostname).includes('.');
}

function defaultPortFor(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

/**
 * Normalizes user input into a canonical URL, rejecting anything unsafe.
 *
 * Accepts input without a scheme (`acme.com`) and defaults it to https, which
 * is what users expect when typing a domain into a form.
 */
export function normalizeWebsiteUrl(input: string): UrlValidationResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return reject('empty', 'Enter a website URL.');
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    return reject('too_long', `URLs must be ${MAX_URL_LENGTH} characters or fewer.`);
  }

  // A scheme-relative or scheme-less value is treated as https. Anything that
  // already carries a scheme keeps it so that unsupported schemes are reported
  // accurately instead of being silently rewritten.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed.replace(/^\/\//, '')}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return reject('malformed', 'Enter a valid URL, for example https://acme.com.');
  }

  if (!ALLOWED_URL_PROTOCOLS.includes(parsed.protocol as (typeof ALLOWED_URL_PROTOCOLS)[number])) {
    return reject(
      'unsupported_protocol',
      `Only http and https URLs can be monitored. Received "${parsed.protocol}".`,
    );
  }

  // Credentials in a monitored URL would be logged and mailed in incident
  // notifications, so they are refused rather than stripped.
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return reject('credentials_present', 'Remove the username and password from the URL.');
  }

  const hostname = stripRootDot(parsed.hostname.toLowerCase());
  if (hostname.length === 0) {
    return reject('missing_hostname', 'The URL is missing a hostname.');
  }

  const ipLiteral = parseIpLiteral(hostname);
  if (ipLiteral) {
    const classification = classifyIpAddress(ipLiteral.address);
    if (classification.blocked) {
      return reject(
        'blocked_ip',
        `This address cannot be monitored: ${classification.reason ?? 'not publicly routable'}.`,
      );
    }
  } else {
    if (isBlockedHostname(hostname)) {
      return reject('blocked_hostname', 'This hostname refers to an internal address.');
    }
    if (isSingleLabelHostname(hostname)) {
      return reject('blocked_hostname', 'Enter a fully qualified domain, for example acme.com.');
    }
  }

  const protocol = parsed.protocol as 'http:' | 'https:';
  // Write the normalized hostname back so the stored URL and the canonical key
  // agree; otherwise `acme.com.` and `acme.com` are stored as different sites.
  parsed.hostname = hostname;
  // The fragment is meaningless to an HTTP request; dropping it keeps duplicate
  // detection and stored URLs stable.
  parsed.hash = '';
  if (parsed.port === defaultPortFor(protocol)) {
    parsed.port = '';
  }
  if (parsed.pathname === '') {
    parsed.pathname = '/';
  }

  const canonicalHost = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  const canonicalPort = parsed.port.length > 0 ? `:${parsed.port}` : '';
  const canonicalPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  const canonicalQuery = parsed.search;

  return {
    ok: true,
    value: {
      href: parsed.toString(),
      protocol,
      hostname,
      port: parsed.port,
      canonicalKey: `${canonicalHost}${canonicalPort}${canonicalPath}${canonicalQuery}`,
    },
  };
}

/** Convenience wrapper for validation contexts that only need a boolean. */
export function isMonitorableUrl(input: string): boolean {
  return normalizeWebsiteUrl(input).ok;
}

/** Shortens a URL for display in dense table cells without breaking meaning. */
export function displayUrl(href: string, maxLength = 48): string {
  const withoutScheme = href.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (withoutScheme.length <= maxLength) return withoutScheme;
  return `${withoutScheme.slice(0, maxLength - 1)}…`;
}
