import type { Request, Response } from 'express';

import type {
  CreateWebsiteInput,
  ListIncidentsQuery,
  ListWebsiteChecksQuery,
  ListWebsitesQuery,
  UpdateWebsiteInput,
  WebsiteStatsQuery,
} from '../contracts/index.js';
import { apiKeyActor } from '../middlewares/api-key.middleware.js';
import { currentOrganization } from '../middlewares/organization.middleware.js';
import {
  validatedBody,
  validatedParams,
  validatedQuery,
} from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { IncidentAnalysisService } from '../services/incident-analysis.service.js';
import type { IncidentService } from '../services/incident.service.js';
import type { MonitorService } from '../services/monitor.service.js';
import type { ReportService } from '../services/report.service.js';
import type { WebsiteService } from '../services/website.service.js';

/**
 * The public API: `/api/v1`.
 *
 * Every handler calls the same service the dashboard's route does, with the
 * organization the key belongs to. There is no second implementation of a
 * plan limit, a URL rule or an incident transition here, and so no way for an
 * integration to do something the dashboard would refuse.
 *
 * "Monitor" is the public name for what the codebase calls a website — the
 * uptime monitor on it — because that is the word an integration author looks
 * for. The DTOs are the dashboard's own.
 */
export class PublicApiController {
  constructor(
    private readonly websites: WebsiteService,
    private readonly monitors: MonitorService,
    private readonly incidents: IncidentService,
    private readonly reports: ReportService,
    private readonly analyses: IncidentAnalysisService,
  ) {}

  listMonitors = async (request: Request, response: Response): Promise<void> => {
    const query = validatedQuery<ListWebsitesQuery>(request);
    ApiResponse.ok(response, await this.websites.findAll(currentOrganization(request), query));
  };

  getMonitor = async (request: Request, response: Response): Promise<void> => {
    const { websiteId } = validatedParams<{ websiteId: string }>(request);
    ApiResponse.ok(response, await this.websites.findById(currentOrganization(request), websiteId));
  };

  createMonitor = async (request: Request, response: Response): Promise<void> => {
    const input = validatedBody<CreateWebsiteInput>(request);
    ApiResponse.created(
      response,
      await this.websites.create(currentOrganization(request), input, apiKeyActor(request)),
    );
  };

  updateMonitor = async (request: Request, response: Response): Promise<void> => {
    const { websiteId } = validatedParams<{ websiteId: string }>(request);
    const input = validatedBody<UpdateWebsiteInput>(request);
    ApiResponse.ok(
      response,
      await this.websites.update(
        currentOrganization(request),
        websiteId,
        input,
        apiKeyActor(request),
      ),
    );
  };

  deleteMonitor = async (request: Request, response: Response): Promise<void> => {
    const { websiteId } = validatedParams<{ websiteId: string }>(request);
    await this.websites.delete(currentOrganization(request), websiteId, apiKeyActor(request));
    ApiResponse.noContent(response);
  };

  pauseMonitor = async (request: Request, response: Response): Promise<void> => {
    const { websiteId } = validatedParams<{ websiteId: string }>(request);
    ApiResponse.ok(
      response,
      await this.monitors.disable(currentOrganization(request), websiteId, apiKeyActor(request)),
    );
  };

  resumeMonitor = async (request: Request, response: Response): Promise<void> => {
    const { websiteId } = validatedParams<{ websiteId: string }>(request);
    ApiResponse.ok(
      response,
      await this.monitors.enable(currentOrganization(request), websiteId, apiKeyActor(request)),
    );
  };

  listChecks = async (request: Request, response: Response): Promise<void> => {
    const { websiteId } = validatedParams<{ websiteId: string }>(request);
    const query = validatedQuery<ListWebsiteChecksQuery>(request);
    ApiResponse.ok(
      response,
      await this.reports.websiteChecks(currentOrganization(request), websiteId, query),
    );
  };

  monitorStats = async (request: Request, response: Response): Promise<void> => {
    const { websiteId } = validatedParams<{ websiteId: string }>(request);
    const { range } = validatedQuery<WebsiteStatsQuery>(request);
    ApiResponse.ok(
      response,
      await this.reports.websiteStats(currentOrganization(request), websiteId, range),
    );
  };

  monitorUptime = async (request: Request, response: Response): Promise<void> => {
    const { websiteId } = validatedParams<{ websiteId: string }>(request);
    const { range } = validatedQuery<WebsiteStatsQuery>(request);
    ApiResponse.ok(
      response,
      await this.reports.websiteBuckets(currentOrganization(request), websiteId, range),
    );
  };

  summary = async (request: Request, response: Response): Promise<void> => {
    ApiResponse.ok(response, await this.reports.dashboardStats(currentOrganization(request)));
  };

  listIncidents = async (request: Request, response: Response): Promise<void> => {
    const query = validatedQuery<ListIncidentsQuery>(request);
    ApiResponse.ok(response, await this.incidents.findHistory(currentOrganization(request), query));
  };

  getIncident = async (request: Request, response: Response): Promise<void> => {
    const { incidentId } = validatedParams<{ incidentId: string }>(request);
    ApiResponse.ok(
      response,
      await this.incidents.findById(currentOrganization(request), incidentId),
    );
  };

  getIncidentAnalysis = async (request: Request, response: Response): Promise<void> => {
    const { incidentId } = validatedParams<{ incidentId: string }>(request);
    ApiResponse.ok(response, await this.analyses.get(currentOrganization(request), incidentId));
  };

  resolveIncident = async (request: Request, response: Response): Promise<void> => {
    const { incidentId } = validatedParams<{ incidentId: string }>(request);
    ApiResponse.ok(
      response,
      await this.incidents.resolve(currentOrganization(request), incidentId, apiKeyActor(request)),
    );
  };
}
