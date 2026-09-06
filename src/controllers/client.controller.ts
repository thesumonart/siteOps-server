import type { Request, Response } from 'express';

import type {
  CreateClientInput,
  InviteClientContactInput,
  ListClientsQuery,
  UpdateClientInput,
} from '../contracts/index.js';
import { currentActor, currentOrganization } from '../middlewares/organization.middleware.js';
import {
  validatedBody,
  validatedParams,
  validatedQuery,
} from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { ClientService } from '../services/client.service.js';

/** Agency client management and portal access. */
export class ClientController {
  constructor(private readonly clients: ClientService) {}

  list = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const query = validatedQuery<ListClientsQuery>(request);

    ApiResponse.ok(response, { items: await this.clients.list(organization, query) });
  };

  getById = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { clientId } = validatedParams<{ clientId: string }>(request);

    ApiResponse.ok(response, await this.clients.findById(organization, clientId));
  };

  create = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const input = validatedBody<CreateClientInput>(request);

    ApiResponse.created(
      response,
      await this.clients.create(organization, input, currentActor(request)),
    );
  };

  update = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { clientId } = validatedParams<{ clientId: string }>(request);
    const input = validatedBody<UpdateClientInput>(request);

    ApiResponse.ok(
      response,
      await this.clients.update(organization, clientId, input, currentActor(request)),
    );
  };

  remove = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { clientId } = validatedParams<{ clientId: string }>(request);

    await this.clients.delete(organization, clientId, currentActor(request));
    ApiResponse.noContent(response);
  };

  listContacts = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { clientId } = validatedParams<{ clientId: string }>(request);

    ApiResponse.ok(response, { items: await this.clients.listContacts(organization, clientId) });
  };

  inviteContact = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { clientId } = validatedParams<{ clientId: string }>(request);
    const input = validatedBody<InviteClientContactInput>(request);

    ApiResponse.created(
      response,
      await this.clients.inviteContact(organization, clientId, input, currentActor(request)),
    );
  };

  revokeContact = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { clientId, contactId } = validatedParams<{ clientId: string; contactId: string }>(
      request,
    );

    await this.clients.revokeContact(organization, clientId, contactId, currentActor(request));
    ApiResponse.noContent(response);
  };
}
