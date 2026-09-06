import type { MonitorFinding, SeoCheckData } from '../../contracts/index.js';
import {
  collapseWhitespace,
  documentLanguage,
  extractText,
  findTags,
  innerText,
  linkHref,
  metaContent,
} from './parse.js';

/**
 * Technical SEO checks over one page's HTML.
 *
 * **The scope is deliberately narrow and worth stating plainly**, because "SEO
 * monitoring" is a phrase that promises far more than any tool can deliver from
 * a single page fetch.
 *
 * What this checks: the machine-readable signals a crawler reads off the
 * document — title, meta description, canonical, robots directives,
 * indexability, heading structure, image alt coverage, Open Graph completeness,
 * HTTPS, and whether `robots.txt` and a sitemap exist.
 *
 * What it does not and cannot check: content quality, keyword relevance,
 * backlinks, competitor position, search rankings, crawl budget, or anything
 * requiring a rendered page or a search engine's own index. A JavaScript-only
 * site will score badly here and may rank perfectly well, because this reads
 * the server's HTML rather than what a browser eventually paints.
 *
 * The score is a weighted count of the checks below and nothing more. It is
 * useful as a trend — a score that drops after a deploy means something broke —
 * and it is not comparable to any other tool's number.
 */

/** Google truncates a title around 60 characters and a description around 160. */
const TITLE_MIN = 20;
const TITLE_MAX = 60;
const DESCRIPTION_MIN = 70;
const DESCRIPTION_MAX = 160;

/** Below this, a page has too little text for a crawler to judge it on. */
const THIN_CONTENT_WORDS = 200;

/** The Open Graph properties needed for a link to preview correctly. */
const OPEN_GRAPH_REQUIRED = ['og:title', 'og:description', 'og:image'] as const;

interface Check {
  readonly code: string;
  readonly weight: number;
  readonly severity: MonitorFinding['severity'];
  readonly message: string;
  readonly detail: string | null;
  readonly passed: boolean;
}

export interface SeoAnalysisInput {
  readonly html: string;
  /** The URL actually fetched, after redirects. */
  readonly finalUrl: string;
  readonly robotsTxtFound: boolean;
  /** A sitemap found in `robots.txt` or at the conventional path. */
  readonly sitemapFound: boolean;
  /** `X-Robots-Tag`, which overrides the meta tag and is easy to miss. */
  readonly robotsHeader: string | null;
}

export interface SeoAnalysis {
  readonly data: SeoCheckData;
  readonly findings: readonly MonitorFinding[];
}

