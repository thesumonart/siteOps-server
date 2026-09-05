import { describe, expect, it } from 'vitest';

import { hasEveryPermission, hasPermission, permissionsFor, PERMISSIONS } from './permissions.js';
import { ORGANIZATION_ROLES, canActOn, canAssignRole, outranks, rankOf } from './roles.js';

describe('role hierarchy', () => {
  it('ranks owner above admin above member', () => {
    expect(rankOf('owner')).toBeGreaterThan(rankOf('admin'));
    expect(rankOf('admin')).toBeGreaterThan(rankOf('member'));
  });

  it('does not let a role outrank itself', () => {
    for (const role of ORGANIZATION_ROLES) {
      expect(outranks(role, role)).toBe(false);
    }
  });

  it('lets an owner act on an admin but not the reverse', () => {
    expect(outranks('owner', 'admin')).toBe(true);
    expect(outranks('admin', 'owner')).toBe(false);
  });
});

describe('member management rules', () => {
  it('lets a role manage peers, so two owners are not deadlocked', () => {
    // Requiring a strictly higher rank would make an organization with two
    // owners unmanageable: neither could ever remove or demote the other.
    expect(canActOn('owner', 'owner')).toBe(true);
    expect(canActOn('admin', 'admin')).toBe(true);
  });

  it('never lets anyone manage a superior', () => {
    expect(canActOn('admin', 'owner')).toBe(false);
    expect(canActOn('member', 'admin')).toBe(false);
    expect(canActOn('member', 'owner')).toBe(false);
  });

  it('caps an assignable role at the actor own rank', () => {
    expect(canAssignRole('owner', 'owner')).toBe(true);
    expect(canAssignRole('owner', 'member')).toBe(true);
    // The escalation that matters: an admin minting an owner.
    expect(canAssignRole('admin', 'owner')).toBe(false);
    expect(canAssignRole('member', 'admin')).toBe(false);
  });
});

describe('permission grants', () => {
  it('gives members read-only access to organization data', () => {
    expect(hasPermission('member', 'website:read')).toBe(true);
    expect(hasPermission('member', 'incident:read')).toBe(true);
    expect(hasPermission('member', 'website:create')).toBe(false);
    expect(hasPermission('member', 'website:delete')).toBe(false);
    expect(hasPermission('member', 'monitoring:toggle')).toBe(false);
  });

  it('lets admins manage websites and monitoring but not the organization itself', () => {
    expect(
      hasEveryPermission('admin', ['website:create', 'website:delete', 'monitoring:toggle']),
    ).toBe(true);
    expect(hasPermission('admin', 'organization:delete')).toBe(false);
    expect(hasPermission('admin', 'member:remove')).toBe(false);
    expect(hasPermission('admin', 'billing:manage')).toBe(false);
  });

  it('grants owners every permission', () => {
    expect(hasEveryPermission('owner', PERMISSIONS)).toBe(true);
  });

  it('keeps grants strictly nested: member ⊆ admin ⊆ owner', () => {
    const member = permissionsFor('member');
    const admin = permissionsFor('admin');
    const owner = permissionsFor('owner');

    expect(member.every((permission) => admin.includes(permission))).toBe(true);
    expect(admin.every((permission) => owner.includes(permission))).toBe(true);
  });

  it('never grants an unknown permission', () => {
    for (const role of ORGANIZATION_ROLES) {
      for (const permission of permissionsFor(role)) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });
});
