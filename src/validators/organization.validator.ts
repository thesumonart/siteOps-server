import {
  acceptInvitationSchema,
  createOrganizationSchema,
  inviteMemberSchema,
  updateMemberRoleSchema,
  updateOrganizationSchema,
} from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';
import {
  invitationParamsSchema,
  memberParamsSchema,
  organizationParamsSchema,
} from './common.validator.js';

export const organizationValidators = {
  create: { body: createOrganizationSchema } satisfies ValidationSchemas,
  byId: { params: organizationParamsSchema } satisfies ValidationSchemas,
  update: {
    params: organizationParamsSchema,
    body: updateOrganizationSchema,
  } satisfies ValidationSchemas,
} as const;

export const memberValidators = {
  list: { params: organizationParamsSchema } satisfies ValidationSchemas,
  invite: {
    params: organizationParamsSchema,
    body: inviteMemberSchema,
  } satisfies ValidationSchemas,
  updateRole: {
    params: memberParamsSchema,
    body: updateMemberRoleSchema,
  } satisfies ValidationSchemas,
  remove: { params: memberParamsSchema } satisfies ValidationSchemas,
  revokeInvitation: { params: invitationParamsSchema } satisfies ValidationSchemas,
  accept: { body: acceptInvitationSchema } satisfies ValidationSchemas,
} as const;
