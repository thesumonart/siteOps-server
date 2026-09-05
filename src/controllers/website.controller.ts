import type { Request, Response } from 'express';

import type {
  CreateWebsiteInput,
  ListWebsitesQuery,
  UpdateWebsiteInput,
} from '../contracts/index.js';
import { currentUser } from '../middlewares/auth.middleware.js';
import { currentOrganization } from '../middlewares/organization.middleware.js';
import {
  validatedBody,
  validatedParams,
  validatedQuery,
} from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { WebsiteService } from '../services/website.service.js';

export class WebsiteController {
  constructor(private readonly websites: WebsiteService) {}

  list = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const query = validatedQuery<ListWebsitesQuery>(request);

    // Already an `{ items, pagination }` shape from the service, so it is
    // returned whole rather than re-wrapped.
    ApiResponse.ok(response, await this.websites.findAll(organization, query));
  };

  getById = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { websiteId } = validatedParams<{ websiteId: string }>(request);

    ApiResponse.ok(response, await this.websites.findById(organization, websiteId));
  };

  create = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const input = validatedBody<CreateWebsiteInput>(request);

    const website = await this.websites.create(organization, input, {
      id: user.id,
      name: user.name,
    });
    ApiResponse.created(response, website);
  };

  update = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const { websiteId } = validatedParams<{ websiteId: string }>(request);
    const input = validatedBody<UpdateWebsiteInput>(request);

    const website = await this.websites.update(organization, websiteId, input, {
      id: user.id,
      name: user.name,
    });
    ApiResponse.ok(response, website);
  };

  remove = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const { websiteId } = validatedParams<{ websiteId: string }>(request);

    await this.websites.delete(organization, websiteId, { id: user.id, name: user.name });
    ApiResponse.noContent(response);
  };
}
