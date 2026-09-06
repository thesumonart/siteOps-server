import { Router } from 'express';

import type { OrganizationRepository } from '../repositories/organization.repository.js';
import type { AuditService } from '../services/audit.service.js';
import type { AuthService } from '../services/auth.service.js';
import type { BillingService } from '../services/billing.service.js';
import type { ClientService } from '../services/client.service.js';
import type { EntitlementService } from '../services/entitlement.service.js';
import type { IncidentService } from '../services/incident.service.js';
import type { MemberService } from '../services/member.service.js';
import type { MonitorConfigService } from '../services/monitor-config.service.js';
import type { MonitorService } from '../services/monitor.service.js';
import type { NotificationService } from '../services/notification.service.js';
import type { OrganizationService } from '../services/organization.service.js';
import type { ReportGenerationService } from '../services/report-generation.service.js';
import type { ReportService } from '../services/report.service.js';
import type { WebsiteService } from '../services/website.service.js';
import { auditRoutes } from './audit.routes.js';
import { authRoutes } from './auth.routes.js';
import { billingRoutes } from './billing.routes.js';
import { clientRoutes } from './client.routes.js';
import { incidentRoutes } from './incident.routes.js';
import { monitorRoutes } from './monitor.routes.js';
import { notificationRoutes } from './notification.routes.js';
import { organizationRoutes } from './organization.routes.js';
import { reportGenerationRoutes } from './report-generation.routes.js';
import { reportRoutes } from './report.routes.js';
import { websiteRoutes } from './website.routes.js';

/**
 * The API surface, mounted under `/api`.
 *
 * The prefix is `/api` rather than `/api/v1` because the dashboard addresses
 * `/api/...` directly — see `siteOps-client/src/lib`. Versioning would be a
 * breaking change to every screen for no present benefit; when a second version
 * is genuinely needed it can be added alongside this one.
 */
export interface ApiDependencies {
  readonly organizations: OrganizationRepository;
  readonly authService: AuthService;
  readonly auditService: AuditService;
  readonly billingService: BillingService;
  readonly clientService: ClientService;
  readonly entitlementService: EntitlementService;
  readonly organizationService: OrganizationService;
  readonly memberService: MemberService;
  readonly websiteService: WebsiteService;
  readonly monitorService: MonitorService;
  readonly monitorConfigService: MonitorConfigService;
  readonly incidentService: IncidentService;
  readonly reportService: ReportService;
  readonly reportGenerationService: ReportGenerationService;
  readonly notificationService: NotificationService;
}

export function apiRoutes(dependencies: ApiDependencies): Router {
  const router = Router();

  router.use(authRoutes(dependencies));
  router.use(organizationRoutes(dependencies));
  router.use(websiteRoutes(dependencies));
  router.use(monitorRoutes(dependencies));
  router.use(reportRoutes(dependencies));
  router.use(reportGenerationRoutes(dependencies));
  router.use(incidentRoutes(dependencies));
  router.use(notificationRoutes(dependencies));
  router.use(auditRoutes(dependencies));
  router.use(clientRoutes(dependencies));
  router.use(billingRoutes(dependencies));

  return router;
}
