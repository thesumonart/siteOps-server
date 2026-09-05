import { describe, expect, it } from 'vitest';

import { resetPasswordTemplate } from './reset-password.js';
import { verifyEmailTemplate } from './verify-email.js';

/**
 * These templates share the escaping-security guarantees tested exhaustively
 * in `../layout.test.ts` — the checks here only cover
 * that each template actually threads user-controlled fields through the
 * escaping layout rather than interpolating them directly.
 */
describe('verifyEmailTemplate', () => {
  const props = {
    name: 'Sumon',
    verificationUrl: 'https://api.siteops.test/api/auth/verify-email?token=abc123',
    expiresInMinutes: 60,
  };

  it('includes the action link in both the HTML and text parts', () => {
    const email = verifyEmailTemplate(props);

    expect(email.subject).toBe('Confirm your SiteOps email address');
    expect(email.html).toContain('token=abc123');
    expect(email.text).toContain('token=abc123');
  });

  it('always provides a plain-text alternative', () => {
    const email = verifyEmailTemplate(props);
    expect(email.text.length).toBeGreaterThan(0);
    expect(email.text).not.toContain('<');
  });

  it('states the expiry so the link is not treated as permanent', () => {
    expect(verifyEmailTemplate(props).text).toContain('60 minutes');
  });

  it('escapes a hostile display name', () => {
    const email = verifyEmailTemplate({
      ...props,
      name: '<img src=x onerror="alert(1)">',
    });

    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('&lt;img src=x');
    expect(email.html).not.toContain('onerror="alert(1)"');
  });

  it('escapes a hostile URL rather than letting it close the attribute', () => {
    const email = verifyEmailTemplate({
      ...props,
      verificationUrl: 'https://evil.test/"><script>alert(1)</script>',
    });

    expect(email.html).not.toContain('"><script>');
  });
});

describe('resetPasswordTemplate', () => {
  const props = {
    name: 'Sumon',
    resetUrl: 'https://app.siteops.test/reset-password?token=xyz789',
    expiresInMinutes: 60,
  };

  it('includes the reset link', () => {
    const email = resetPasswordTemplate(props);
    expect(email.subject).toBe('Reset your SiteOps password');
    expect(email.html).toContain('token=xyz789');
    expect(email.text).toContain('token=xyz789');
  });

  it('reassures rather than alarms when the request was not made by the owner', () => {
    // Most password resets are the account owner forgetting, so the copy must
    // not read like a breach notification.
    expect(resetPasswordTemplate(props).text).toContain('your password has not changed');
  });

  it('escapes a hostile display name', () => {
    const email = resetPasswordTemplate({ ...props, name: '</p><script>alert(1)</script>' });
    expect(email.html).not.toContain('<script>alert(1)</script>');
  });
});
