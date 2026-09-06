import { interceptors, request, Agent } from 'undici';

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
 * The default endpoint is `rdap.org`, IANA's bootstrap redirector: it looks the
 * TLD up in the official registry and redirects to the authoritative server.
 * That means one URL instead of a bootstrap file to keep current, at the cost
 * of a dependency on a third party — which is why the base URL is configurable
 * and why this sits behind {@link DomainRegistrationProvider}.
 */

const DEFAULT_BASE_URL = 'https://rdap.org';
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

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
  /** Base URL of an RDAP server or bootstrap redirector. */
  readonly baseUrl?: string;
}

export function createRdapProvider(options: RdapProviderOptions = {}): DomainRegistrationProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  return {
    name: 'rdap',

    async lookup(domain: string, lookupOptions: DomainLookupOptions): Promise<DomainLookupResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, lookupOptions.timeoutMs);

      try {
        const response = await request(`${baseUrl}/domain/${encodeURIComponent(domain)}`, {
          method: 'GET',
          signal: controller.signal,
          // The bootstrap endpoint answers with a 302 to the authoritative
          // registry, so redirects have to be followed to get an answer at all.
          // Bounded, because a redirect loop between two registries would
          // otherwise spin until the timeout.
          dispatcher: redirectingAgent,
          headers: { accept: 'application/rdap+json, application/json' },
        });

        if (response.statusCode === 404) {
          await response.body.dump();
          return { outcome: 'not_found' };
        }

        if (response.statusCode === 429 || response.statusCode >= 500) {
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
