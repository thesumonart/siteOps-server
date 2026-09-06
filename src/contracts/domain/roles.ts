/**
 * Organization roles, ordered from most to least privileged.
 *
 * Roles are deliberately coarse. Fine-grained access is expressed through
 * {@link Permission}, so new capabilities can be added without inventing new
 * roles or breaking stored member documents.
 */
export const ORGANIZATION_ROLES = ['owner', 'admin', 'member', 'client'] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  client: 'Client',
};

/**
 * Higher number wins. Used to stop a member escalating or demoting a peer.
 *
 * `client` sits below `member` deliberately. A client contact is an outsider
 * given a window into part of the organization; they must never be able to act
 * on anyone, and nothing they hold may be assigned by them to another person.
 */
const ROLE_RANK: Record<OrganizationRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
  client: 0,
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
 * Whether a role is one an agency's own team holds.
 *
 * The distinction the client portal turns on: an internal role sees the
 * organization, a client role sees one client's slice of it. Used to keep a
 * client out of every internal surface without listing them one by one.
 */
export function isInternalRole(role: OrganizationRole): boolean {
  return role !== 'client';
}

/**
 * Whether `actor` may grant `role` to someone.
 *
 * Capped at the actor's own rank, so nobody can mint an account more powerful
 * than themselves — the escalation path that matters.
 *
 * A client may grant nothing at all, including their own role. The rank
 * comparison alone would let `canAssignRole('client', 'client')` through, which
 * is unreachable today because a client holds no invite permission — but this
 * primitive is the thing a route would be checked against if one ever forgot,
 * so it refuses here rather than relying on that.
 */
export function canAssignRole(actor: OrganizationRole, role: OrganizationRole): boolean {
  if (!isInternalRole(actor)) return false;
  return ROLE_RANK[actor] >= ROLE_RANK[role];
}
