import express, { type Express } from 'express';
import helmet from 'helmet';

import { StripeProvider } from './billing/stripe-provider.js';
import type { BillingProvider } from './billing/billing-provider.js';
import { PriceCatalog } from './billing/price-catalog.js';
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
import { BillingEventRepository } from './repositories/billing-event.repository.js';
import { CheckResultRepository } from './repositories/check-result.repository.js';
import { ClientRepository } from './repositories/client.repository.js';
import { IncidentRepository } from './repositories/incident.repository.js';
import { MonitorRepository } from './repositories/monitor.repository.js';
import { ReportRepository } from './repositories/report.repository.js';
import { MembershipRepository } from './repositories/membership.repository.js';
import { NotificationRepository } from './repositories/notification.repository.js';
import { OrganizationRepository } from './repositories/organization.repository.js';
import { WebsiteRepository } from './repositories/website.repository.js';
import type { MonitoringRuntime } from './jobs/monitoring-runtime.js';
import { apiRoutes, type ApiDependencies } from './routes/index.js';
import { STRIPE_WEBHOOK_PATH } from './routes/billing.routes.js';
import { internalRoutes } from './routes/internal.routes.js';
import { AuditService } from './services/audit.service.js';
import { AuthService } from './services/auth.service.js';
import { BillingService } from './services/billing.service.js';
import { ClientService } from './services/client.service.js';
import { EntitlementService, type UsageCounters } from './services/entitlement.service.js';
import { IncidentService } from './services/incident.service.js';
import { MemberService } from './services/member.service.js';
import { MonitorConfigService } from './services/monitor-config.service.js';
import { MonitorService } from './services/monitor.service.js';
import { NotificationService } from './services/notification.service.js';
import { OrganizationService } from './services/organization.service.js';
import { BrandingService } from './services/branding.service.js';
import { ReportGenerationService } from './services/report-generation.service.js';
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
export interface CreateAppOptions {
  /**
   * The monitoring runtime, when this process hosts it.
   *
   * Passed in rather than constructed here because the API process must not
   * decide on its own to start doing monitoring work — `server.ts` reads
   * `MONITORING_RUNTIME` and owns the lifecycle, and `createApp` stays
   * constructible from a test with no loops attached.
   */
  readonly monitoringRuntime?: MonitoringRuntime | null;
}

