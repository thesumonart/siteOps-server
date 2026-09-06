import { describe, expect, it } from 'vitest';

import {
  collapseWhitespace,
  decodeEntities,
  documentLanguage,
  extractText,
  extractTextLines,
  findTags,
  innerText,
  linkHref,
  metaContent,
  selectRegion,
  stripSelectors,
} from './parse.js';

/**
 * The HTML reader.
 *
 * Three monitors depend on this being right: SEO reads attributes off it,
 * change detection hashes the text it produces, and the crawler collects links
 * from it. The cases below are the ones where a naive implementation is wrong
 * in a way that shows up as a false alert rather than as an obvious break.
 */

describe('decodeEntities', () => {
  it('decodes the named entities that appear in prose', () => {
    expect(decodeEntities('Tom &amp; Jerry &mdash; a &quot;classic&quot;')).toBe(
      'Tom & Jerry — a "classic"',
    );
  });

  it('decodes numeric and hexadecimal forms', () => {
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
  });

  it('leaves an unknown entity alone rather than dropping it', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;');
  });

  it('ignores an out-of-range code point', () => {
    expect(decodeEntities('&#99999999;')).toBe('&#99999999;');
  });
});

describe('extractText', () => {
  it('removes script and style contents entirely', () => {
    const html = `
      <html><head><style>body { color: red }</style></head>
      <body><script>var secret = 1;</script><p>Visible</p></body></html>`;

    const text = extractText(html);

    expect(text).toContain('Visible');
    expect(text).not.toContain('color');
    expect(text).not.toContain('secret');
  });

  it('removes comments', () => {
    expect(extractText('<p>Shown</p><!-- hidden note -->')).toBe('Shown');
  });

  it('does not run words together across block boundaries', () => {
    // Without a separator this reads "OneTwo", which a diff sees as an edit.
    expect(extractText('<p>One</p><p>Two</p>')).toBe('One Two');
  });

  it('collapses whitespace so reformatting is not a content change', () => {
    const compact = extractText('<p>Hello world</p>');
    const spread = extractText('<p>\n   Hello\n   world\n</p>');

    expect(compact).toBe(spread);
  });
});

describe('extractTextLines', () => {
  it('splits on block boundaries and drops blank lines', () => {
    expect(extractTextLines('<h1>Title</h1><p>Body</p><p></p><li>Item</li>')).toEqual([
      'Title',
      'Body',
      'Item',
    ]);
  });
});

describe('findTags', () => {
  it('reads attributes, quoted either way and unquoted', () => {
    const [tag] = findTags('<img src="a.png" alt=\'Hi\' width=100>', 'img');

    expect(tag?.attributes.get('src')).toBe('a.png');
    expect(tag?.attributes.get('alt')).toBe('Hi');
    expect(tag?.attributes.get('width')).toBe('100');
  });

  it('treats attribute names case-insensitively', () => {
    const [tag] = findTags('<IMG SRC="a.png">', 'img');
    expect(tag?.attributes.get('src')).toBe('a.png');
  });

  it('records a valueless attribute as empty rather than dropping it', () => {
    const [tag] = findTags('<img src="a.png" loading>', 'img');
    expect(tag?.attributes.has('loading')).toBe(true);
  });

  it('respects the cap so a pathological document cannot blow up memory', () => {
    const html = '<img src="a.png">'.repeat(50);
    expect(findTags(html, 'img', 10)).toHaveLength(10);
  });
});

