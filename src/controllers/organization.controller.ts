import type { Request, Response } from 'express';

import type { CreateOrganizationInput, UpdateOrganizationInput } from '../contracts/index.js';
import { currentUser } from '../middlewares/auth.middleware.js';
import { currentOrganization } from '../middlewares/organization.middleware.js';
import { validatedBody } from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { OrganizationService } from '../services/organization.service.js';

/**
 * Controllers are thin on purpose: read the validated input, call one service
 * method, choose a status. Every rule they appear to enforce is enforced again
 * in the service, which the worker can also call — anything that needed a
 * `Request` object to work would be unreachable from there.
 */
export class OrganizationController {
  constructor(private readonly organizations: OrganizationService) {}

  /**
   * Organizations the caller belongs to.
   *
   * Scoped by the session rather than by any parameter, so there is nothing to
   * tamper with.
   */
  list = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    ApiResponse.ok(response, await this.organizations.listForUser(user.id));
  };

  /** Creating an organization needs only a session — the caller becomes its owner. */
  create = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const input = validatedBody<CreateOrganizationInput>(request);

    const membership = await this.organizations.create(input, { id: user.id, name: user.name });
    ApiResponse.created(response, membership);
  };

  update = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    // The id comes from the guarded context, not the path parameter: the
    // middleware already proved membership for it.
    const organization = currentOrganization(request);
    const input = validatedBody<UpdateOrganizationInput>(request);

    const updated = await this.organizations.update(organization.id, input, {
      id: user.id,
      name: user.name,
    });
    ApiResponse.ok(response, updated);
  };
}
