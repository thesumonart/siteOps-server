import { describe, expect, it } from 'vitest';

import { openSecret, sealSecret } from './secret-box.js';

const SLACK_URL = 'https://hooks.slack.com/services/T0000/B0000/abcdefghijklmnop';

/** Replaces the first character of one `:`-separated segment with a different one. */
function tamper(sealed: string, segment: number): string {
  const parts = sealed.split(':');
  const value = parts[segment] ?? '';
  const first = value.charAt(0);
  parts[segment] = `${first === 'A' ? 'B' : 'A'}${value.slice(1)}`;
  return parts.join(':');
}

describe('sealed credentials', () => {
  it('opens what it sealed, under the same context', () => {
    const sealed = sealSecret(SLACK_URL, 'org-a');
    expect(openSecret(sealed, 'org-a')).toBe(SLACK_URL);
  });

  it('never stores the plaintext, or anything that reveals it', () => {
    const sealed = sealSecret(SLACK_URL, 'org-a');
    expect(sealed).not.toContain('hooks.slack.com');
    expect(sealed).not.toContain('abcdefghijklmnop');
  });

  it('seals the same value differently every time', () => {
    // A fresh IV per value. Two identical ciphertexts would tell a reader of
    // the database that two channels point at the same Slack channel.
    expect(sealSecret(SLACK_URL, 'org-a')).not.toBe(sealSecret(SLACK_URL, 'org-a'));
  });

  it('refuses to open under another organization', () => {
    // A ciphertext copied onto another tenant's channel must not work there.
    const sealed = sealSecret(SLACK_URL, 'org-a');
    expect(openSecret(sealed, 'org-b')).toBeNull();
  });

  it('refuses a tampered ciphertext rather than decrypting it to something else', () => {
    const sealed = sealSecret(SLACK_URL, 'org-a');
    expect(openSecret(tamper(sealed, 3), 'org-a')).toBeNull();
  });

  it('refuses a tampered authentication tag', () => {
    const sealed = sealSecret(SLACK_URL, 'org-a');
    expect(openSecret(tamper(sealed, 2), 'org-a')).toBeNull();
  });

  it('refuses anything that is not a sealed value', () => {
    for (const value of ['', 'v1', 'v2:a:b:c', 'v1:a:b:c:d', SLACK_URL]) {
      expect(openSecret(value, 'org-a')).toBeNull();
    }
  });
});
