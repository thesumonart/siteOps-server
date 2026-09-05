import type { Request, Response } from 'express';

import type { ListIncidentsQuery } from '../contracts/index.js';
import { currentUser } from '../middlewares/auth.middleware.js';
import { currentOrganization } from '../middlewares/organization.middleware.js';
import { validatedParams, validatedQuery } from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { IncidentService } from '../services/incident.service.js';

export class IncidentController {
  constructor(private readonly incidents: IncidentService) {}

  list = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const query = validatedQuery<ListIncidentsQuery>(request);

    ApiResponse.ok(response, await this.incidents.findHistory(organization, query));
  };

  getById = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { incidentId } = validatedParams<{ incidentId: string }>(request);

    ApiResponse.ok(response, await this.incidents.findById(organization, incidentId));
  };

  resolve = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const { incidentId } = validatedParams<{ incidentId: string }>(request);

    const incident = await this.incidents.resolve(organization, incidentId, {
      id: user.id,
      name: user.name,
    });
    ApiResponse.ok(response, incident);
  };
}
