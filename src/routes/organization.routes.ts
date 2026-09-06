import { Router } from 'express';

import { MemberController } from '../controllers/member.controller.js';
import { OrganizationController } from '../controllers/organization.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { memberValidators, organizationValidators } from '../validators/index.js';
import { asyncHandler } from '../utils/async-handler.js';
import type { ApiDependencies } from './index.js';

/**
 * Organizations, membership and invitations.
 *
 * Every route states its own requirements on the line that declares it:
 * `requireAuth` for a session, `requireOrganization(...permissions)` for
 * membership and a capability. Reading the chain top to bottom is how you tell
 * what a route is protected by — there is no ambient default to remember.
 */
export function organizationRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const organizations = new OrganizationController(
    dependencies.organizationService,
    dependencies.entitlementService,
  );
  const members = new MemberController(dependencies.memberService);

  router.get('/organizations', auth, asyncHandler(organizations.list));

  // Creating an organization needs only a session — the caller becomes its
  // owner. Rate limited because it writes two documents and claims a slug.
  router.post(
    '/organizations',
    auth,
    rateLimit({ limit: 10, windowSeconds: 3600, scope: 'organization-create' }),
    validate(organizationValidators.create),
    asyncHandler(organizations.create),
  );

  router.patch(
    '/organizations/:organizationId',
    auth,
    validate(organizationValidators.update),
    requireOrganization(dependencies.organizations, 'organization:update'),
    asyncHandler(organizations.update),
  );

  /*
   * Plan entitlements and current usage. Only `organization:read`, which every
   * role holds: a member who cannot see why an action is unavailable is shown
   * a failure they cannot explain.
   */
  router.get(
    '/organizations/:organizationId/entitlements',
    auth,
    validate(organizationValidators.byId),
    requireOrganization(dependencies.organizations, 'organization:read'),
    asyncHandler(organizations.entitlements),
  );

  router.get(
    '/organizations/:organizationId/members',
    auth,
    validate(memberValidators.list),
    requireOrganization(dependencies.organizations, 'member:read'),
    asyncHandler(members.list),
  );

  // Sending an invitation sends an email, so it carries a tighter budget than
  // the general allowance — the limit protects the sending reputation of the
  // domain as much as it protects the organization.
  router.post(
    '/organizations/:organizationId/members',
    auth,
    rateLimit({ limit: 20, windowSeconds: 3600, scope: 'member-invite' }),
    validate(memberValidators.invite),
    requireOrganization(dependencies.organizations, 'member:invite'),
    asyncHandler(members.invite),
  );

  /*
   * Declared before `/:memberId` on purpose. Express matches in order, and
   * `invitations` would otherwise be captured as a member id — which then fails
   * the ObjectId validator and answers 400 instead of revoking anything.
   */
  router.delete(
    '/organizations/:organizationId/members/invitations/:invitationId',
    auth,
    validate(memberValidators.revokeInvitation),
    requireOrganization(dependencies.organizations, 'member:invite'),
    asyncHandler(members.revokeInvitation),
  );

  router.patch(
    '/organizations/:organizationId/members/:memberId',
    auth,
    validate(memberValidators.updateRole),
    requireOrganization(dependencies.organizations, 'member:update_role'),
    asyncHandler(members.updateRole),
  );

  router.delete(
    '/organizations/:organizationId/members/:memberId',
    auth,
    validate(memberValidators.remove),
    requireOrganization(dependencies.organizations, 'member:remove'),
    asyncHandler(members.remove),
  );

  /*
   * Accepting an invitation is deliberately outside the organization-scoped
   * routes: the caller is not a member yet, so `requireOrganization` would
   * reject them. Authorization comes from holding the emailed token and being
   * signed in as the address it was sent to.
   */
  router.post(
    '/invitations/accept',
    auth,
    rateLimit({ limit: 20, windowSeconds: 3600, scope: 'invitation-accept' }),
    validate(memberValidators.accept),
    asyncHandler(members.accept),
  );

  return router;
}
