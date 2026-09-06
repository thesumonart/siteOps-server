import type { Request, Response } from 'express';

import type {
  ListMonitorResultsQuery,
  MonitorType,
  UpdateMonitorInput,
} from '../contracts/index.js';
import { currentUser } from '../middlewares/auth.middleware.js';
import { currentOrganization } from '../middlewares/organization.middleware.js';
import {
  validatedBody,
  validatedParams,
  validatedQuery,
} from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { MonitorConfigService } from '../services/monitor-config.service.js';

/** Configuring the auxiliary monitors and reading their results. */
export class MonitorConfigController {
  constructor(private readonly monitors: MonitorConfigService) {}

  list = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { websiteId } = validatedParams<{ websiteId: string }>(request);

    ApiResponse.ok(response, {
      items: await this.monitors.listForWebsite(organization, websiteId),
    });
  };

  update = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const { websiteId, type } = validatedParams<{ websiteId: string; type: MonitorType }>(request);
    const input = validatedBody<UpdateMonitorInput>(request);

    const monitor = await this.monitors.update(organization, websiteId, type, input, {
      id: user.id,
      name: user.name,
    });
    ApiResponse.ok(response, monitor);
  };

  /**
   * Schedules a run rather than performing one.
   *
   * The check itself happens on the worker: a Lighthouse run or a site crawl
   * inside a request handler would hold an HTTP connection open for minutes and
   * put the API's event loop under load meant for a background process.
   */
  runNow = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { websiteId, type } = validatedParams<{ websiteId: string; type: MonitorType }>(request);

    ApiResponse.ok(response, await this.monitors.runNow(organization, websiteId, type));
  };

  results = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { monitorId } = validatedParams<{ monitorId: string }>(request);
    const query = validatedQuery<ListMonitorResultsQuery>(request);

    ApiResponse.ok(response, await this.monitors.listResults(organization, monitorId, query));
  };

  summary = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);

    ApiResponse.ok(response, { items: await this.monitors.summary(organization) });
  };
}
