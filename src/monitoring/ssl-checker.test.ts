import { describe, expect, it } from 'vitest';

import { certificateCoversHostname, hostnameMatchesCertificateName } from './ssl-checker.js';

/**
 * Certificate name matching, per RFC 6125.
 *
 * Tested directly rather than through a handshake because the rule is where the
 * bugs are, and every bug in the lenient direction reports a certificate a
 * browser would refuse as valid — which is worse than no monitoring at all.
 */

describe('hostnameMatchesCertificateName', () => {
  it('matches an exact name, ignoring case', () => {
    expect(hostnameMatchesCertificateName('example.com', 'example.com')).toBe(true);
    expect(hostnameMatchesCertificateName('EXAMPLE.com', 'example.COM')).toBe(true);
  });

  it('does not match a different name', () => {
    expect(hostnameMatchesCertificateName('example.com', 'example.org')).toBe(false);
  });

  it('matches one label under a wildcard', () => {
    expect(hostnameMatchesCertificateName('www.example.com', '*.example.com')).toBe(true);
    expect(hostnameMatchesCertificateName('api.example.com', '*.example.com')).toBe(true);
  });

  it('does not let a wildcard match the apex', () => {
    // `*.example.com` covering `example.com` is the single most common
    // certificate misconfiguration, and browsers refuse it.
    expect(hostnameMatchesCertificateName('example.com', '*.example.com')).toBe(false);
  });

  it('does not let a wildcard span a dot', () => {
    expect(hostnameMatchesCertificateName('a.b.example.com', '*.example.com')).toBe(false);
  });

  it('does not treat a bare wildcard as matching everything', () => {
    expect(hostnameMatchesCertificateName('example.com', '*')).toBe(false);
  });

  it('does not match a suffix that is not on a label boundary', () => {
    // `notexample.com` ends with `example.com` as a *string* but is a
    // different domain entirely.
    expect(hostnameMatchesCertificateName('notexample.com', 'example.com')).toBe(false);
    expect(hostnameMatchesCertificateName('evilexample.com', '*.example.com')).toBe(false);
  });
});

describe('certificateCoversHostname', () => {
  it('accepts a hostname listed in the subject alternative names', () => {
    expect(
      certificateCoversHostname(
        'www.example.com',
        ['example.com', 'www.example.com'],
        'example.com',
      ),
    ).toBe(true);
  });

  it('refuses a hostname absent from the alternative names', () => {
    expect(certificateCoversHostname('other.example.com', ['example.com'], 'example.com')).toBe(
      false,
    );
  });

  it('ignores the common name when alternative names are present', () => {
    /*
     * Browsers stopped honouring the common name as an identity in 2017. A
     * certificate that lists SANs and happens to carry a matching CN must be
     * judged on the SANs alone, or SiteOps would report a certificate as valid
     * that every visitor's browser refuses.
     */
    expect(certificateCoversHostname('www.example.com', ['example.com'], 'www.example.com')).toBe(
      false,
    );
  });

  it('falls back to the common name only when there are no alternative names', () => {
    expect(certificateCoversHostname('legacy.example.com', [], 'legacy.example.com')).toBe(true);
  });

  it('refuses when there is neither a matching name nor a common name', () => {
    expect(certificateCoversHostname('example.com', [], undefined)).toBe(false);
  });
});
