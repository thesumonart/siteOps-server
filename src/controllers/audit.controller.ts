import type { Request, Response } from 'express';

import type { ListAuditLogsQuery } from '../contracts/index.js';
import { currentOrganization } from '../middlewares/organization.middleware.js';
import { validatedQuery } from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { AuditService } from '../services/audit.service.js';
import type { EntitlementService } from '../services/entitlement.service.js';

/**
 * The organization activity feed.
 *
 * Read-only by design: there is no route that edits or deletes an entry, on any
 * plan, at any role. An audit log an owner can rewrite is not an audit log.
 */
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
  ) {}

  list = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    this.entitlements.assertFeature(organization, 'audit_logs');
    const query = validatedQuery<ListAuditLogsQuery>(request);

    ApiResponse.ok(response, await this.audit.list(organization, query));
  };

  actors = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    this.entitlements.assertFeature(organization, 'audit_logs');

    ApiResponse.ok(response, { items: await this.audit.actors(organization) });
  };
}
