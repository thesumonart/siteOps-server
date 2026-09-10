import type { Request, Response } from 'express';

import type {
  CreateChannelInput,
  ListChannelDeliveriesQuery,
  UpdateChannelInput,
} from '../contracts/index.js';
import { currentActor, currentOrganization } from '../middlewares/organization.middleware.js';
import {
  validatedBody,
  validatedParams,
  validatedQuery,
} from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { ChannelService } from '../services/channel.service.js';

/** Slack, Discord and webhook channels for the active organization. */
export class ChannelController {
  constructor(private readonly channels: ChannelService) {}

  list = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    ApiResponse.ok(response, { items: await this.channels.list(organization) });
  };

  getById = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { channelId } = validatedParams<{ channelId: string }>(request);

    ApiResponse.ok(response, await this.channels.findById(organization, channelId));
  };

  create = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const input = validatedBody<CreateChannelInput>(request);

    ApiResponse.created(
      response,
      await this.channels.create(organization, input, currentActor(request)),
    );
  };

  update = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { channelId } = validatedParams<{ channelId: string }>(request);
    const input = validatedBody<UpdateChannelInput>(request);

    ApiResponse.ok(
      response,
      await this.channels.update(organization, channelId, input, currentActor(request)),
    );
  };

  remove = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { channelId } = validatedParams<{ channelId: string }>(request);

    await this.channels.delete(organization, channelId, currentActor(request));
    ApiResponse.noContent(response);
  };

  test = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { channelId } = validatedParams<{ channelId: string }>(request);

    ApiResponse.ok(response, await this.channels.test(organization, channelId));
  };

  rotateSecret = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { channelId } = validatedParams<{ channelId: string }>(request);

    ApiResponse.ok(
      response,
      await this.channels.rotateSecret(organization, channelId, currentActor(request)),
    );
  };

  deliveries = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { channelId } = validatedParams<{ channelId: string }>(request);
    const query = validatedQuery<ListChannelDeliveriesQuery>(request);

    ApiResponse.ok(response, await this.channels.deliveries(organization, channelId, query));
  };
}
