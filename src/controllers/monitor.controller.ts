import type { Request, Response } from 'express';

import { currentUser } from '../middlewares/auth.middleware.js';
import { currentOrganization } from '../middlewares/organization.middleware.js';
import { validatedParams } from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { MonitorService } from '../services/monitor.service.js';
import type { WebsiteService } from '../services/website.service.js';

/**
 * Pausing and resuming monitoring for a website.
 *
 * `POST` rather than a `PATCH` on the website: the dashboard calls
 * `/websites/:id/pause` and `/websites/:id/resume`, and the two are commands
 * with side effects on the check schedule rather than a field edit. They also
 * carry `monitoring:toggle` instead of `website:update`, so a role can be given
 * one without the other.
 */
export class MonitorController {
  constructor(
    private readonly monitors: MonitorService,
    private readonly websites: WebsiteService,
  ) {}

  pause = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const { websiteId } = validatedParams<{ websiteId: string }>(request);

    const website = await this.monitors.disable(organization, websiteId, {
      id: user.id,
      name: user.name,
    });
    ApiResponse.ok(response, website);
  };

  resume = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const { websiteId } = validatedParams<{ websiteId: string }>(request);

    const website = await this.monitors.enable(organization, websiteId, {
      id: user.id,
      name: user.name,
    });
    ApiResponse.ok(response, website);
  };

  /** The monitor's current state, which is the website document's own view of it. */
  getStatus = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { websiteId } = validatedParams<{ websiteId: string }>(request);

    ApiResponse.ok(response, await this.websites.findById(organization, websiteId));
  };
}
