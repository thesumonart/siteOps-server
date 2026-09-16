import { describe, expect, it } from 'vitest';

import type { PublicStatusPageDto } from '../contracts/index.js';
import { PublicStatusCache } from './public-status-cache.js';

function page(title: string): PublicStatusPageDto {
  return {
    slug: 'acme',
    title,
    description: null,
    theme: { mode: 'auto', accentColor: null },
    status: 'operational',
    components: [],
    activeIncidents: [],
    historyDays: 90,
    showPoweredBy: true,
    generatedAt: '2026-09-16T00:00:00.000Z',
  };
}

describe('the public status cache', () => {
  it('serves a page until its TTL passes', () => {
    const cache = new PublicStatusCache(60_000);
    cache.rememberPage('slug:acme:90', 'page-1', page('Acme'), 1_000);

    expect(cache.page('slug:acme:90', 60_999)?.title).toBe('Acme');
    expect(cache.page('slug:acme:90', 61_000)).toBeUndefined();
  });

  it('forgets a page under every key it was reached by', () => {
    const cache = new PublicStatusCache(60_000);
    cache.rememberPage('slug:acme:90', 'page-1', page('Acme'), 0);
    cache.rememberPage('domain:page-1:30', 'page-1', page('Acme'), 0);
    cache.rememberPage('slug:other:90', 'page-2', page('Other'), 0);

    cache.forgetPage('page-1');

    expect(cache.page('slug:acme:90', 1)).toBeUndefined();
    expect(cache.page('domain:page-1:30', 1)).toBeUndefined();
    expect(cache.page('slug:other:90', 1)?.title).toBe('Other');
  });

  it('remembers that a host is not a custom domain, distinctly from not knowing', () => {
    const cache = new PublicStatusCache(60_000);
    expect(cache.host('unknown.example.com', 0)).toBeUndefined();

    cache.rememberHost('unknown.example.com', null, 0);
    expect(cache.host('unknown.example.com', 1)).toBeNull();

    cache.forgetHost('unknown.example.com');
    expect(cache.host('unknown.example.com', 1)).toBeUndefined();
  });

  it('caches nothing with a TTL of zero', () => {
    const cache = new PublicStatusCache(0);
    cache.rememberPage('slug:acme:90', 'page-1', page('Acme'), 5);
    cache.rememberHost('status.acme.com', 'page-1', 5);

    expect(cache.page('slug:acme:90', 5)).toBeUndefined();
    expect(cache.host('status.acme.com', 5)).toBeUndefined();
  });
});
