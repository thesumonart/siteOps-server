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
}

/** An actor together with the role they hold in the organization being acted on. */
export interface OrganizationActor {
  readonly id: string;
  readonly name: string;
  readonly role: OrganizationRole;
}
