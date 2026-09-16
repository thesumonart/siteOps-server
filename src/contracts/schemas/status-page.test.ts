import { describe, expect, it } from 'vitest';

import { overallPublicStatus, publicStatusOf } from '../domain/status-page.js';
import {
  createStatusPageSchema,
  customDomainSchema,
  publicStatusPageQuerySchema,
  updateStatusPageSchema,
} from './status-page.js';

const WEBSITE_A = '64b7f0c2a1b2c3d4e5f60718';
const WEBSITE_B = '64b7f0c2a1b2c3d4e5f60719';

describe('creating a status page', () => {
  it('starts unpublished, with the automatic theme and no components', () => {
    const parsed = createStatusPageSchema.parse({ title: 'Acme status', slug: 'acme' });
    expect(parsed).toMatchObject({
      published: false,
      components: [],
      theme: { mode: 'auto', accentColor: null },
    });
  });

  it('normalises the slug to lowercase', () => {
    const parsed = createStatusPageSchema.parse({ title: 'Acme', slug: '  Acme-Status ' });
    expect(parsed.slug).toBe('acme-status');
  });

  it.each([
    ['a slug that is too short', { title: 'Acme', slug: 'ac' }],
    ['a slug with a leading hyphen', { title: 'Acme', slug: '-acme' }],
    ['a slug with a double hyphen', { title: 'Acme', slug: 'acme--status' }],
    ['a slug with a path', { title: 'Acme', slug: 'acme/status' }],
    [
      'the same website twice',
      {
        title: 'Acme',
        slug: 'acme',
        components: [
          { websiteId: WEBSITE_A, displayName: 'Website' },
          { websiteId: WEBSITE_A, displayName: 'Website again' },
        ],
      },
    ],
    [
      'an accent colour that is not six hex digits',
      { title: 'Acme', slug: 'acme', theme: { mode: 'dark', accentColor: 'red;}' } },
    ],
    ['an unknown theme', { title: 'Acme', slug: 'acme', theme: { mode: 'neon' } }],
  ])('refuses %s', (_label, input) => {
    expect(createStatusPageSchema.safeParse(input).success).toBe(false);
  });

  it('accepts several distinct websites', () => {
    const parsed = createStatusPageSchema.parse({
      title: 'Acme',
      slug: 'acme',
      components: [
        { websiteId: WEBSITE_A, displayName: 'Website' },
        { websiteId: WEBSITE_B, displayName: 'Checkout' },
      ],
    });
    expect(parsed.components).toHaveLength(2);
  });

  it('leaves every field optional on update', () => {
    expect(updateStatusPageSchema.parse({})).toEqual({});
  });
});

describe('a custom domain', () => {
  it('is normalised: trimmed, lowercased and without a root dot', () => {
    expect(customDomainSchema.parse({ domain: ' Status.Acme.com. ' }).domain).toBe(
      'status.acme.com',
    );
  });

  it.each([
    ['a URL', 'https://status.acme.com'],
    ['a path', 'status.acme.com/page'],
    ['a port', 'status.acme.com:8080'],
    ['an IP address', '203.0.113.10'],
    ['a single label', 'intranet'],
    ['localhost', 'localhost'],
    ['an internal suffix', 'status.corp.internal'],
    ['a wildcard', '*.acme.com'],
  ])('refuses %s', (_label, domain) => {
    expect(customDomainSchema.safeParse({ domain }).success).toBe(false);
  });
});

describe('the public history window', () => {
  it('defaults to ninety days', () => {
    expect(publicStatusPageQuerySchema.parse({}).days).toBe(90);
  });

  it('accepts 30, 60 and 90 from a query string', () => {
    expect(publicStatusPageQuerySchema.parse({ days: '30' }).days).toBe(30);
    expect(publicStatusPageQuerySchema.parse({ days: '60' }).days).toBe(60);
  });

  it.each(['45', '0', '365', 'all'])('refuses %s', (days) => {
    expect(publicStatusPageQuerySchema.safeParse({ days }).success).toBe(false);
  });
});

describe('what a visitor is told', () => {
  it('never says a website is paused', () => {
    expect(publicStatusOf('paused')).toBe('unknown');
    expect(publicStatusOf('unknown')).toBe('unknown');
  });

  it('headlines the worst component', () => {
    expect(overallPublicStatus(['operational', 'degraded', 'operational'])).toBe('degraded');
    expect(overallPublicStatus(['degraded', 'down'])).toBe('down');
  });

  it('does not let one unmeasured component grey out a working page', () => {
    expect(overallPublicStatus(['operational', 'unknown'])).toBe('operational');
  });

  it('does not claim an empty page is operational', () => {
    expect(overallPublicStatus([])).toBe('unknown');
  });
});
