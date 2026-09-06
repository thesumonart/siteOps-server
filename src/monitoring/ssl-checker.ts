import { lookup as dnsLookup } from 'node:dns/promises';
import { connect, type PeerCertificate, type TLSSocket } from 'node:tls';

import type { SslCheckData } from '../contracts/index.js';
import { checkAddress } from './address-guard.js';

/**
 * Inspects a site's TLS certificate.
 *
 * This does not use the HTTP checker. An expired or mismatched certificate is
 * exactly the case this monitor exists to report, and an HTTP client would
 * refuse the connection before anything could be read off it — the monitor
 * would only ever be able to say "it failed", never "it expires in six days,
 * here is the issuer". So the handshake is performed directly with
 * `rejectUnauthorized: false` and the verification result is read back from the
 * socket afterwards.
 *
 * **That flag is not a weakening of security, and this is worth being precise
 * about.** Nothing is fetched over this connection: no request is sent, no
 * body is read, no data crosses it in either direction. The socket is opened,
 * the peer's certificate is copied out, and the socket is destroyed. Accepting
 * an untrusted certificate here has no more consequence than reading it from a
 * file — and `authorized`/`authorizationError` still tell us, truthfully,
 * whether a browser would have accepted it, which is the whole point.
 *
 * The SSRF boundary is unchanged and is applied *before* the handshake: the
 * hostname is resolved here, every address is put through the same
 * `checkAddress` guard the HTTP checker uses, and the socket connects to the
 * approved IP with SNI set to the original hostname. Connecting by hostname
 * would re-query DNS inside the TLS layer and reopen the rebinding window.
 */

export interface SslCheckOptions {
  readonly timeoutMs: number;
  /** Test-only: see AddressGuardOptions. Refused in production at startup. */
  readonly allowLoopback: boolean;
}

export type SslCheckOutcome =
  | { readonly ok: true; readonly data: SslCheckData }
  | { readonly ok: false; readonly reason: string };

const DEFAULT_HTTPS_PORT = 443;

/** OpenSSL codes that mean the certificate is signed by itself. */
const SELF_SIGNED_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN']);

function daysUntil(date: Date, now: Date): number {
  // Floored, so "expires in 23 hours" reads as 0 days rather than 1. Rounding
  // up here would let a certificate that expires today report a day in hand.
  return Math.floor((date.getTime() - now.getTime()) / 86_400_000);
}

/**
 * Node reports the certificate's validity window as a non-ISO string
 * (`"Mar  4 12:00:00 2026 GMT"`). `Date.parse` handles it, but returns NaN for
 * anything unexpected, and a NaN date silently becomes a null expiry rather
 * than a wrong one.
 */
function parseCertificateDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `DNS:example.com, DNS:*.example.com` → the hostnames, lowercased. */
function parseSubjectAlternativeNames(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.toLowerCase().startsWith('dns:'))
    .map((entry) => entry.slice(4).trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Whether `hostname` is covered by a certificate name, including one wildcard.
 *
 * A wildcard matches exactly one label and never the apex: `*.example.com`
 * covers `www.example.com` but not `example.com` and not `a.b.example.com`.
 * That is RFC 6125, and getting it wrong in the lenient direction would report
 * a mismatched certificate as valid.
 */
export function hostnameMatchesCertificateName(hostname: string, name: string): boolean {
  const host = hostname.toLowerCase();
  const candidate = name.toLowerCase();

  if (candidate === host) return true;
  if (!candidate.startsWith('*.')) return false;

  const suffix = candidate.slice(1); // ".example.com"
  if (!host.endsWith(suffix)) return false;

  const label = host.slice(0, host.length - suffix.length);
  return label.length > 0 && !label.includes('.');
}

export function certificateCoversHostname(
  hostname: string,
  names: readonly string[],
  commonName: string | undefined,
): boolean {
  /*
   * The subject common name is consulted only when there are no SANs at all.
   * Every browser stopped honouring CN as an identity in 2017, and a
   * certificate issued since then always carries SANs — so falling back to CN
   * when SANs exist would accept an identity no browser would.
   */
  const candidates = names.length > 0 ? names : commonName ? [commonName] : [];
  return candidates.some((name) => hostnameMatchesCertificateName(hostname, name));
}

/** Formats an X.509 name object as a readable one-liner. */
function formatName(name: PeerCertificate['issuer'] | undefined): string | null {
  if (!name) return null;
  const organization = typeof name.O === 'string' ? name.O : null;
  const commonName = typeof name.CN === 'string' ? name.CN : null;

  if (organization && commonName && organization !== commonName) {
    return `${commonName} (${organization})`;
  }
  return commonName ?? organization;
}

/**
 * Resolves a hostname to an address the guard permits.
 *
 * Returns every approved address so a host with both a blocked and a public
 * address still connects — to the public one. Mirrors `safe-lookup.ts`, which
 * cannot be reused directly because that one plugs into undici's socket
 * factory rather than being callable.
 */
async function resolvePermittedAddress(
  hostname: string,
  allowLoopback: boolean,
): Promise<{ address: string } | { rejected: string }> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch (error) {
    return { rejected: error instanceof Error ? error.message : 'DNS lookup failed' };
  }

  let firstRejection: string | null = null;
  for (const candidate of addresses) {
    const verdict = checkAddress(candidate.address, { allowLoopback });
    if (verdict.allowed) return { address: candidate.address };
    firstRejection ??= verdict.reason ?? 'not publicly routable';
  }

  return { rejected: `Refused to connect to ${hostname}: ${firstRejection ?? 'no addresses'}` };
}

