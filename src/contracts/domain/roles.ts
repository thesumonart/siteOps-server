/**
 * Organization roles, ordered from most to least privileged.
 *
 * Roles are deliberately coarse. Fine-grained access is expressed through
 * {@link Permission}, so new capabilities can be added without inventing new
 * roles or breaking stored member documents.
 */
export const ORGANIZATION_ROLES = ['owner', 'admin', 'member'] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

/** Higher number wins. Used to stop a member escalating or demoting a peer. */
const ROLE_RANK: Record<OrganizationRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return typeof value === 'string' && ORGANIZATION_ROLES.includes(value as OrganizationRole);
}

/** True when `actor` outranks `target`. Equal roles do not outrank each other. */
export function outranks(actor: OrganizationRole, target: OrganizationRole): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

export function rankOf(role: OrganizationRole): number {
  return ROLE_RANK[role];
}

/**
 * Whether `actor` may manage a member holding `target`.
 *
 * Peers are included on purpose. Requiring a strictly higher rank would mean
 * that as soon as an organization has two owners, neither could ever remove or
 * demote the other — the organization would be permanently stuck. Owners
 * managing owners is safe because the last-owner rule is enforced separately.
 */
export function canActOn(actor: OrganizationRole, target: OrganizationRole): boolean {
  return ROLE_RANK[actor] >= ROLE_RANK[target];
}

/**
 * Whether `actor` may grant `role` to someone.
 *
 * Capped at the actor's own rank, so nobody can mint an account more powerful
 * than themselves — the escalation path that matters.
 */
export function canAssignRole(actor: OrganizationRole, role: OrganizationRole): boolean {
  return ROLE_RANK[actor] >= ROLE_RANK[role];
}
