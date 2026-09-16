import type { Request, Response } from 'express';

import type {
  CreateStatusPageInput,
  CustomDomainInput,
  UpdateStatusPageInput,
} from '../contracts/index.js';
import { currentActor, currentOrganization } from '../middlewares/organization.middleware.js';
import { validatedBody, validatedParams } from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { StatusPageService } from '../services/status-page.service.js';

interface StatusPageParams {
  readonly statusPageId: string;
}

/** Managing the organization's status pages and their custom domains. */
export class StatusPageController {
  constructor(private readonly statusPages: StatusPageService) {}

  list = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    ApiResponse.ok(response, { items: await this.statusPages.list(organization) });
  };

  get = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { statusPageId } = validatedParams<StatusPageParams>(request);
    ApiResponse.ok(response, await this.statusPages.get(organization, statusPageId));
  };

  create = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const input = validatedBody<CreateStatusPageInput>(request);

    ApiResponse.created(
      response,
      await this.statusPages.create(organization, input, currentActor(request)),
    );
  };

  update = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { statusPageId } = validatedParams<StatusPageParams>(request);
    const input = validatedBody<UpdateStatusPageInput>(request);

    ApiResponse.ok(
      response,
      await this.statusPages.update(organization, statusPageId, input, currentActor(request)),
    );
  };

  delete = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { statusPageId } = validatedParams<StatusPageParams>(request);

    await this.statusPages.delete(organization, statusPageId, currentActor(request));
    ApiResponse.noContent(response);
  };

  setCustomDomain = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { statusPageId } = validatedParams<StatusPageParams>(request);
    const input = validatedBody<CustomDomainInput>(request);

    ApiResponse.ok(
      response,
      await this.statusPages.setCustomDomain(
        organization,
        statusPageId,
        input,
        currentActor(request),
      ),
    );
  };

  verifyCustomDomain = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { statusPageId } = validatedParams<StatusPageParams>(request);

    ApiResponse.ok(
      response,
      await this.statusPages.verifyCustomDomain(organization, statusPageId, currentActor(request)),
    );
  };

  removeCustomDomain = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { statusPageId } = validatedParams<StatusPageParams>(request);

    ApiResponse.ok(
      response,
      await this.statusPages.removeCustomDomain(organization, statusPageId, currentActor(request)),
    );
  };
}
