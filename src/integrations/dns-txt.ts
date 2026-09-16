import { Resolver } from 'node:dns/promises';

/**
 * What a TXT lookup found.
 *
 * `missing` and `failed` are kept apart because they call for different advice:
 * a missing record means the customer has not added it (or it has not
 * propagated), while a failed lookup means DNS itself did not answer and trying
 * again later may be all that is needed.
 */
export type TxtLookupResult =
  | { readonly outcome: 'found'; readonly values: readonly string[] }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'failed' };

export type TxtLookup = (name: string) => Promise<TxtLookupResult>;

/** Answers that mean "no such record", as opposed to "DNS did not answer". */
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA', 'ENONAME']);

const LOOKUP_TIMEOUT_MS = 5_000;
const LOOKUP_TRIES = 2;

/**
 * Looks up TXT records through the system's resolvers.
 *
 * No SSRF screen is needed here, unlike every fetch the worker makes: a DNS
 * query goes to the configured resolver, not to the name being asked about,
 * and the answer is compared with a token rather than acted on.
 *
 * A record split into several strings — which DNS does to anything over 255
 * bytes — is joined back into one value before it is compared.
 */
export function systemTxtLookup(): TxtLookup {
  return async (name) => {
    const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: LOOKUP_TRIES });
    try {
      const records = await resolver.resolveTxt(name);
      return { outcome: 'found', values: records.map((chunks) => chunks.join('')) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== undefined && MISSING_CODES.has(code)) return { outcome: 'missing' };
      return { outcome: 'failed' };
    }
  };
}
