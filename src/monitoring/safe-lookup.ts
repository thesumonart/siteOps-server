import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';

import { BlockedAddressError, checkAddress, type AddressGuardOptions } from './address-guard.js';

/**
 * A DNS lookup that refuses to hand back a non-public address.
 *
 * This is installed as the socket's `lookup`, which is what closes the DNS
 * rebinding window: the address the guard approves is the exact address the
 * kernel connects to. Resolving separately and then connecting by hostname
 * would re-query DNS and could reach a different, unvalidated address.
 */

export type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

export interface LookupOptions {
  readonly family?: number | 'IPv4' | 'IPv6';
  readonly all?: boolean;
  readonly hints?: number;
  readonly verbatim?: boolean;
}

/** Injected so tests can simulate rebinding without touching real DNS. */
export type Resolver = (
  hostname: string,
  options: { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export interface SafeLookupOptions extends AddressGuardOptions {
  readonly resolver?: Resolver;
}

export function createSafeLookup(
  options: SafeLookupOptions,
): (hostname: string, lookupOptions: LookupOptions, callback: LookupCallback) => void {
  const resolve: Resolver = options.resolver ?? dnsLookup;

  return (hostname, lookupOptions, callback) => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) {
        callback(error, []);
        return;
      }

      const permitted: LookupAddress[] = [];
      let firstRejection: string | null = null;

      for (const candidate of addresses) {
        const verdict = checkAddress(candidate.address, options);
        if (verdict.allowed) {
          permitted.push(candidate);
        } else {
          firstRejection ??= verdict.reason ?? 'not publicly routable';
        }
      }

      /*
       * Every address must be dropped for the connection to fail, but a partial
       * rejection is not silently tolerated either: only the approved addresses
       * are ever returned, so a hostname that resolves to both a public and a
       * private address can never reach the private one.
       */
      if (permitted.length === 0) {
        const blocked = new BlockedAddressError(
          hostname,
          addresses.map((entry) => entry.address),
          firstRejection ?? 'no addresses returned',
        );
        callback(Object.assign(blocked, { code: 'SITEOPS_BLOCKED_ADDRESS' }), []);
        return;
      }

      if (lookupOptions.all === true) {
        callback(null, permitted);
        return;
      }

      const [first] = permitted;
      // Unreachable: `permitted` is non-empty here.
      if (!first) {
        callback(new Error('No permitted address available.'), []);
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}
