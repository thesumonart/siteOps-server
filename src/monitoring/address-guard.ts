import { classifyIpAddress, parseIpLiteral } from '../contracts/index.js';

/**
 * The authoritative SSRF boundary.
 *
 * String validation at creation time (`normalizeWebsiteUrl`) cannot be trusted
 * here: DNS can change between the moment a website is added and the moment it
 * is checked. This module validates the address the socket is actually about to
 * connect to, which is the only point where DNS rebinding can be stopped.
 *
 * The rule is deny-by-default: an address is permitted only if it is provably
 * public unicast.
 */

export interface AddressGuardOptions {
  /**
   * Permits loopback (`127.0.0.0/8`, `::1`) so the integration suite can reach a
   * mock server on the local machine.
   *
   * Deliberately narrower than "allow private addresses": every other blocked
   * range — RFC 1918, link-local, cloud metadata, CGNAT — stays blocked even
   * with this on, so a test can still prove that a redirect into metadata
   * territory is refused. The worker refuses to start with this enabled in
   * production regardless.
   */
  readonly allowLoopback: boolean;
}

export interface AddressVerdict {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function isLoopbackAddress(address: string): boolean {
  const parsed = parseIpLiteral(address);
  if (!parsed) return false;

  if (parsed.version === 4) return parsed.address.startsWith('127.');
  const normalized = parsed.address.toLowerCase();
  return (
    normalized === '::1' || normalized.endsWith(':127.0.0.1') || normalized === '0:0:0:0:0:0:0:1'
  );
}

/** Decides whether a single resolved address may be connected to. */
export function checkAddress(address: string, options: AddressGuardOptions): AddressVerdict {
  const classification = classifyIpAddress(address);

  if (!classification.blocked) return { allowed: true };

  if (options.allowLoopback && isLoopbackAddress(address)) {
    return { allowed: true };
  }

  return { allowed: false, reason: classification.reason ?? 'not publicly routable' };
}

/** Raised when every address a hostname resolves to is blocked. */
export class BlockedAddressError extends Error {
  readonly hostname: string;
  readonly addresses: readonly string[];

  constructor(hostname: string, addresses: readonly string[], reason: string) {
    super(`Refused to connect to ${hostname}: ${reason}`);
    this.name = 'BlockedAddressError';
    this.hostname = hostname;
    this.addresses = addresses;
  }
}
