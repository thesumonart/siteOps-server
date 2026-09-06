import type { Types } from 'mongoose';

import type { OrganizationRole, Permission, Plan } from '../contracts/index.js';

/**
 * The caller's verified standing in one organization.
 *
 * Built by `requireOrganization` from the session, never from a request body or
 * header alone. Handlers scope their queries with `objectId`, and `role` is the
 * role stored server-side — not anything the client claimed.
 */
export interface OrganizationContext {
  readonly id: string;
  readonly objectId: Types.ObjectId;
  readonly name: string;
  readonly slug: string;
  readonly plan: Plan;
  readonly role: OrganizationRole;
  readonly permissions: readonly Permission[];
  /**
   * The second half of tenant scoping, set only for a `client` membership.
   *
   * `objectId` decides which organization's data is reachable; this narrows
   * that to one client's websites. It is resolved from the membership row the
   * middleware read from the database — never from a request — and every
   * repository that can return website-scoped data applies it.
   *
   * Null for an internal role, which means "the whole organization".
   */
  readonly clientScope: Types.ObjectId | null;
}

/** An actor together with the role they hold in the organization being acted on. */
export interface OrganizationActor {
  readonly id: string;
  readonly name: string;
  readonly role: OrganizationRole;
}
