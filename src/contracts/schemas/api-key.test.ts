import { describe, expect, it } from 'vitest';

import { API_KEY_SCOPE_PERMISSIONS, API_KEY_SCOPES } from '../domain/api-key.js';
import { PERMISSIONS } from '../domain/permissions.js';
import { createApiKeySchema } from './api-key.js';

describe('issuing an API key', () => {
  it('works until revoked unless an expiry is given', () => {
    const parsed = createApiKeySchema.parse({ name: 'Terraform', scopes: ['monitors:read'] });
    expect(parsed.expiresInDays).toBeUndefined();
  });

  it('collapses a repeated scope rather than refusing it', () => {
    const parsed = createApiKeySchema.parse({
      name: 'Terraform',
      scopes: ['monitors:read', 'monitors:read'],
    });
    expect(parsed.scopes).toEqual(['monitors:read']);
  });

  it.each([
    ['no scopes', { name: 'Empty', scopes: [] }],
    ['an unknown scope', { name: 'Admin', scopes: ['organization:delete'] }],
    ['an expiry of zero days', { name: 'Brief', scopes: ['monitors:read'], expiresInDays: 0 }],
    ['an expiry beyond a year', { name: 'Long', scopes: ['monitors:read'], expiresInDays: 366 }],
    ['no name', { name: '   ', scopes: ['monitors:read'] }],
  ])('refuses %s', (_label, input) => {
    expect(createApiKeySchema.safeParse(input).success).toBe(false);
  });
});

describe('what a scope stands for', () => {
  it('maps every scope onto real permissions', () => {
    for (const scope of API_KEY_SCOPES) {
      expect(API_KEY_SCOPE_PERMISSIONS[scope].length).toBeGreaterThan(0);
      for (const permission of API_KEY_SCOPE_PERMISSIONS[scope]) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });

  it('never lets a read scope stand for a write', () => {
    // A key issued for reading must not be able to change anything, whatever
    // the route table later adds.
    for (const scope of API_KEY_SCOPES.filter((candidate) => candidate.endsWith(':read'))) {
      for (const permission of API_KEY_SCOPE_PERMISSIONS[scope]) {
        expect(permission.endsWith(':read')).toBe(true);
      }
    }
  });
});
