import { describe, expect, it } from 'vitest';

import { escapeHtml, renderLayout, renderPlainText } from './layout.js';

/**
 * User-controlled strings (a website name, a display name) land inside an HTML
 * document delivered to an inbox. These assertions exist so a refactor cannot
 * quietly drop the escaping and turn a form field into stored HTML injection —
 * this module is shared by every app that sends email, so a regression here
 * would affect all of them at once.
 */
describe('escapeHtml', () => {
  it('escapes every character that could break out of markup', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml(`"quoted" 'single'`)).toBe('&quot;quoted&quot; &#39;single&#39;');
  });

  it('escapes the ampersand first so entities are not double-broken', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('renderLayout', () => {
  const base = {
    heading: 'Hello',
    paragraphs: ['First paragraph.', 'Second paragraph.'],
  };

  it('escapes a hostile heading and paragraph', () => {
    const html = renderLayout({
      heading: '<img src=x onerror="alert(1)">',
      paragraphs: ['<script>alert(2)</script>'],
    });

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;img src=x');
  });

  it('escapes a hostile action URL rather than letting it close the attribute', () => {
    const html = renderLayout({
      ...base,
      action: { label: 'Click', url: 'https://evil.test/"><script>alert(1)</script>' },
    });

    expect(html).not.toContain('"><script>');
  });

  it('omits the action block entirely when no action is given', () => {
    const html = renderLayout(base);
    expect(html).not.toContain('href=');
  });

  it('includes the footnote when provided', () => {
    const html = renderLayout({ ...base, footnote: 'Expires soon.' });
    expect(html).toContain('Expires soon.');
  });
});

describe('renderPlainText', () => {
  it('never contains HTML', () => {
    const text = renderPlainText({
      heading: 'Hello',
      paragraphs: ['A paragraph.'],
      action: { label: 'Click here', url: 'https://example.com/action' },
      footnote: 'A footnote.',
    });

    expect(text).not.toContain('<');
    expect(text).not.toContain('>');
  });

  it('includes the action label and URL', () => {
    const text = renderPlainText({
      heading: 'Hello',
      paragraphs: [],
      action: { label: 'Click here', url: 'https://example.com/action' },
    });

    expect(text).toContain('Click here: https://example.com/action');
  });
});
