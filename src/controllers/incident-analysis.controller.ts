import type { Request, Response } from 'express';

import { currentUser } from '../middlewares/auth.middleware.js';
import { currentOrganization } from '../middlewares/organization.middleware.js';
import { validatedParams } from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { IncidentAnalysisService } from '../services/incident-analysis.service.js';

/** An incident's AI analysis, from the dashboard. */
export class IncidentAnalysisController {
  constructor(private readonly analyses: IncidentAnalysisService) {}

  get = async (request: Request, response: Response): Promise<void> => {
    const { incidentId } = validatedParams<{ incidentId: string }>(request);
    ApiResponse.ok(response, await this.analyses.get(currentOrganization(request), incidentId));
  };

  /** 202: the analysis is queued, not written. Poll `get` for the summary. */
  request = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const { incidentId } = validatedParams<{ incidentId: string }>(request);

    const analysis = await this.analyses.request(currentOrganization(request), incidentId, {
      id: user.id,
      name: user.name,
    });
    ApiResponse.accepted(response, analysis);
  };
}
