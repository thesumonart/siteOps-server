/**
 * Where domain registration data comes from.
 *
 * No single source covers every TLD. RDAP is the modern, structured protocol
 * and is mandatory for gTLDs, but plenty of ccTLDs still serve only WHOIS, and
 * a handful publish neither. So the lookup is an interface with an ordered list
 * of implementations behind it, and the caller learns which one answered.
 *
 * The interface exists so a provider can be replaced — a paid API, a cached
 * mirror — without touching the monitor. Depending on one free public endpoint
 * for a production feature is exactly the coupling this avoids.
 */

export interface DomainRegistration {
  /** The registrable domain the answer is actually about, e.g. `example.co.uk`. */
  readonly domain: string;
  readonly registrar: string | null;
  readonly registeredAt: Date | null;
  readonly expiresAt: Date | null;
  /** EPP status codes, e.g. `clientTransferProhibited`. */
  readonly statuses: readonly string[];
  readonly nameServers: readonly string[];
  /** Which provider produced this answer. */
  readonly source: string;
}

/**
 * The outcome of asking one provider.
 *
 * `not_found` and `unsupported` are separated from `error` on purpose.
 * "This name is not registered" and "this registry speaks a protocol we do not"
 * are both final answers that the next provider may still be able to improve
 * on, while an error is transient and must never be reported to a user as an
 * expiring domain.
 */
export type DomainLookupResult =
  | { readonly outcome: 'found'; readonly registration: DomainRegistration }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'unsupported'; readonly reason: string }
  | { readonly outcome: 'error'; readonly reason: string };

export interface DomainLookupOptions {
  readonly timeoutMs: number;
}

export interface DomainRegistrationProvider {
  readonly name: string;
  lookup(domain: string, options: DomainLookupOptions): Promise<DomainLookupResult>;
}

/**
 * Candidate registrable domains for a hostname, longest first.
 *
 * SiteOps does not bundle a public suffix list. One would be several hundred
 * kilobytes of data that goes stale, for a problem the registries themselves
 * answer authoritatively: a lookup for a name that is not registrable returns
 * "not found", so walking up the labels and taking the first name that *is*
 * registered gets the right answer for `example.co.uk` and `example.com` alike,
 * with no list to maintain.
 *
 * The walk is bounded to three candidates. Beyond that a hostname is either
 * deeply nested — in which case the registrable domain is already among the
 * first three from the right — or something is wrong with the input.
 */
export function registrableCandidates(hostname: string): readonly string[] {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length < 2) return [];

  const candidates: string[] = [];
  // Start at two labels (`example.com`) and widen, since the registrable domain
  // is far more often two than three — one request instead of three, in the
  // common case.
  for (let take = 2; take <= Math.min(labels.length, 4); take += 1) {
    candidates.push(labels.slice(labels.length - take).join('.'));
  }
  return candidates;
}

/**
 * Asks each provider in turn until one gives a usable answer.
 *
 * `found` wins immediately. `not_found` is remembered but does not stop the
 * chain, because one provider not covering a TLD says nothing about the next.
 * An error is only reported when *every* provider errored — a single flaky
 * registry must not become "your domain is expiring".
 */
export async function lookupRegistration(
  providers: readonly DomainRegistrationProvider[],
  domain: string,
  options: DomainLookupOptions,
): Promise<DomainLookupResult> {
  let sawNotFound = false;
  let lastFailure: DomainLookupResult | null = null;

  for (const provider of providers) {
    const result = await provider.lookup(domain, options);

    if (result.outcome === 'found') return result;
    if (result.outcome === 'not_found') sawNotFound = true;
    else lastFailure = result;
  }

  if (sawNotFound) return { outcome: 'not_found' };
  return lastFailure ?? { outcome: 'error', reason: 'No registration provider was available.' };
}
