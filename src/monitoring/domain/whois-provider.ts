import { createConnection, type Socket } from 'node:net';

import type {
  DomainLookupOptions,
  DomainLookupResult,
  DomainRegistrationProvider,
} from './registration-provider.js';

/**
 * Registration data over WHOIS.
 *
 * The fallback for the ccTLDs that never adopted RDAP. WHOIS is a 1982 protocol
 * with no schema: a client opens TCP port 43, sends the query and a CRLF, and
 * reads free text until the server closes the connection. Every registry
 * formats that text differently, so the parsing below is unavoidably a set of
 * heuristics over the labels that are common in practice.
 *
 * Because it is heuristic, this provider is second. A date it cannot parse
 * becomes null — never a guess — since a wrong expiry date is worse than no
 * expiry date: one silences a real warning, the other only fails to raise one.
 *
 * IANA's server is queried first to find which registry is authoritative for
 * the TLD, then that registry is queried for the domain. That referral step is
 * what makes this work across TLDs without a hard-coded server list.
 */

const IANA_WHOIS_HOST = 'whois.iana.org';
const WHOIS_PORT = 43;
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Labels that carry the expiry date, lowercased and stripped of punctuation.
 *
 * Ordered by how unambiguous they are. `expires` alone is last because some
 * registries use it for the *record's* expiry rather than the registration's.
 */
const EXPIRY_LABELS: readonly string[] = [
  'registry expiry date',
  'registrar registration expiration date',
  'expiration date',
  'expiration time',
  'expiry date',
  'paid-till',
  'renewal date',
  'expires on',
  'expire date',
  'expires',
];

const CREATED_LABELS: readonly string[] = [
  'creation date',
  'created on',
  'created date',
  'registered on',
  'registration time',
  'created',
];

const REGISTRAR_LABELS: readonly string[] = ['registrar', 'sponsoring registrar', 'registrar name'];

const STATUS_LABELS: readonly string[] = ['domain status', 'status', 'state'];

const NAMESERVER_LABELS: readonly string[] = ['name server', 'nserver', 'nameserver'];

/** Phrases a registry uses to say a name is not registered. */
const NOT_FOUND_MARKERS: readonly string[] = [
  'no match for',
  'not found',
  'no entries found',
  'no data found',
  'domain not found',
  'no object found',
  'nothing found',
  'status: free',
  'status: available',
];

/** Opens a WHOIS connection, sends one query and reads the whole answer. */
async function query(host: string, text: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const socket: Socket = createConnection({ host, port: WHOIS_PORT, timeout: timeoutMs }, () => {
      socket.write(`${text}
`);
    });

    /*
     * A deadline of our own on top of the socket's. The socket's `timeout` only
     * fires on *inactivity*, so a server dribbling one byte a second would keep
     * the connection alive indefinitely; this bounds the whole query.
     */
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`WHOIS query to ${host} timed out.`));
    }, timeoutMs);
    timer.unref();

    const settle = (action: () => void): void => {
      clearTimeout(timer);
      action();
    };

    socket.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        settle(() => {
          socket.destroy();
          reject(new Error('The WHOIS response was too large to read.'));
        });
        return;
      }
      chunks.push(chunk);
    });

    socket.on('end', () => {
      settle(() => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    socket.on('timeout', () => {
      settle(() => {
        socket.destroy();
        reject(new Error(`WHOIS query to ${host} timed out.`));
      });
    });
    socket.on('error', (error: Error) => {
      settle(() => {
        socket.destroy();
        reject(error);
      });
    });
  });
}

/**
 * Every `label: value` pair in a WHOIS response, lowercased on the label side.
 *
 * A label can repeat (name servers, statuses), so values accumulate into a
 * list rather than overwriting.
 */
export function parseWhoisFields(response: string): ReadonlyMap<string, string[]> {
  const fields = new Map<string, string[]>();

  for (const rawLine of response.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Comments and the legal boilerplate every registry appends.
    if (line.length === 0 || line.startsWith('%') || line.startsWith('#') || line.startsWith('>>>'))
      continue;

    const separator = line.indexOf(':');
    if (separator <= 0) continue;

    const label = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (value.length === 0) continue;

    const existing = fields.get(label);
    if (existing) existing.push(value);
    else fields.set(label, [value]);
  }

  return fields;
}

