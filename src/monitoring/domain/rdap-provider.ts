import { interceptors, request, Agent } from 'undici';

import { loadRdapBootstrap } from './reference-data.js';
import type {
  DomainLookupOptions,
  DomainLookupResult,
  DomainRegistrationProvider,
} from './registration-provider.js';

/**
 * Registration data over RDAP.
 *
 * RDAP is WHOIS's structured replacement: JSON over HTTPS, mandatory for every
 * gTLD since 2019, with a documented schema instead of free-text that differs
 * per registrar. It is tried first for exactly that reason — the dates it
 * returns are unambiguous, where WHOIS dates have to be guessed at.
 *
 * **Which server is asked** comes from IANA's own bootstrap registry, cached
 * for a day: `.dev` resolves to Google's registry, `.uk` to Nominet, and the
 * query goes straight there. `rdap.org` — a third-party redirector — is kept
 * only as the fallback for when that registry cannot be fetched or does not
 * list the TLD. It used to be the primary path, and that was the wrong shape:
 * a single volunteer-run host in front of every lookup is one outage away from
 * every domain in the product reporting "expiry unknown".
 */

const FALLBACK_BASE_URL = 'https://rdap.org';
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

/**
 * Sent on every request, and not optional.
 *
 * `rdap.org` sits behind Cloudflare, which answers a request with no
 * `User-Agent` with an HTTP 403 challenge page. The provider read that as
 * "this TLD has no RDAP service", fell through to WHOIS, and every `.dev`
 * domain in production ended up reporting "No WHOIS server is published for
 * this TLD" — with no expiry date, indefinitely. Several registries apply the
 * same rule, so identifying ourselves is a correctness requirement rather than
 * politeness.
 */
const USER_AGENT = 'SiteOpsMonitor/1.0 (+https://siteops.app)';

/**
 * Follows the bootstrap redirect to the authoritative registry.
 *
 * Every hop is an ordinary public HTTPS request to a registry, so the address
 * guard that protects user-supplied URLs does not apply: the base URL is set by
 * configuration, not by a customer. What does apply is a bound on the hops.
 */
const redirectingAgent = new Agent().compose(
  interceptors.redirect({ maxRedirections: MAX_REDIRECTS }),
);

/** The subset of the RDAP domain object this reads. */
interface RdapEvent {
  readonly eventAction?: unknown;
  readonly eventDate?: unknown;
}

interface RdapEntity {
  readonly roles?: unknown;
  readonly vcardArray?: unknown;
}

interface RdapNameserver {
  readonly ldhName?: unknown;
}

interface RdapDomain {
  readonly ldhName?: unknown;
  readonly status?: unknown;
  readonly events?: unknown;
  readonly entities?: unknown;
  readonly nameservers?: unknown;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseDate(value: unknown): Date | null {
  const text = asString(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The date of the first event with one of the given actions. */
function eventDate(events: readonly unknown[], actions: readonly string[]): Date | null {
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) continue;
    const event = raw as RdapEvent;
    const action = asString(event.eventAction)?.toLowerCase();
    if (action && actions.includes(action)) {
      const date = parseDate(event.eventDate);
      if (date) return date;
    }
  }
  return null;
}

/**
 * Pulls the registrar's name out of the entity list.
 *
 * The name lives inside a jCard (`vcardArray`), which is a nested array format
 * rather than an object: `["vcard", [["fn", {}, "text", "Example Registrar"]]]`.
 * Walking it defensively is unavoidable — a registry that omits or reshapes it
 * must leave the registrar null rather than throw and fail the whole lookup.
 */
function registrarName(entities: readonly unknown[]): string | null {
  for (const raw of entities) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entity = raw as RdapEntity;

    const roles = asArray(entity.roles).filter((role): role is string => typeof role === 'string');
    if (!roles.includes('registrar')) continue;

    const vcard = asArray(entity.vcardArray)[1];
    for (const field of asArray(vcard)) {
      const parts = asArray(field);
      if (parts[0] === 'fn') {
        const name = asString(parts[3]);
        if (name) return name;
      }
    }
  }
  return null;
}

export interface RdapProviderOptions {
  /**
   * Pins the RDAP server, skipping the bootstrap lookup.
   *
   * Set by tests against a local server. A deployment leaves it unset so IANA
   * decides, which is the only way a TLD delegated next month works without a
   * code change.
   */
  readonly baseUrl?: string;
}

/**
 * The authoritative RDAP base URL for a domain's TLD.
 *
 * Falls back to the redirector when the bootstrap registry is unavailable or
 * does not list the TLD — plenty of ccTLDs are absent from it, and `rdap.org`
 * knows about some of them.
 */