export function createApp(options: CreateAppOptions = {}): Express {
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

  /*
   * JSON parsing for everything except the provider webhook.
   *
   * A monitoring payload is small; a generous limit only helps an attacker.
   *
   * The webhook is exempt because it must reach its handler as the exact bytes
   * Stripe signed. `express.json()` claims any `application/json` body, and it
   * is registered here — ahead of the router that mounts the webhook's own
   * `express.raw`. Body-parser marks a request as already read, so the raw
   * parser downstream skips silently and the controller receives a parsed
   * object it correctly refuses to verify. The symptom is a 500 on every event
   * from a deployment that is otherwise completely healthy, and since this
   * route is the only writer of `organization.plan`, no subscription would ever
   * apply: checkout succeeds, Stripe retries, nothing changes.
   */
  const jsonParser = express.json({ limit: '100kb' });
  app.use((request, response, next) => {
    if (request.path === STRIPE_WEBHOOK_PATH) {
      next();
      return;
    }
    jsonParser(request, response, next);
  });
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
  const reportRepository = new ReportRepository();
  const clientRepository = new ClientRepository();
  const billingEventRepository = new BillingEventRepository();

  const auditService = new AuditService(auditLogRepository);
  const entitlementService = new EntitlementService(
    buildUsageCounters({
      websites: websiteRepository,
      memberships: membershipRepository,
      reports: reportRepository,
      clients: clientRepository,
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
    // One existence query rather than a dependency on client management: the
    // website service only needs to know whether an id names a client of this
    // organization before it stores the assignment.
    (organizationId, clientId) => clientRepository.exists(organizationId, clientId),
  );
  const clientService = new ClientService(
    clientRepository,
    websiteRepository,
    membershipRepository,
    entitlementService,
    auditService,
    emailService,
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

  /*
   * Billing is constructed even when no provider is configured. The service
   * then refuses every write with `BILLING_NOT_CONFIGURED` and still serves the
   * plan catalogue and the organization's (free) subscription — which is what
   * lets the dashboard render an honest billing page on a deployment that
   * cannot take a payment, instead of a 404 or a fabricated checkout.
   */
  const priceCatalog = buildPriceCatalog();
  const billingService = new BillingService({
    provider: buildBillingProvider(priceCatalog),
    prices: priceCatalog,
    organizations: organizationRepository,
    events: billingEventRepository,
    audit: auditService,
    appUrl: env.APP_URL,
  });
  const brandingService = new BrandingService();
  const reportGenerationService = new ReportGenerationService(
    reportRepository,
    entitlementService,
    brandingService,
    auditService,
  );

  const dependencies: ApiDependencies = {
    organizations: organizationRepository,
    authService,
    auditService,
    billingService,
    clientService,
    entitlementService,
    organizationService,
    memberService,
    websiteService,
    monitorService,
    monitorConfigService,
    incidentService,
    reportService,
    reportGenerationService,
    notificationService,
  };

  app.use('/api', apiRoutes(dependencies));

  /*
   * Operator endpoints, behind their own bearer token rather than a session.
   * Mounted after the product API so nothing here can shadow a customer route,
   * and separately from `apiRoutes` because it is not part of the contract the
   * dashboard mirrors.
   */
  app.use('/api', internalRoutes({ monitoringRuntime: options.monitoringRuntime ?? null }));

  // Registered last so an unmatched path returns the documented envelope
  // instead of Express's default HTML error page.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Maps the configured Stripe price ids onto SiteOps plans.
 *
 * Kept beside the wiring rather than inside the catalogue so `PriceCatalog`
 * stays free of environment access — the ESLint rule that confines `process.env`
 * to `config/env.ts` is what makes that boundary real rather than a convention.
 */
function buildPriceCatalog(): PriceCatalog {
  return new PriceCatalog({
    starter_month: env.STRIPE_PRICE_STARTER_MONTHLY,
    starter_year: env.STRIPE_PRICE_STARTER_YEARLY,
    agency_month: env.STRIPE_PRICE_AGENCY_MONTHLY,
    agency_year: env.STRIPE_PRICE_AGENCY_YEARLY,
    pro_month: env.STRIPE_PRICE_PRO_MONTHLY,
    pro_year: env.STRIPE_PRICE_PRO_YEARLY,
  });
}

/**
 * The payment provider, or null when this deployment has no credentials.
 *
 * Null is a supported state, not a degraded one: SiteOps runs perfectly well as
 * a single-tenant or self-hosted install that never charges anyone, and the
 * whole product works on the free plan. What it must never do is pretend — so
 * there is no stub implementation here, only a provider or its absence.
 */
function buildBillingProvider(prices: PriceCatalog): BillingProvider | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

  // The environment schema already refuses a secret key without a webhook
  // secret; this narrows the types and keeps the invariant local.
  if (!secretKey || !webhookSecret) return null;

  return new StripeProvider({ secretKey, webhookSecret, prices });
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
  readonly reports: ReportRepository;
  readonly clients: ClientRepository;
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
    clients: (organizationId) => repositories.clients.countForOrganization(organizationId),
    statusPages: () => Promise.resolve(0),
    apiKeys: () => Promise.resolve(0),
    integrations: () => Promise.resolve(0),
    reportSchedules: (organizationId) =>
      repositories.reports.countSchedulesForOrganization(organizationId),
    customDomains: () => Promise.resolve(0),
    apiRequestsToday: () => Promise.resolve(0),
    aiGenerationsThisMonth: () => Promise.resolve(0),
  };
}

/** Exported so tests can build a request-authenticating middleware of their own. */
export { requireAuth };
