import express, { type Express } from 'express';
import helmet from 'helmet';

import { AUTH_BASE_PATH, createAuth } from './config/auth.js';
import { corsMiddleware } from './config/cors.js';
import { env, isProduction } from './config/env.js';
import { HealthController } from './controllers/health.controller.js';
import { EmailService } from './email/email.service.js';
import { errorHandler } from './errors/error-handler.js';
import { requireAuth } from './middlewares/auth.middleware.js';
import { authRateLimit, betterAuthHandler } from './middlewares/better-auth.middleware.js';
import { notFoundHandler } from './middlewares/not-found.middleware.js';
import { defaultRateLimit } from './middlewares/rate-limit.middleware.js';
import { requestId } from './middlewares/request-id.middleware.js';
import { AuditLogRepository } from './repositories/audit-log.repository.js';
import { CheckResultRepository } from './repositories/check-result.repository.js';
import { IncidentRepository } from './repositories/incident.repository.js';
import { MonitorRepository } from './repositories/monitor.repository.js';
import { MembershipRepository } from './repositories/membership.repository.js';
import { NotificationRepository } from './repositories/notification.repository.js';
import { OrganizationRepository } from './repositories/organization.repository.js';
import { WebsiteRepository } from './repositories/website.repository.js';
import { apiRoutes, type ApiDependencies } from './routes/index.js';
import { AuditService } from './services/audit.service.js';
import { AuthService } from './services/auth.service.js';
import { EntitlementService, type UsageCounters } from './services/entitlement.service.js';
import { IncidentService } from './services/incident.service.js';
import { MemberService } from './services/member.service.js';
import { MonitorConfigService } from './services/monitor-config.service.js';
import { MonitorService } from './services/monitor.service.js';
import { NotificationService } from './services/notification.service.js';
import { OrganizationService } from './services/organization.service.js';
import { ReportService } from './services/report.service.js';
import { WebsiteService } from './services/website.service.js';
import { asyncHandler } from './utils/async-handler.js';

/**
 * Builds the Express application.
 *
 * This is the composition root: every repository and service is constructed
 * here and passed down by hand. There is no container, and the dependency
 * graph is small enough that adding one would hide more than it explains — the
 * wiring below *is* the architecture diagram.
 *
 * Must be called after the database connection is open: Better Auth's adapter
 * needs a live driver handle.
 */
export function createApp(): Express {
  const app = express();

  if (env.TRUST_PROXY) {
    // Required for correct client IPs — and therefore correct rate limiting —
    // behind a platform load balancer. Enabling it without a proxy in front
    // would let any client choose its own address via X-Forwarded-For.
    app.set('trust proxy', 1);
  }

  // Express advertises itself by default. Nothing good comes of naming the
  // framework and its version to anyone who asks.
  app.disable('x-powered-by');

  app.use(requestId);

  app.use(
    helmet({
      // This API serves JSON only; a restrictive CSP costs nothing here and
      // hardens any error page a browser might render.
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  app.use(corsMiddleware());

  // Probes come before rate limiting and before the API prefix: a platform
  // health check must not be able to exhaust a budget, and must not be able to
  // fail because someone else did.
  const health = new HealthController();
  app.get('/health', health.liveness);
  app.get('/health/live', health.liveness);
  app.get('/health/ready', asyncHandler(health.readiness));
  // Kept for compatibility with the fullstack deployment's probe path.
  app.get('/ready', asyncHandler(health.readiness));

  /*
   * Order matters from here down.
   *
   * Better Auth is mounted before any body parser because its handler consumes
   * the raw request stream — a parser would leave every sign-in with an empty
   * body. Its own rate limiting runs first, since the router's limiter never
   * sees these routes. JSON parsing is registered afterwards, so every
   * controller below still receives a parsed body.
   */
  const emailService = new EmailService();
  const auth = createAuth(emailService);
  app.use(AUTH_BASE_PATH, authRateLimit(), betterAuthHandler(auth));

  // A monitoring payload is small; a generous limit only helps an attacker.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  app.use(defaultRateLimit());

  const organizationRepository = new OrganizationRepository();
  const membershipRepository = new MembershipRepository();
  const websiteRepository = new WebsiteRepository();
  const checkResultRepository = new CheckResultRepository();
  const incidentRepository = new IncidentRepository();
  const notificationRepository = new NotificationRepository();
  const auditLogRepository = new AuditLogRepository();
  const monitorRepository = new MonitorRepository();

  const auditService = new AuditService(auditLogRepository);
  const entitlementService = new EntitlementService(
    buildUsageCounters({
      websites: websiteRepository,
      memberships: membershipRepository,
    }),
  );
  const organizationService = new OrganizationService(organizationRepository, auditService);
  const authService = new AuthService(auth, organizationService);
  const memberService = new MemberService(
    membershipRepository,
    organizationService,
    auditService,
    emailService,
  );
  const websiteService = new WebsiteService(
    websiteRepository,
    checkResultRepository,
    incidentRepository,
    auditService,
  );
  const monitorService = new MonitorService(websiteRepository, websiteService, auditService);
  const monitorConfigService = new MonitorConfigService(
    monitorRepository,
    websiteService,
    entitlementService,
    auditService,
  );
  const incidentService = new IncidentService(incidentRepository, websiteRepository, auditService);
  const reportService = new ReportService(
    checkResultRepository,
    incidentRepository,
    websiteRepository,
  );
  const notificationService = new NotificationService(notificationRepository);

  const dependencies: ApiDependencies = {
    organizations: organizationRepository,
    authService,
    auditService,
    entitlementService,
    organizationService,
    memberService,
    websiteService,
    monitorService,
    monitorConfigService,
    incidentService,
    reportService,
    notificationService,
  };

  app.use('/api', apiRoutes(dependencies));

  // Registered last so an unmatched path returns the documented envelope
  // instead of Express's default HTML error page.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * The repositories the usage counters read from.
 *
 * Declared as an explicit shape rather than taking the whole dependency graph,
 * so adding a counter is visibly a decision about which repository it reads.
 */
interface UsageRepositories {
  readonly websites: WebsiteRepository;
  readonly memberships: MembershipRepository;
}

/**
 * Wires each plan limit to the query that measures it.
 *
 * Kept out of `EntitlementService` so that service stays free of repository
 * imports and can be unit-tested with counters that return fixed numbers.
 */
function buildUsageCounters(repositories: UsageRepositories): UsageCounters {
  return {
    websites: (organizationId) => repositories.websites.countForOrganization(organizationId),
    members: (organizationId) => repositories.memberships.countForOrganization(organizationId),
    clients: () => Promise.resolve(0),
    statusPages: () => Promise.resolve(0),
    apiKeys: () => Promise.resolve(0),
    integrations: () => Promise.resolve(0),
    reportSchedules: () => Promise.resolve(0),
    customDomains: () => Promise.resolve(0),
    apiRequestsToday: () => Promise.resolve(0),
    aiGenerationsThisMonth: () => Promise.resolve(0),
  };
}

/** Exported so tests can build a request-authenticating middleware of their own. */
export { requireAuth };