async function resolveBaseUrl(domain: string, pinned: string | undefined): Promise<string> {
  if (pinned) return pinned.replace(/\/$/, '');

  const tld = domain.slice(domain.lastIndexOf('.') + 1).toLowerCase();
  const bootstrap = await loadRdapBootstrap();

  return bootstrap?.get(tld) ?? FALLBACK_BASE_URL;
}

export function createRdapProvider(options: RdapProviderOptions = {}): DomainRegistrationProvider {
  return {
    name: 'rdap',

    async lookup(domain: string, lookupOptions: DomainLookupOptions): Promise<DomainLookupResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, lookupOptions.timeoutMs);

      try {
        const baseUrl = await resolveBaseUrl(domain, options.baseUrl);

        const response = await request(`${baseUrl}/domain/${encodeURIComponent(domain)}`, {
          method: 'GET',
          signal: controller.signal,
          // Registries redirect between their own hosts, and the fallback
          // redirector answers with a 302 to the authoritative one, so
          // redirects have to be followed to get an answer at all. Bounded,
          // because a loop between two registries would otherwise spin until
          // the timeout.
          dispatcher: redirectingAgent,
          headers: {
            accept: 'application/rdap+json, application/json',
            'user-agent': USER_AGENT,
          },
        });

        if (response.statusCode === 404) {
          await response.body.dump();
          /*
           * What a 404 means depends on who answered.
           *
           * From the registry IANA names as authoritative, it is the answer:
           * this name is not registered. From the fallback redirector, it much
           * more often means "no RDAP service is published for this TLD" — the
           * response body says exactly that — and reporting it as "not
           * registered" would let the chain stop instead of trying WHOIS.
           */
          return baseUrl === FALLBACK_BASE_URL
            ? {
                outcome: 'unsupported',
                reason: 'No RDAP service is published for this TLD.',
              }
            : { outcome: 'not_found' };
        }

        /*
         * 403 belongs here, not below. A registry or its CDN refusing us is a
         * transient, fixable condition — and classifying it as `unsupported`
         * is precisely the bug that hid every `.dev` expiry date: the chain
         * moved on to WHOIS, WHOIS had no server for the TLD, and the honest
         * "we were blocked" became a permanent-sounding "this TLD has none".
         */
        if (
          response.statusCode === 403 ||
          response.statusCode === 429 ||
          response.statusCode >= 500
        ) {
          await response.body.dump();
          // Transient by definition. Reporting this as "no expiry known" would
          // clear a warning that is still true.
          return {
            outcome: 'error',
            reason: `RDAP responded with HTTP ${String(response.statusCode)}.`,
          };
        }

        if (response.statusCode !== 200) {
          await response.body.dump();
          // 400 and 501 are how bootstrap reports a TLD with no RDAP service.
          return {
            outcome: 'unsupported',
            reason: `RDAP is not available for this domain (HTTP ${String(response.statusCode)}).`,
          };
        }

        const text = await readBounded(response.body);
        if (text === null) {
          return { outcome: 'error', reason: 'The RDAP response was too large to read.' };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return { outcome: 'error', reason: 'The RDAP response was not valid JSON.' };
        }

        if (typeof parsed !== 'object' || parsed === null) {
          return { outcome: 'error', reason: 'The RDAP response was not a domain object.' };
        }

        const rdap = parsed as RdapDomain;
        const events = asArray(rdap.events);

        return {
          outcome: 'found',
          registration: {
            domain: asString(rdap.ldhName)?.toLowerCase() ?? domain,
            registrar: registrarName(asArray(rdap.entities)),
            registeredAt: eventDate(events, ['registration']),
            // Registries are inconsistent about which of these they emit.
            expiresAt: eventDate(events, ['expiration', 'registrar expiration']),
            statuses: asArray(rdap.status).filter(
              (status): status is string => typeof status === 'string',
            ),
            nameServers: asArray(rdap.nameservers)
              .map((entry) =>
                typeof entry === 'object' && entry !== null
                  ? asString((entry as RdapNameserver).ldhName)
                  : null,
              )
              .filter((name): name is string => name !== null)
              .map((name) => name.toLowerCase()),
            source: 'rdap',
          },
        };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return { outcome: 'error', reason: 'The RDAP lookup timed out.' };
        }
        return {
          outcome: 'error',
          reason: error instanceof Error ? error.message : 'The RDAP lookup failed.',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Reads a response body, giving up past a size cap.
 *
 * An RDAP object is a few kilobytes. A redirector that hands back something
 * enormous — or a hostile server pretending to be one — must not be able to
 * exhaust the worker's memory, and `text()` has no bound of its own.
 */
async function readBounded(body: NodeJS.ReadableStream): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_RESPONSE_BYTES) return null;
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}
