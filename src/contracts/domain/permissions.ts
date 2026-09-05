import { type OrganizationRole } from './roles.js';

/**
 * Every capability the API authorizes against.
 *
 * Naming is `<resource>:<action>`. Adding a capability means adding it here and
 * granting it in {@link ROLE_PERMISSIONS} — controllers never test roles
 * directly, so permission changes stay in one place.
 */
export const PERMISSIONS = [
  'organization:read',
  'organization:update',
  'organization:delete',
  'member:read',
  'member:invite',
  'member:update_role',
  'member:remove',
  'website:read',
  'website:create',
  'website:update',
  'website:delete',
  'monitoring:read',
  'monitoring:toggle',
  'incident:read',
  'incident:update',
  'notification:read',
  'notification:update',
  'audit_log:read',
  'billing:read',
  'billing:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const MEMBER_PERMISSIONS: readonly Permission[] = [
  'organization:read',
  'member:read',
  'website:read',
  'monitoring:read',
  'incident:read',
  'notification:read',
  'notification:update',
];

const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...MEMBER_PERMISSIONS,
  'website:create',
  'website:update',
  'website:delete',
  'monitoring:toggle',
  'incident:update',
  'member:invite',
  'audit_log:read',
];

const OWNER_PERMISSIONS: readonly Permission[] = [
  ...ADMIN_PERMISSIONS,
  'organization:update',
  'organization:delete',
  'member:update_role',
  'member:remove',
  'billing:read',
  'billing:manage',
];

export const ROLE_PERMISSIONS: Record<OrganizationRole, readonly Permission[]> = {
  owner: OWNER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  member: MEMBER_PERMISSIONS,
};

export function hasPermission(role: OrganizationRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function hasEveryPermission(
  role: OrganizationRole,
  permissions: readonly Permission[],
): boolean {
  return permissions.every((permission) => hasPermission(role, permission));
}

export function permissionsFor(role: OrganizationRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}
