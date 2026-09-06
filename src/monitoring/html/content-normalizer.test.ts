import { describe, expect, it } from 'vitest';

import { diffContent, normalizeContent, summariseDiff } from './content-normalizer.js';

/**
 * Change detection's noise filter.
 *
 * These cases are the whole value of the feature. A monitor that reports a
 * rotating advert or a "2 minutes ago" timestamp as a content change gets
 * turned off within a week, and then it is not there when the pricing page
 * really does change. Each case below is a category of difference that must
 * *not* register.
 */

interface Options {
  readonly ignoreSelectors: readonly string[];
  readonly watchSelector: string | null;
}

const OPTIONS: Options = { ignoreSelectors: [], watchSelector: null };

function hash(html: string, options: Options = OPTIONS): string {
  return normalizeContent(html, options).hash;
}

describe('normalizeContent — differences that must be ignored', () => {
  it('ignores reformatting and whitespace', () => {
    expect(hash('<p>Hello world</p>')).toBe(hash('<p>\n  Hello\n  world\n</p>'));
  });

  it('ignores a changed script or style', () => {
    expect(hash('<script>var a=1</script><p>Body</p>')).toBe(
      hash('<script>var a=2;var b=3</script><p>Body</p>'),
    );
  });

  it('ignores an HTML comment', () => {
    expect(hash('<p>Body</p><!-- build 1041 -->')).toBe(hash('<p>Body</p><!-- build 1042 -->'));
  });

  it('ignores a changing timestamp', () => {
    expect(hash('<p>Updated 2026-01-01T10:00:00Z</p>')).toBe(
      hash('<p>Updated 2026-06-14T22:31:05Z</p>'),
    );
  });

  it('ignores a relative timestamp, which changes on every fetch', () => {
    expect(hash('<p>Posted 2 minutes ago</p>')).toBe(hash('<p>Posted 9 hours ago</p>'));
  });

  it('ignores a CSRF token or build hash', () => {
    expect(hash('<p>token a3f5b2c19d8e4710a3f5b2c19d8e4710</p>')).toBe(
      hash('<p>token 00112233445566778899aabbccddeeff</p>'),
    );
  });

  it('ignores a UUID', () => {
    expect(hash('<p>id 123e4567-e89b-12d3-a456-426614174000</p>')).toBe(
      hash('<p>id 987fcdeb-51a2-43f1-b789-123456789abc</p>'),
    );
  });

  it('ignores a visitor counter', () => {
    expect(hash('<p>1,204,551 views</p>')).toBe(hash('<p>1,204,993 views</p>'));
  });

  it('ignores tracking parameters on a URL', () => {
    expect(hash('<p>https://example.com/?utm_source=a&x=1</p>')).toBe(
      hash('<p>https://example.com/?utm_source=b&x=1</p>'),
    );
  });
});

describe('normalizeContent — differences that must be reported', () => {
  it('reports changed prose', () => {
    expect(hash('<p>Our price is £10</p>')).not.toBe(hash('<p>Our price is £20</p>'));
  });

  it('reports removed content', () => {
    expect(hash('<p>One</p><p>Two</p>')).not.toBe(hash('<p>One</p>'));
  });

  it('reports a changed heading', () => {
    expect(hash('<h1>Pricing</h1>')).not.toBe(hash('<h1>Plans</h1>'));
  });
});

describe('normalizeContent — configured scoping', () => {
  it('ignores the regions the user asked to ignore', () => {
    const options = { ignoreSelectors: ['.advert'], watchSelector: null };

    expect(hash('<div class="advert">Buy A</div><p>Body</p>', options)).toBe(
      hash('<div class="advert">Buy B</div><p>Body</p>', options),
    );
  });

  it('still reports a change outside an ignored region', () => {
    const options = { ignoreSelectors: ['.advert'], watchSelector: null };

    expect(hash('<div class="advert">Buy A</div><p>Body</p>', options)).not.toBe(
      hash('<div class="advert">Buy A</div><p>Different</p>', options),
    );
  });

  it('compares only the watched region', () => {
    const options = { ignoreSelectors: [], watchSelector: '#main' };

    expect(hash('<nav>Home A</nav><div id="main">Body</div>', options)).toBe(
      hash('<nav>Home B</nav><div id="main">Body</div>', options),
    );
  });

  it('reports a watch selector that matched nothing', () => {
    // A selector that stopped matching after a redesign must be visible, not
    // silently degrade into watching the whole page.
    const result = normalizeContent('<p>Body</p>', {
      ignoreSelectors: [],
      watchSelector: '#gone',
    });

    expect(result.selectorMissed).toBe(true);
  });

  it('does not flag a selector that matched', () => {
    const result = normalizeContent('<div id="main">Body</div>', {
      ignoreSelectors: [],
      watchSelector: '#main',
    });

    expect(result.selectorMissed).toBe(false);
  });
});

describe('diffContent', () => {
  it('reports no change for identical content', () => {
    const diff = diffContent(['a', 'b'], ['a', 'b']);

    expect(diff.ratio).toBe(0);
    expect(diff.addedLines).toEqual([]);
    expect(diff.removedLines).toEqual([]);
  });

  it('treats reordering as no change', () => {
    // Reordering a navigation menu is not a content change.
    expect(diffContent(['a', 'b', 'c'], ['c', 'a', 'b']).ratio).toBe(0);
  });

  it('counts repeated lines by occurrence, not as a set', () => {
    // Three of an item becoming two is a change a Set comparison would miss.
    const diff = diffContent(['x', 'x', 'x'], ['x', 'x']);

    expect(diff.removedLines).toEqual(['x']);
    expect(diff.ratio).toBeGreaterThan(0);
  });

  it('reports what was added and removed', () => {
    const diff = diffContent(['keep', 'gone'], ['keep', 'new']);

    expect(diff.addedLines).toEqual(['new']);
    expect(diff.removedLines).toEqual(['gone']);
  });

  it('scales the ratio with how much changed', () => {
    const small = diffContent(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'e']);
    const large = diffContent(['a', 'b', 'c', 'd'], ['w', 'x', 'y', 'z']);

    expect(small.ratio).toBeLessThan(large.ratio);
    expect(large.ratio).toBe(1);
  });

  it('reports no change between two empty pages', () => {
    expect(diffContent([], []).ratio).toBe(0);
  });
});

describe('summariseDiff', () => {
  it('shows a bounded sample of both directions', () => {
    const summary = summariseDiff(diffContent(['gone'], ['new']));

    expect(summary).toContain('+ new');
    expect(summary).toContain('- gone');
  });

  it('truncates rather than sending an unbounded excerpt in an email', () => {
    const long = Array.from({ length: 50 }, (_, index) => `line ${String(index)} `.repeat(20));
    const summary = summariseDiff(diffContent([], long), 100);

    expect(summary?.length).toBeLessThanOrEqual(100);
  });

  it('returns null when nothing changed', () => {
    expect(summariseDiff(diffContent(['a'], ['a']))).toBeNull();
  });
});