/** Opens the TLS connection and hands back the socket once the handshake settles. */
async function handshake(
  address: string,
  port: number,
  servername: string,
  timeoutMs: number,
): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const socket = connect({
      host: address,
      port,
      // SNI carries the real hostname even though we dial an IP, so the origin
      // serves the certificate it would serve a browser.
      servername,
      // See the module comment: nothing is transferred over this socket, and
      // rejecting here would make an invalid certificate unreportable.
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });

    const settle = (action: () => void): void => {
      clearTimeout(timer);
      socket.removeAllListeners('secureConnect');
      socket.removeAllListeners('error');
      socket.removeAllListeners('timeout');
      action();
    };

    const timer = setTimeout(() => {
      settle(() => {
        socket.destroy();
        reject(new Error(`TLS handshake timed out after ${String(timeoutMs)} ms.`));
      });
    }, timeoutMs);
    timer.unref();

    socket.once('secureConnect', () => {
      settle(() => {
        resolve(socket);
      });
    });
    socket.once('timeout', () => {
      settle(() => {
        socket.destroy();
        reject(new Error(`TLS handshake timed out after ${String(timeoutMs)} ms.`));
      });
    });
    socket.once('error', (error: Error) => {
      settle(() => {
        socket.destroy();
        reject(error);
      });
    });
  });
}

/** Reads everything of interest off a completed handshake. */
function describeCertificate(socket: TLSSocket, hostname: string, now: Date): SslCheckData {
  const certificate = socket.getPeerCertificate(false);
  const authorized = socket.authorized;
  const authorizationError = socket.authorizationError as NodeJS.ErrnoException | undefined;

  const validFrom = parseCertificateDate(certificate.valid_from);
  const validTo = parseCertificateDate(certificate.valid_to);
  const names = parseSubjectAlternativeNames(certificate.subjectaltname);
  const commonName =
    typeof certificate.subject?.CN === 'string' ? certificate.subject.CN : undefined;

  const hostnameMatches = certificateCoversHostname(hostname, names, commonName);
  const errorCode = authorizationError?.code ?? authorizationError?.message;

  return {
    // "Valid" means what a browser would decide: the chain verified *and* the
    // name matches. Node's `authorized` already covers both when the socket was
    // opened with the servername, but the name check is repeated explicitly so
    // the reason is reportable rather than only the verdict.
    valid: authorized && hostnameMatches,
    issuer: formatName(certificate.issuer),
    subject: formatName(certificate.subject),
    validFrom: validFrom?.toISOString() ?? null,
    validTo: validTo?.toISOString() ?? null,
    daysRemaining: validTo ? daysUntil(validTo, now) : null,
    hostnameMatches,
    selfSigned: errorCode !== undefined && SELF_SIGNED_CODES.has(errorCode),
    protocol: socket.getProtocol(),
    keyAlgorithm:
      typeof certificate.asn1Curve === 'string'
        ? `EC ${certificate.asn1Curve}`
        : certificate.bits
          ? `RSA ${String(certificate.bits)}`
          : null,
    serialNumber: certificate.serialNumber || null,
    subjectAlternativeNames: names,
    validationError: authorized
      ? hostnameMatches
        ? null
        : `Certificate does not cover ${hostname}.`
      : (errorCode ?? 'Certificate chain could not be verified.'),
  };
}

/**
 * Inspects the certificate served for a URL.
 *
 * A plain-HTTP URL is not an error and not a failure: it simply has no
 * certificate to inspect, and the caller decides what that means.
 */
export async function checkSslCertificate(
  url: string,
  options: SslCheckOptions,
  now: Date = new Date(),
): Promise<SslCheckOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'The website URL could not be parsed.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'This website is not served over HTTPS.' };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = parsed.port ? Number(parsed.port) : DEFAULT_HTTPS_PORT;

  const resolved = await resolvePermittedAddress(hostname, options.allowLoopback);
  if ('rejected' in resolved) {
    return { ok: false, reason: resolved.rejected };
  }

  let socket: TLSSocket;
  try {
    // `host` is the address the guard approved, not the hostname, so no second
    // DNS query happens inside the TLS layer and the rebinding window stays shut.
    socket = await handshake(resolved.address, port, hostname, options.timeoutMs);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'TLS handshake failed.' };
  }

  try {
    const certificate = socket.getPeerCertificate(false);
    // An empty object is what Node returns when the peer sent nothing usable.
    if (Object.keys(certificate).length === 0) {
      return { ok: false, reason: 'The server presented no certificate.' };
    }
    return { ok: true, data: describeCertificate(socket, hostname, now) };
  } finally {
    // Nothing is ever sent on this socket, so there is nothing to flush.
    socket.destroy();
  }
}
