import { describe, expect, it } from 'vitest';

import { classifyError } from './http-checker.js';

/**
 * The error taxonomy, tested directly.
 *
 * `http-checker.test.ts` drives the codes a local mock server can actually
 * produce. The rest — an expired certificate, an incomplete chain, a revoked
 * one — need hosts that cannot be conjured on loopback, and this project does
 * not point its test suite at real websites to reach them. Since `classifyError`
 * is pure, a synthetic error object covers them exactly.
 */

function errorWith(code: string, message = 'boom'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('classifyError', () => {
  it.each([
    ['ENOTFOUND', 'dns_failure'],
    ['EAI_AGAIN', 'dns_failure'],
    ['ECONNREFUSED', 'connection_refused'],
    ['ECONNRESET', 'connection_reset'],
    ['EPIPE', 'connection_reset'],
    ['UND_ERR_SOCKET', 'connection_reset'],
    ['ETIMEDOUT', 'timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout'],
    ['UND_ERR_BODY_TIMEOUT', 'timeout'],
    ['SITEOPS_BLOCKED_ADDRESS', 'blocked_target'],
  ] as const)('maps %s to %s', (code, expected) => {
    expect(classifyError(errorWith(code)).type).toBe(expected);
  });

  it.each([
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_GET_ISSUER_CERT',
    'CERT_UNTRUSTED',
    'CERT_NOT_YET_VALID',
    'CERT_REVOKED',
  ])('maps the TLS failure %s to ssl_error', (code) => {
    expect(classifyError(errorWith(code)).type).toBe('ssl_error');
  });

  it('unwraps a code carried on the cause, as undici reports TLS failures', () => {
    const wrapped = new Error('fetch failed', {
      cause: errorWith(
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        'unable to get local issuer certificate',
      ),
    });

    const result = classifyError(wrapped);

    expect(result.type).toBe('ssl_error');
    // The message comes from the level the code was found on, not the wrapper:
    // "unable to get local issuer certificate" tells an operator what to fix,
    // "fetch failed" tells them nothing.
    expect(result.message).toBe('unable to get local issuer certificate');
  });

  it('falls back to unknown rather than guessing at an unrecognised code', () => {
    // A wrong guess here is worse than "unknown": it would put a confident,
    // incorrect explanation in an outage email.
    expect(classifyError(errorWith('ESOMETHINGNEW')).type).toBe('unknown');
  });

  it('treats an AbortError as a timeout even without a code', () => {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';

    expect(classifyError(aborted).type).toBe('timeout');
  });

  it('never produces "[object Object]" from a non-Error throw', () => {
    expect(classifyError({ nope: true }).message).not.toContain('[object Object]');
    expect(classifyError('a string failure').message).toBe('a string failure');
  });
});
