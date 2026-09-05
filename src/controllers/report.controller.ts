import type { Request, Response } from 'express';

import type { ListWebsiteChecksQuery, WebsiteStatsQuery } from '../contracts/index.js';
import { currentOrganization } from '../middlewares/organization.middleware.js';
import { validatedParams, validatedQuery } from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { ReportService } from '../services/report.service.js';

/**
 * Reads over what the worker has recorded: uptime, response times, the raw
 * check history and the organization overview.
 */
export class ReportController {
  constructor(private readonly reports: ReportService) {}

  websiteStats = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { websiteId } = validatedParams<{ websiteId: string }>(request);
    const { range } = validatedQuery<WebsiteStatsQuery>(request);

    ApiResponse.ok(response, await this.reports.websiteStats(organization, websiteId, range));
  };

  websiteUptime = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { websiteId } = validatedParams<{ websiteId: string }>(request);
    const { range } = validatedQuery<WebsiteStatsQuery>(request);

    ApiResponse.ok(response, await this.reports.websiteBuckets(organization, websiteId, range));
  };

  websiteChecks = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { websiteId } = validatedParams<{ websiteId: string }>(request);
    const query = validatedQuery<ListWebsiteChecksQuery>(request);

    ApiResponse.ok(response, await this.reports.websiteChecks(organization, websiteId, query));
  };

  dashboardStats = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    ApiResponse.ok(response, await this.reports.dashboardStats(organization));
  };
}