function firstValue(
  fields: ReadonlyMap<string, string[]>,
  labels: readonly string[],
): string | null {
  for (const label of labels) {
    const values = fields.get(label);
    if (values?.[0]) return values[0];
  }
  return null;
}

function allValues(
  fields: ReadonlyMap<string, string[]>,
  labels: readonly string[],
): readonly string[] {
  for (const label of labels) {
    const values = fields.get(label);
    if (values && values.length > 0) return values;
  }
  return [];
}

/**
 * Parses a WHOIS date.
 *
 * Accepts ISO 8601 and the `dd-Mon-yyyy` form several registries still use.
 * Anything else becomes null rather than a guess: a misparsed date could read
 * as years in the future and silence a genuine expiry warning.
 */
export function parseWhoisDate(value: string | null): Date | null {
  if (!value) return null;
  const text = value.trim();

  const isoLike = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;
  if (isoLike.test(text)) {
    const parsed = new Date(text.includes('T') || text.includes(' ') ? text : `${text}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // `04-Mar-2026`, `2026.03.04`, `04/03/2026` — the last is ambiguous between
  // day-first and month-first, so it is deliberately not accepted.
  const dayMonthYear = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text);
  if (dayMonthYear) {
    const parsed = new Date(`${dayMonthYear[2]} ${dayMonthYear[1]}, ${dayMonthYear[3]} UTC`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const dottedYearFirst = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(text);
  if (dottedYearFirst) {
    const parsed = new Date(
      `${dottedYearFirst[1]}-${dottedYearFirst[2]}-${dottedYearFirst[3]}T00:00:00Z`,
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

export function looksLikeNotFound(response: string): boolean {
  const lower = response.toLowerCase();
  return NOT_FOUND_MARKERS.some((marker) => lower.includes(marker));
}

/** The registry WHOIS server IANA names for a TLD. */
async function referralFor(domain: string, timeoutMs: number): Promise<string | null> {
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  const response = await query(IANA_WHOIS_HOST, tld, timeoutMs);
  const fields = parseWhoisFields(response);
  return firstValue(fields, ['whois', 'refer']);
}

export interface WhoisProviderOptions {
  /** Skips the IANA referral and queries this server directly. Used in tests. */
  readonly server?: string;
}

export function createWhoisProvider(
  options: WhoisProviderOptions = {},
): DomainRegistrationProvider {
  return {
    name: 'whois',

    async lookup(domain: string, lookupOptions: DomainLookupOptions): Promise<DomainLookupResult> {
      try {
        const server = options.server ?? (await referralFor(domain, lookupOptions.timeoutMs));
        if (!server) {
          return { outcome: 'unsupported', reason: 'No WHOIS server is published for this TLD.' };
        }

        const response = await query(server, domain, lookupOptions.timeoutMs);

        if (looksLikeNotFound(response)) return { outcome: 'not_found' };

        const fields = parseWhoisFields(response);
        const expiresAt = parseWhoisDate(firstValue(fields, EXPIRY_LABELS));

        // A response with no parseable expiry is worse than useless for this
        // monitor: it would report "no expiry known" and clear a warning that
        // may still be true. Better to say the registry is unsupported.
        if (!expiresAt) {
          return {
            outcome: 'unsupported',
            reason: 'The WHOIS response did not contain a readable expiry date.',
          };
        }

        return {
          outcome: 'found',
          registration: {
            domain,
            registrar: firstValue(fields, REGISTRAR_LABELS),
            registeredAt: parseWhoisDate(firstValue(fields, CREATED_LABELS)),
            expiresAt,
            statuses: allValues(fields, STATUS_LABELS)
              // `clientTransferProhibited https://icann.org/epp#...` — keep the code.
              .map((status) => status.split(/\s+/)[0] ?? status)
              .slice(0, 10),
            nameServers: allValues(fields, NAMESERVER_LABELS)
              .map((entry) => (entry.split(/\s+/)[0] ?? entry).toLowerCase())
              .slice(0, 10),
            source: 'whois',
          },
        };
      } catch (error) {
        return {
          outcome: 'error',
          reason: error instanceof Error ? error.message : 'The WHOIS lookup failed.',
        };
      }
    },
  };
}
