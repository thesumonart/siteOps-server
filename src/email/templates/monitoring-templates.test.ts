import { describe, expect, it } from 'vitest';

import { websiteDownTemplate, websiteRecoveredTemplate } from './index.js';

/**
 * The shared layout's escaping is covered in `../layout.test.ts`. What is
 * asserted here is that these two templates route every user-controlled value
 * through it — a website name is chosen by the customer and delivered to an
 * inbox — and that the failure description degrades sensibly when the checker
 * has less to report.
 */

const DOWN_BASE = {
  websiteName: 'Acme Store',
  websiteUrl: 'https://acme.example.com',
  startedAt: new Date('2026-01-15T10:00:00.000Z'),
  failedCheckCount: 3,
  lastStatusCode: null,
  lastErrorType: null,
  dashboardUrl: 'https://app.siteops.test/dashboard/websites/abc',
};

describe('websiteDownTemplate', () => {
  it('names the website and the confirming failure count', () => {
    const content = websiteDownTemplate({ ...DOWN_BASE, failedCheckCount: 3 });

    expect(content.subject).toContain('Acme Store');
    expect(content.text).toContain('3 consecutive failed checks');
    expect(content.text).toContain('https://acme.example.com');
  });

  it('prefers the HTTP status when the checker got a response', () => {
    const content = websiteDownTemplate({
      ...DOWN_BASE,
      lastStatusCode: 503,
      lastErrorType: 'http_error',
    });

    expect(content.text).toContain('HTTP 503');
  });

  it('falls back to the error label when no response was received', () => {
    const content = websiteDownTemplate({ ...DOWN_BASE, lastErrorType: 'dns_failure' });

    expect(content.text).toContain('DNS lookup failed');
  });

  it('still says something useful when there is neither a status nor an error type', () => {
    const content = websiteDownTemplate(DOWN_BASE);

    expect(content.text).toContain('The last check failed.');
  });

  it('promises no repeat while the site stays down', () => {
    // The wording is the user-facing half of the "one email per transition"
    // rule; if the rule changed, this sentence would be a lie.
    const content = websiteDownTemplate(DOWN_BASE);

    expect(content.text).toContain('will not repeat');
  });

  it('escapes a website name containing markup', () => {
    const content = websiteDownTemplate({
      ...DOWN_BASE,
      websiteName: '<img src=x onerror="alert(1)">',
    });

    expect(content.html).not.toContain('<img src=x');
    expect(content.html).toContain('&lt;img src=x');
  });
});

describe('websiteRecoveredTemplate', () => {
  const RECOVERED_BASE = {
    websiteName: 'Acme Store',
    websiteUrl: 'https://acme.example.com',
    resolvedAt: new Date('2026-01-15T10:30:00.000Z'),
    durationSeconds: 1_800,
    dashboardUrl: 'https://app.siteops.test/dashboard/websites/abc',
  };

  it('reports the outage duration in human terms', () => {
    const content = websiteRecoveredTemplate(RECOVERED_BASE);

    expect(content.subject).toContain('Acme Store');
    expect(content.text).toContain('30m');
  });

  it('escapes a website name containing markup', () => {
    const content = websiteRecoveredTemplate({
      ...RECOVERED_BASE,
      websiteName: '<script>alert(1)</script>',
    });

    expect(content.html).not.toContain('<script>alert(1)</script>');
    expect(content.html).toContain('&lt;script&gt;');
  });
});
