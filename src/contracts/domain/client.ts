/**
 * Agency clients.
 *
 * A client is a group of websites plus the people allowed to see them. The
 * design decision worth stating is that **client portal access is an
 * organization membership**, not a parallel identity system:
 *
 *  - A client contact is a normal user with a normal password and a normal
 *    session. There is no second auth path, no magic-link table, no separate
 *    session store — and therefore no second place for a session bug to live.
 *  - Their membership carries the `client` role and a `clientId`. The role
 *    grants a small read-only permission set; the `clientId` narrows every
 *    tenant-scoped query further, to that client's websites only.
 *  - Revoking access is removing a membership, which is a thing the product
 *    already does correctly.
 *
 * The alternative — a bespoke `client_users` collection with its own tokens —
 * would mean two implementations of authentication, and the second one is
 * always the one with the hole in it.
 */
export const CLIENT_STATUSES = ['active', 'archived'] as const;

export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const CLIENT_STATUS_LABELS: Record<ClientStatus, string> = {
  active: 'Active',
  archived: 'Archived',
};

/**
 * Archiving rather than deleting.
 *
 * A client relationship ends but its websites, incidents and reports remain
 * meaningful — an agency asked "what was our uptime for them last year" long
 * after the contract finished. Archiving hides the client from the working list
 * and revokes portal access; deleting is a separate, explicit act.
 */
export function isClientActive(status: ClientStatus): boolean {
  return status === 'active';
}
