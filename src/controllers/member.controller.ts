import type { Request, Response } from 'express';

import type {
  AcceptInvitationInput,
  InviteMemberInput,
  UpdateMemberRoleInput,
} from '../contracts/index.js';
import { currentUser } from '../middlewares/auth.middleware.js';
import { currentActor, currentOrganization } from '../middlewares/organization.middleware.js';
import { validatedBody, validatedParams } from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { MemberService } from '../services/member.service.js';

export class MemberController {
  constructor(private readonly members: MemberService) {}

  list = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    ApiResponse.ok(response, await this.members.list(organization));
  };

  invite = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const input = validatedBody<InviteMemberInput>(request);

    const invitation = await this.members.invite(organization, input, currentActor(request));
    ApiResponse.created(response, invitation);
  };

  updateRole = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { memberId } = validatedParams<{ memberId: string }>(request);
    const { role } = validatedBody<UpdateMemberRoleInput>(request);

    const member = await this.members.updateRole(
      organization,
      memberId,
      role,
      currentActor(request),
    );
    ApiResponse.ok(response, member);
  };

  remove = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { memberId } = validatedParams<{ memberId: string }>(request);

    await this.members.remove(organization, memberId, currentActor(request));
    ApiResponse.noContent(response);
  };

  revokeInvitation = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { invitationId } = validatedParams<{ invitationId: string }>(request);

    await this.members.revokeInvitation(organization, invitationId, currentActor(request));
    ApiResponse.noContent(response);
  };

  /**
   * Accepting an invitation is deliberately outside the organization-scoped
   * routes: the caller is not a member yet, so `requireOrganization` would
   * reject them. Authorization comes from holding the emailed token *and* being
   * signed in as the address it was sent to.
   */
  accept = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const { token } = validatedBody<AcceptInvitationInput>(request);

    const result = await this.members.accept(token, {
      id: user.id,
      name: user.name,
      email: user.email,
    });
    ApiResponse.ok(response, result);
  };
}
