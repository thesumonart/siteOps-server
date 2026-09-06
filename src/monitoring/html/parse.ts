/**
 * A focused HTML reader for the monitors that need one.
 *
 * **Not a parser.** It builds no tree, resolves no nesting and implements none
 * of the HTML5 error recovery a browser does. It extracts a specific, closed
 * list of things — the head metadata, headings, link and image attributes, the
 * visible text — from documents that are usually well-formed, and it is
 * deliberately tolerant of ones that are not.
 *
 * That scope is a decision, not a shortcut. A real parser (`parse5`, `cheerio`)
 * is a large dependency whose value is correct tree construction, and none of
 * these monitors needs a tree: SEO reads attributes off tags, change detection
 * hashes visible text, and the crawler collects `href`s. What a tree *would*
 * buy is exact selector semantics, and that is why the content monitor's
 * "ignore" selectors are documented as tag/class/id only rather than pretending
 * to be CSS.
 *
 * Everything here is bounded. The input is already capped by the fetcher, and
 * each extractor caps its own output, because the documents it reads are
 * written by people we are monitoring rather than people we trust.
 */

/** Elements whose contents are never visible text. */
const NON_CONTENT_ELEMENTS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe'];

const NON_CONTENT_PATTERN = new RegExp(
  `<(${NON_CONTENT_ELEMENTS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`,
  'gi',
);

const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const TAG_PATTERN = /<[^>]+>/g;

/** The named entities that actually appear in prose, plus numeric forms. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, entity: string) => {
    const lower = entity.toLowerCase();

    if (lower.startsWith('#x')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }

    return NAMED_ENTITIES[lower] ?? match;
  });
}

/** Collapses runs of whitespace and trims. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The visible text of a document.
 *
 * Scripts, styles and comments are removed first, then tags. Block-level tags
 * become newlines so that words either side of a `</p>` do not run together —
 * which matters for change detection, where a spurious join looks like an edit.
 */
export function extractText(html: string): string {
  return collapseWhitespace(
    decodeEntities(
      html
        .replace(NON_CONTENT_PATTERN, ' ')
        .replace(COMMENT_PATTERN, ' ')
        .replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer)\b[^>]*>/gi, '\n')
        .replace(TAG_PATTERN, ' '),
    ).replace(/[ \t]+/g, ' '),
  );
}

/**
 * Text split into lines, for a line-level diff.
 *
 * Separate from {@link extractText} because change detection wants structure —
 * "three lines were added" is a far more useful summary than a character count
 * — while hashing wants one flat string.
 */
export function extractTextLines(html: string): readonly string[] {
  return decodeEntities(
    html
      .replace(NON_CONTENT_PATTERN, '\n')
      .replace(COMMENT_PATTERN, '\n')
      .replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer)\b[^>]*>/gi, '\n')
      .replace(TAG_PATTERN, ' '),
  )
    .split('\n')
    .map((line) => collapseWhitespace(line))
    .filter((line) => line.length > 0);
}

export interface HtmlTag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  /** Byte offset of the tag's `<`, so callers can slice out inner content. */
  readonly start: number;
  readonly end: number;
}

const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

function parseAttributes(raw: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();

  for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;

    const rawValue = match[2] ?? '';
    const unquoted =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;

    // First wins: a duplicated attribute is what a browser takes too.
    if (!attributes.has(name)) attributes.set(name, decodeEntities(unquoted));
  }

  return attributes;
}

/**
 * Every opening tag of a given name.
 *
 * Capped, because an extractor must not turn a document with fifty thousand
 * `<img>` tags into fifty thousand objects — the fetcher's byte cap bounds the
 * input, but a pathological document can still be mostly tags.
 */
export function findTags(html: string, tagName: string, limit = 5000): readonly HtmlTag[] {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  const tags: HtmlTag[] = [];

  for (const match of html.matchAll(pattern)) {
    if (tags.length >= limit) break;
    const index = match.index;
    tags.push({
      name: tagName.toLowerCase(),
      attributes: parseAttributes(match[1] ?? ''),
      start: index,
      end: index + match[0].length,
    });
  }

  return tags;
}

/** The first opening tag of a name, or null. */
export function findTag(html: string, tagName: string): HtmlTag | null {
  return findTags(html, tagName, 1)[0] ?? null;
}

/**
 * The text inside the first `<tag>…</tag>` pair.
 *
 * Naive on purpose: it takes the first closing tag of the same name rather than
 * tracking nesting. For the elements this is used on — `title`, `h1` — nesting
 * of the same tag is invalid HTML, so the simple reading is also the correct
 * one.
 */
