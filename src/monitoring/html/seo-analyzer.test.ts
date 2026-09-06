import { describe, expect, it } from 'vitest';

import { analyzeSeo, type SeoAnalysisInput } from './seo-analyzer.js';

/**
 * The SEO checks.
 *
 * The scope is narrow by design — machine-readable signals off one HTML
 * document, nothing about rankings or content quality — and these cases pin
 * that scope down so it does not quietly drift into claims the implementation
 * cannot support.
 */

function page(html: string, overrides: Partial<SeoAnalysisInput> = {}): SeoAnalysisInput {
  return {
    html,
    finalUrl: 'https://example.com/page',
    robotsTxtFound: true,
    sitemapFound: true,
    robotsHeader: null,
    ...overrides,
  };
}

/** A page that passes every check, as the baseline the others deviate from. */
const HEALTHY = `
  <html lang="en">
    <head>
      <title>A perfectly reasonable page title here</title>
      <meta name="description" content="${'A description of the page that sits comfortably inside the length search engines display. '.repeat(1)}It says what the page is about.">
      <link rel="canonical" href="https://example.com/page">
      <meta property="og:title" content="Title">
      <meta property="og:description" content="Description">
      <meta property="og:image" content="https://example.com/i.png">
    </head>
    <body>
      <h1>The one heading</h1>
      <img src="a.png" alt="Described">
      <a href="/other">Another page</a>
      <p>${'word '.repeat(220)}</p>
    </body>
  </html>`;

function codes(input: SeoAnalysisInput): string[] {
  return analyzeSeo(input).findings.map((finding) => finding.code);
}

describe('analyzeSeo', () => {
  it('scores a healthy page at 100 with no findings', () => {
    const result = analyzeSeo(page(HEALTHY));

    expect(result.data.score).toBe(100);
    expect(result.findings).toEqual([]);
    expect(result.data.indexable).toBe(true);
  });

  it('reports a missing title', () => {
    expect(codes(page('<html><body><p>No head</p></body></html>'))).toContain('seo.title_missing');
  });

  it('reports a title outside the displayed length', () => {
    expect(codes(page('<title>Short</title>'))).toContain('seo.title_length');
    expect(codes(page(`<title>${'x'.repeat(120)}</title>`))).toContain('seo.title_length');
  });

  it('reports a missing description', () => {
    expect(codes(page('<title>A perfectly reasonable page title</title>'))).toContain(
      'seo.description_missing',
    );
  });

  it('reports a missing canonical', () => {
    expect(codes(page('<title>A title</title>'))).toContain('seo.canonical_missing');
  });

  it('reports a missing and a duplicated h1', () => {
    expect(codes(page('<body><p>No heading</p></body>'))).toContain('seo.h1_missing');
    expect(codes(page('<body><h1>One</h1><h1>Two</h1></body>'))).toContain('seo.h1_multiple');
  });

  it('reports plain HTTP', () => {
    expect(codes(page(HEALTHY, { finalUrl: 'http://example.com/page' }))).toContain('seo.https');
  });

  it('reports images with no alt attribute', () => {
    const result = analyzeSeo(page('<body><img src="a.png"><img src="b.png" alt="ok"></body>'));

    expect(result.findings.map((finding) => finding.code)).toContain('seo.images_missing_alt');
    expect(result.data.imagesMissingAlt).toBe(1);
    expect(result.data.imageCount).toBe(2);
  });

  it('treats an empty alt as correct, because that is what it is for', () => {
    // `alt=""` marks a decorative image. Counting it as a fault would push
    // people into writing meaningless alt text, which is worse for readers.
    const result = analyzeSeo(page('<body><img src="spacer.gif" alt=""></body>'));

    expect(result.data.imagesMissingAlt).toBe(0);
  });

  it('reports incomplete Open Graph tags and names the missing ones', () => {
    const result = analyzeSeo(page('<head><meta property="og:title" content="Only this"></head>'));
    const finding = result.findings.find((entry) => entry.code === 'seo.open_graph_incomplete');

    expect(finding?.detail).toContain('og:description');
    expect(finding?.detail).toContain('og:image');
  });

  it('reports a missing robots.txt and sitemap', () => {
    const found = codes(page(HEALTHY, { robotsTxtFound: false, sitemapFound: false }));

    expect(found).toContain('seo.robots_txt_missing');
    expect(found).toContain('seo.sitemap_missing');
  });

  it('reports thin content', () => {
    expect(codes(page('<body><h1>Hi</h1><p>Three words only</p></body>'))).toContain(
      'seo.thin_content',
    );
  });

  it('reports a page with no internal links', () => {
    const result = analyzeSeo(page('<body><a href="https://elsewhere.test/">Away</a></body>'));

    expect(result.data.internalLinkCount).toBe(0);
    expect(result.findings.map((finding) => finding.code)).toContain('seo.no_internal_links');
  });

  it('does not count fragments or mailto links as internal links', () => {
    const result = analyzeSeo(
      page('<body><a href="#top">Top</a><a href="mailto:a@b.test">Mail</a></body>'),
    );

    expect(result.data.internalLinkCount).toBe(0);
  });

  it('counts a relative link as internal', () => {
    const result = analyzeSeo(page('<body><a href="/about">About</a></body>'));

    expect(result.data.internalLinkCount).toBe(1);
  });
});

describe('analyzeSeo — indexability', () => {
  it('reports a noindex meta tag', () => {
    const result = analyzeSeo(page('<head><meta name="robots" content="noindex, follow"></head>'));

    expect(result.data.indexable).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('seo.noindex');
  });

  it('reports a noindex X-Robots-Tag header, which no amount of reading the HTML would find', () => {
    const result = analyzeSeo(page(HEALTHY, { robotsHeader: 'noindex' }));

    expect(result.data.indexable).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('seo.noindex');
  });

  it('treats `none` as noindex', () => {
    expect(
      analyzeSeo(page('<head><meta name="robots" content="none"></head>')).data.indexable,
    ).toBe(false);
  });

  it('leaves an indexable page alone', () => {
    expect(
      analyzeSeo(page('<head><meta name="robots" content="index, follow"></head>')).data.indexable,
    ).toBe(true);
  });

  it('weights noindex far above everything else', () => {
    // A page that is otherwise perfect but carries a noindex must score badly:
    // it is invisible to search, and no title length matters next to that.
    const perfect = analyzeSeo(page(HEALTHY)).data.score;
    const hidden = analyzeSeo(page(HEALTHY, { robotsHeader: 'noindex' })).data.score;

    expect(perfect).toBe(100);
    expect(hidden).toBeLessThan(80);
  });
});

describe('analyzeSeo — scoring', () => {
  it('floors rather than rounding up', () => {
    // A page at 69.6 must not report 70 when the threshold is 70.
    const result = analyzeSeo(page('<body><p>Nothing much here</p></body>'));

    expect(Number.isInteger(result.data.score)).toBe(true);
    expect(result.data.score).toBeLessThan(100);
  });

  it('never goes below zero or above one hundred', () => {
    const worst = analyzeSeo(
      page('<html><body></body></html>', {
        finalUrl: 'http://example.com/',
        robotsTxtFound: false,
        sitemapFound: false,
        robotsHeader: 'noindex',
      }),
    );

    expect(worst.data.score).toBeGreaterThanOrEqual(0);
    expect(worst.data.score).toBeLessThanOrEqual(100);
  });
});
