import { describe, expect, it } from 'vitest';

import { parseRobots, permissiveRobots } from './robots.js';

/**
 * `robots.txt` handling.
 *
 * The bias throughout is towards not fetching. Every case where the standard is
 * ambiguous, or the file is malformed, resolves towards leaving the page alone
 * — being wrong in the permissive direction is what gets a customer's IP
 * blocked by their own host.
 */

const AGENT = 'siteopsmonitor/1.0 (+https://siteops.app)';

function rules(text: string) {
  return parseRobots(text, AGENT);
}

describe('parseRobots — matching', () => {
  it('applies a wildcard group', () => {
    const robots = rules('User-agent: *\nDisallow: /private/');

    expect(robots.isAllowed('/public/page')).toBe(true);
    expect(robots.isAllowed('/private/page')).toBe(false);
  });

  it('prefers a group naming our agent over the wildcard', () => {
    const robots = rules(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: siteopsmonitor', 'Disallow: /admin/'].join(
        '\n',
      ),
    );

    // The specific group wins outright: the wildcard's blanket Disallow does
    // not also apply.
    expect(robots.isAllowed('/anything')).toBe(true);
    expect(robots.isAllowed('/admin/x')).toBe(false);
  });

  it('allows everything when no group applies to us', () => {
    const robots = rules('User-agent: googlebot\nDisallow: /');

    expect(robots.isAllowed('/anything')).toBe(true);
  });

  it('treats consecutive user-agent lines as one group', () => {
    const robots = rules(
      ['User-agent: bingbot', 'User-agent: siteopsmonitor', 'Disallow: /shared/'].join('\n'),
    );

    expect(robots.isAllowed('/shared/x')).toBe(false);
  });
});

describe('parseRobots — rule precedence', () => {
  it('lets the longest matching pattern win', () => {
    const robots = rules('User-agent: *\nDisallow: /\nAllow: /public/');

    expect(robots.isAllowed('/private')).toBe(false);
    expect(robots.isAllowed('/public/page')).toBe(true);
  });

  it('lets Allow win a tie', () => {
    const robots = rules('User-agent: *\nDisallow: /page\nAllow: /page');

    expect(robots.isAllowed('/page')).toBe(true);
  });

  it('treats an empty Disallow as permitting everything', () => {
    // `Disallow:` with no value is how a site says "nothing is off limits".
    // Reading it as a zero-length prefix match would block the entire site.
    const robots = rules('User-agent: *\nDisallow:');

    expect(robots.isAllowed('/anything')).toBe(true);
  });
});

describe('parseRobots — patterns', () => {
  it('supports a wildcard', () => {
    const robots = rules('User-agent: *\nDisallow: /*/private');

    expect(robots.isAllowed('/a/private')).toBe(false);
    expect(robots.isAllowed('/a/public')).toBe(true);
  });

  it('supports an end anchor', () => {
    const robots = rules('User-agent: *\nDisallow: /*.pdf$');

    expect(robots.isAllowed('/files/report.pdf')).toBe(false);
    expect(robots.isAllowed('/files/report.pdf.html')).toBe(true);
  });

  it('matches a bare pattern as a prefix', () => {
    const robots = rules('User-agent: *\nDisallow: /admin');

    expect(robots.isAllowed('/administrator')).toBe(false);
    expect(robots.isAllowed('/user')).toBe(true);
  });
});

describe('parseRobots — extras', () => {
  it('collects sitemap declarations', () => {
    const robots = rules(
      ['Sitemap: https://example.com/sitemap.xml', 'User-agent: *', 'Disallow:'].join('\n'),
    );

    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('reads a crawl delay for our group', () => {
    expect(rules('User-agent: *\nCrawl-delay: 2\nDisallow:').crawlDelaySeconds).toBe(2);
  });

  it('ignores comments and blank lines', () => {
    const robots = rules(
      ['# a comment', '', 'User-agent: *  # inline', 'Disallow: /x  # trailing'].join('\n'),
    );

    expect(robots.isAllowed('/x')).toBe(false);
    expect(robots.isAllowed('/y')).toBe(true);
  });

  it('ignores directives it does not implement rather than guessing', () => {
    const robots = rules('User-agent: *\nClean-param: ref /page\nDisallow: /x');

    expect(robots.isAllowed('/page')).toBe(true);
    expect(robots.isAllowed('/x')).toBe(false);
  });

  it('survives a malformed file without blocking everything', () => {
    const robots = rules('this is not a robots file at all\n\n<<<>>>');

    expect(robots.isAllowed('/anything')).toBe(true);
  });
});

describe('permissiveRobots', () => {
  it('allows everything and records whether a file was found', () => {
    expect(permissiveRobots(false).isAllowed('/anything')).toBe(true);
    expect(permissiveRobots(false).found).toBe(false);
    expect(permissiveRobots(true).found).toBe(true);
  });
});