export function innerText(html: string, tagName: string): string | null {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}\\s*>`, 'i');
  const match = pattern.exec(html);
  if (!match?.[1]) return null;

  return collapseWhitespace(decodeEntities(match[1].replace(TAG_PATTERN, ' ')));
}

/** The content of the first `<meta>` with a matching `name` or `property`. */
export function metaContent(html: string, key: string): string | null {
  const wanted = key.toLowerCase();

  for (const tag of findTags(html, 'meta')) {
    const name = tag.attributes.get('name')?.toLowerCase();
    const property = tag.attributes.get('property')?.toLowerCase();
    if (name === wanted || property === wanted) {
      const content = tag.attributes.get('content');
      return content === undefined ? null : collapseWhitespace(content);
    }
  }

  return null;
}

/** The `href` of the first `<link rel="…">` matching a relation. */
export function linkHref(html: string, relation: string): string | null {
  const wanted = relation.toLowerCase();

  for (const tag of findTags(html, 'link')) {
    const rel = tag.attributes.get('rel')?.toLowerCase();
    // `rel` is a space-separated token list: `rel="alternate canonical"`.
    if (rel?.split(/\s+/).includes(wanted)) {
      return tag.attributes.get('href') ?? null;
    }
  }

  return null;
}

/** The document's declared language, from `<html lang>`. */
export function documentLanguage(html: string): string | null {
  return findTag(html, 'html')?.attributes.get('lang') ?? null;
}

/**
 * Removes the regions matched by a set of simple selectors.
 *
 * Supports exactly three forms — `tag`, `.class` and `#id` — and says so. This
 * is what the content monitor's "ignore" configuration applies, and pretending
 * to support CSS when the implementation cannot would be worse than a
 * documented subset: someone would write `.ads > .banner`, see nothing happen,
 * and conclude the feature is broken.
 *
 * A matched element is removed together with its contents, found by scanning
 * forward for the matching close tag with simple depth counting. Unclosed tags
 * fall back to removing just the opening tag, which is the conservative choice:
 * removing to the end of the document on a malformed page would blank the whole
 * comparison.
 */
export function stripSelectors(html: string, selectors: readonly string[]): string {
  let result = html;

  for (const selector of selectors) {
    const trimmed = selector.trim();
    if (trimmed.length === 0) continue;

    result = trimmed.startsWith('.')
      ? stripByAttribute(result, 'class', trimmed.slice(1), true)
      : trimmed.startsWith('#')
        ? stripByAttribute(result, 'id', trimmed.slice(1), false)
        : stripByTag(result, trimmed);
  }

  return result;
}

/** Escapes a string so it cannot smuggle regex syntax in from configuration. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A pattern fragment matching `attribute="value"` on an opening tag.
 *
 * The quote is captured as a *named* group and referred to with `\k<q>`. A
 * numbered backreference counts from the start of the whole pattern, and these
 * fragments are embedded in one that already captures the tag name — so `\1`
 * pointed at the tag name rather than at the opening quote, and every attribute
 * selector silently matched nothing.
 */
function attributeMatcher(attribute: string, escapedValue: string, tokenList: boolean): string {
  return tokenList
    ? `${attribute}\\s*=\\s*(?<q>["'])(?:[^"']*\\s)?${escapedValue}(?:\\s[^"']*)?\\k<q>`
    : `${attribute}\\s*=\\s*(?<q>["'])${escapedValue}\\k<q>`;
}

function stripByTag(html: string, tagName: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(tagName)) return html;

  const pattern = new RegExp(
    `<${escapeRegex(tagName)}\\b[^>]*>[\\s\\S]*?</${escapeRegex(tagName)}\\s*>`,
    'gi',
  );
  return html.replace(pattern, ' ');
}

function stripByAttribute(
  html: string,
  attribute: string,
  value: string,
  tokenList: boolean,
): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) return html;

  // A class attribute is a token list, so the match must be on a whole token
  // rather than a substring: `.ad` must not match `class="advanced"`.
  const attributeMatch = attributeMatcher(attribute, escapeRegex(value), tokenList);

  const openingPattern = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*${attributeMatch}[^>]*>`,
    'gi',
  );

  let result = '';
  let cursor = 0;

  for (const match of html.matchAll(openingPattern)) {
    const index = match.index;
    if (index < cursor) continue;

    const tagName = match[1] ?? '';
    const contentStart = index + match[0].length;
    const closeIndex = findMatchingClose(html, tagName, contentStart);

    result += html.slice(cursor, index);
    cursor = closeIndex === -1 ? contentStart : closeIndex;
  }

  return result + html.slice(cursor);
}

/**
 * The index just past the close tag matching an opening tag at `from`.
 *
 * Counts nesting of the same tag name so a `<div class="ad">` containing inner
 * `<div>`s is removed whole. Returns -1 when the element is never closed.
 */
function findMatchingClose(html: string, tagName: string, from: number): number {
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(tagName)) return -1;

  const escaped = escapeRegex(tagName);
  const pattern = new RegExp(`<(/?)${escaped}\\b[^>]*>`, 'gi');
  pattern.lastIndex = from;

  let depth = 1;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }

  return -1;
}

/**
 * The region inside the first element matching a simple selector.
 *
 * The counterpart of {@link stripSelectors}, for "watch only this part of the
 * page". Returns null when nothing matches, which the caller reports rather
 * than silently falling back to the whole document — a selector that stopped
 * matching after a redesign should be visible, not invisible.
 */
export function selectRegion(html: string, selector: string): string | null {
  const trimmed = selector.trim();
  if (trimmed.length === 0) return null;

  const isClass = trimmed.startsWith('.');
  const isId = trimmed.startsWith('#');
  const value = isClass || isId ? trimmed.slice(1) : trimmed;

  if (!isClass && !isId) {
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(value)) return null;
    const pattern = new RegExp(
      `<${escapeRegex(value)}\\b[^>]*>([\\s\\S]*?)</${escapeRegex(value)}\\s*>`,
      'i',
    );
    return pattern.exec(html)?.[1] ?? null;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(value)) return null;

  const attributeMatch = attributeMatcher(isClass ? 'class' : 'id', escapeRegex(value), isClass);

  const opening = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*${attributeMatch}[^>]*>`, 'i');
  const match = opening.exec(html);
  if (!match) return null;

  const contentStart = match.index + match[0].length;
  const closeIndex = findMatchingClose(html, match[1] ?? '', contentStart);

  return closeIndex === -1
    ? html.slice(contentStart)
    : html.slice(contentStart, closeIndex).replace(/<\/[a-zA-Z][a-zA-Z0-9-]*\s*>$/, '');
}
