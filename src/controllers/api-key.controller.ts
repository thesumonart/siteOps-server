import type { Request, Response } from 'express';

import type { CreateApiKeyInput } from '../contracts/index.js';
import { currentActor, currentOrganization } from '../middlewares/organization.middleware.js';
import { validatedBody, validatedParams } from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { ApiKeyService } from '../services/api-key.service.js';

/** Issuing and revoking the organization's API keys, from the dashboard. */
export class ApiKeyController {
  constructor(private readonly apiKeys: ApiKeyService) {}

  list = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    ApiResponse.ok(response, { items: await this.apiKeys.list(organization) });
  };

  create = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const input = validatedBody<CreateApiKeyInput>(request);

    ApiResponse.created(
      response,
      await this.apiKeys.create(organization, input, currentActor(request)),
    );
  };

  rotate = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { apiKeyId } = validatedParams<{ apiKeyId: string }>(request);

    ApiResponse.ok(
      response,
      await this.apiKeys.rotate(organization, apiKeyId, currentActor(request)),
    );
  };

  revoke = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { apiKeyId } = validatedParams<{ apiKeyId: string }>(request);

    await this.apiKeys.revoke(organization, apiKeyId, currentActor(request));
    ApiResponse.noContent(response);
  };
}