export function analyzeSeo(input: SeoAnalysisInput): SeoAnalysis {
  const { html } = input;

  const title = innerText(html, 'title');
  const description = metaContent(html, 'description');
  const canonical = linkHref(html, 'canonical');
  const robotsMeta = metaContent(html, 'robots');
  const language = documentLanguage(html);

  const headings = countHeadings(html);
  const images = findTags(html, 'img');
  const imagesMissingAlt = images.filter((image) => {
    const alt = image.attributes.get('alt');
    /*
     * `alt=""` is correct for a decorative image and must not be counted as a
     * fault — that is what the attribute is for. Only a missing attribute, or
     * one containing nothing but whitespace, is a problem.
     */
    return alt === undefined || (alt.length > 0 && alt.trim().length === 0);
  }).length;

  const links = findTags(html, 'a');
  const internalLinkCount = countInternalLinks(links, input.finalUrl);

  const wordCount = extractText(html).split(/\s+/).filter(Boolean).length;
  const https = input.finalUrl.startsWith('https://');

  const openGraph = OPEN_GRAPH_REQUIRED.map((property) => metaContent(html, property));
  const openGraphComplete = openGraph.every((value) => value !== null && value.length > 0);

  const indexable = isIndexable(robotsMeta, input.robotsHeader);

  const checks: readonly Check[] = [
    /*
     * Indexability is weighted far above everything else, and deliberately so.
     * A `noindex` left on after a staging deploy removes the page from search
     * entirely — no title length or alt attribute matters next to that, and it
     * is the single most common catastrophic SEO mistake in the wild.
     */
    {
      code: 'seo.noindex',
      weight: 30,
      severity: 'critical',
      message: 'This page tells search engines not to index it.',
      detail: input.robotsHeader ?? robotsMeta,
      passed: indexable,
    },
    {
      code: 'seo.title_missing',
      weight: 12,
      severity: 'critical',
      message: 'The page has no title.',
      detail: null,
      passed: title !== null && title.length > 0,
    },
    {
      code: 'seo.title_length',
      weight: 5,
      severity: 'warning',
      message: `The title should be roughly ${String(TITLE_MIN)}–${String(TITLE_MAX)} characters.`,
      detail: title === null ? null : `${String(title.length)} characters`,
      passed: title === null || (title.length >= TITLE_MIN && title.length <= TITLE_MAX),
    },
    {
      code: 'seo.description_missing',
      weight: 10,
      severity: 'warning',
      message: 'The page has no meta description.',
      detail: null,
      passed: description !== null && description.length > 0,
    },
    {
      code: 'seo.description_length',
      weight: 4,
      severity: 'notice',
      message: `The description should be roughly ${String(DESCRIPTION_MIN)}–${String(DESCRIPTION_MAX)} characters.`,
      detail: description === null ? null : `${String(description.length)} characters`,
      passed:
        description === null ||
        (description.length >= DESCRIPTION_MIN && description.length <= DESCRIPTION_MAX),
    },
    {
      code: 'seo.canonical_missing',
      weight: 8,
      severity: 'warning',
      message: 'The page declares no canonical URL.',
      detail: null,
      passed: canonical !== null && canonical.length > 0,
    },
    {
      code: 'seo.h1_missing',
      weight: 8,
      severity: 'warning',
      message: 'The page has no level-one heading.',
      detail: null,
      passed: headings.h1 > 0,
    },
    {
      code: 'seo.h1_multiple',
      weight: 3,
      severity: 'notice',
      message: 'The page has more than one level-one heading.',
      detail: `${String(headings.h1)} found`,
      passed: headings.h1 <= 1,
    },
    {
      code: 'seo.https',
      weight: 10,
      severity: 'critical',
      message: 'The page is served over plain HTTP.',
      detail: input.finalUrl,
      passed: https,
    },
    {
      code: 'seo.images_missing_alt',
      weight: 6,
      severity: 'warning',
      message: 'Some images have no alt text.',
      detail:
        imagesMissingAlt > 0
          ? `${String(imagesMissingAlt)} of ${String(images.length)} images`
          : null,
      passed: imagesMissingAlt === 0,
    },
    {
      code: 'seo.open_graph_incomplete',
      weight: 4,
      severity: 'notice',
      message: 'Open Graph tags are incomplete, so shared links preview poorly.',
      detail: OPEN_GRAPH_REQUIRED.filter((_, index) => !openGraph[index]).join(', ') || null,
      passed: openGraphComplete,
    },
    {
      code: 'seo.robots_txt_missing',
      weight: 4,
      severity: 'notice',
      message: 'No robots.txt was found.',
      detail: null,
      passed: input.robotsTxtFound,
    },
    {
      code: 'seo.sitemap_missing',
      weight: 4,
      severity: 'notice',
      message: 'No sitemap was found.',
      detail: null,
      passed: input.sitemapFound,
    },
    {
      code: 'seo.language_missing',
      weight: 2,
      severity: 'notice',
      message: 'The page does not declare a language.',
      detail: null,
      passed: language !== null && language.length > 0,
    },
    {
      code: 'seo.thin_content',
      weight: 5,
      severity: 'notice',
      message: `The page has under ${String(THIN_CONTENT_WORDS)} words of text.`,
      detail: `${String(wordCount)} words`,
      passed: wordCount >= THIN_CONTENT_WORDS,
    },
    {
      code: 'seo.no_internal_links',
      weight: 3,
      severity: 'notice',
      message: 'The page links to no other page on this site.',
      detail: null,
      passed: internalLinkCount > 0,
    },
  ];

  const data: SeoCheckData = {
    score: scoreOf(checks),
    title,
    titleLength: title?.length ?? null,
    metaDescription: description,
    metaDescriptionLength: description?.length ?? null,
    canonical,
    robotsMeta: input.robotsHeader ?? robotsMeta,
    indexable,
    robotsTxtFound: input.robotsTxtFound,
    sitemapFound: input.sitemapFound,
    h1Count: headings.h1,
    imageCount: images.length,
    imagesMissingAlt,
    internalLinkCount,
    openGraphComplete,
    https,
    wordCount,
  };

  return {
    data,
    findings: checks
      .filter((check) => !check.passed)
      .map((check) => ({
        code: check.code,
        severity: check.severity,
        message: check.message,
        detail: check.detail,
      })),
  };
}

/**
 * The weighted share of checks that passed, 0–100.
 *
 * Floored, never rounded up, for the same reason uptime is: a page that scores
 * 69.6 should not be reported as 70 when the threshold is 70.
 */
function scoreOf(checks: readonly Check[]): number {
  const total = checks.reduce((sum, check) => sum + check.weight, 0);
  if (total === 0) return 100;

  const earned = checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0);
  return Math.floor((earned / total) * 100);
}

function countHeadings(html: string): { h1: number } {
  return { h1: findTags(html, 'h1').length };
}

/**
 * Whether a crawler is allowed to index this page.
 *
 * The `X-Robots-Tag` header wins over the meta tag when both are present,
 * because that is how crawlers treat it — and a `noindex` set at the CDN is
 * exactly the kind of thing nobody finds by reading the HTML.
 */
function isIndexable(robotsMeta: string | null, robotsHeader: string | null): boolean {
  const directives = `${robotsHeader ?? ''} ${robotsMeta ?? ''}`.toLowerCase();
  return !directives.includes('noindex') && !directives.includes('none');
}

function countInternalLinks(
  links: readonly { readonly attributes: ReadonlyMap<string, string> }[],
  finalUrl: string,
): number {
  let origin: string;
  try {
    origin = new URL(finalUrl).origin;
  } catch {
    return 0;
  }

  let count = 0;
  for (const link of links) {
    const href = link.attributes.get('href');
    if (href === undefined) continue;

    const trimmed = collapseWhitespace(href);
    // Fragments and non-navigational schemes are not links to another page.
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    if (/^(mailto|tel|javascript|data):/i.test(trimmed)) continue;

    try {
      if (new URL(trimmed, finalUrl).origin === origin) count += 1;
    } catch {
      // An unparseable href is not a link anyone can follow either.
    }
  }

  return count;
}