describe('innerText, metaContent, linkHref, documentLanguage', () => {
  const html = `
    <html lang="en-GB">
      <head>
        <title>  Page   title </title>
        <meta name="description" content="A description">
        <meta property="og:title" content="Social title">
        <link rel="alternate canonical" href="https://example.com/">
      </head>
      <body><h1>Heading <span>with markup</span></h1></body>
    </html>`;

  it('reads the title, trimmed and collapsed', () => {
    expect(innerText(html, 'title')).toBe('Page title');
  });

  it('strips markup from inside an element', () => {
    expect(innerText(html, 'h1')).toBe('Heading with markup');
  });

  it('reads a meta by name and by property', () => {
    expect(metaContent(html, 'description')).toBe('A description');
    expect(metaContent(html, 'og:title')).toBe('Social title');
  });

  it('returns null for a meta that is not there', () => {
    expect(metaContent(html, 'robots')).toBeNull();
  });

  it('matches a rel token within a list rather than the whole attribute', () => {
    expect(linkHref(html, 'canonical')).toBe('https://example.com/');
  });

  it('reads the document language', () => {
    expect(documentLanguage(html)).toBe('en-GB');
  });
});

describe('stripSelectors', () => {
  it('removes an element by tag, contents included', () => {
    const result = stripSelectors('<p>Keep</p><aside>Drop</aside>', ['aside']);

    expect(extractText(result)).toBe('Keep');
  });

  it('removes an element by class', () => {
    const result = stripSelectors('<div class="ad">Advert</div><p>Keep</p>', ['.ad']);

    expect(extractText(result)).toBe('Keep');
  });

  it('matches a class as a whole token, not as a substring', () => {
    // `.ad` must not match `class="advanced"`, or turning off adverts would
    // silently blank half the page and read as a huge content change.
    const result = stripSelectors('<div class="advanced">Keep</div>', ['.ad']);

    expect(extractText(result)).toBe('Keep');
  });

  it('matches a class among several', () => {
    const result = stripSelectors('<div class="banner ad sticky">Advert</div><p>Keep</p>', ['.ad']);

    expect(extractText(result)).toBe('Keep');
  });

  it('removes an element by id', () => {
    const result = stripSelectors('<div id="timestamp">Now</div><p>Keep</p>', ['#timestamp']);

    expect(extractText(result)).toBe('Keep');
  });

  it('removes nested content of the same tag whole', () => {
    const result = stripSelectors('<div class="ad"><div>Inner</div>Outer</div><p>Keep</p>', [
      '.ad',
    ]);

    expect(extractText(result)).toBe('Keep');
  });

  it('removes only the opening tag when the element is never closed', () => {
    // The conservative choice: removing to the end of a malformed document
    // would blank the whole comparison and report a total rewrite.
    const result = stripSelectors('<div class="ad"><p>Still here</p>', ['.ad']);

    expect(extractText(result)).toContain('Still here');
  });

  it('ignores a selector containing regex metacharacters rather than matching wildly', () => {
    const html = '<p>Keep</p>';
    expect(stripSelectors(html, ['.a.*'])).toBe(html);
    expect(stripSelectors(html, ['(p|div)'])).toBe(html);
  });

  it('applies several selectors in turn', () => {
    const result = stripSelectors(
      '<div class="ad">A</div><div id="ts">B</div><nav>C</nav><p>Keep</p>',
      ['.ad', '#ts', 'nav'],
    );

    expect(extractText(result)).toBe('Keep');
  });
});

describe('selectRegion', () => {
  it('returns the contents of a matching element', () => {
    const region = selectRegion('<header>No</header><main id="c"><p>Yes</p></main>', '#c');

    expect(region).not.toBeNull();
    expect(extractText(region ?? '')).toBe('Yes');
  });

  it('handles nesting of the same tag', () => {
    const region = selectRegion(
      '<div class="watch"><div>Inner</div> Outer</div><p>Outside</p>',
      '.watch',
    );

    expect(extractText(region ?? '')).toBe('Inner Outer');
  });

  it('returns null when nothing matches, rather than the whole document', () => {
    // Reported to the user: a selector that stopped matching after a redesign
    // should be visible, not silently degrade to watching everything.
    expect(selectRegion('<p>Body</p>', '#missing')).toBeNull();
  });
});

describe('collapseWhitespace', () => {
  it('collapses runs and trims', () => {
    expect(collapseWhitespace('  a \n\t b  ')).toBe('a b');
  });
});
