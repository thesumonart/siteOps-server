/**
 * Subscription plans, the features they unlock and the limits they impose.
 *
 * This module is the single description of what a plan is worth. It is
 * platform-neutral so the dashboard can import it to explain an upsell, but
 * that is presentation only: every limit below is checked server-side by
 * `EntitlementService`, and nothing about a plan is ever read from the client.
 *
 * The four plan identifiers are a storage compatibility surface — they are
 * persisted on every organization document — so they are extended, never
 * renamed. `starter` is what the pricing page calls Professional.
 */
export const PLANS = ['free', 'starter', 'agency', 'pro'] as const;

export type Plan = (typeof PLANS)[number];

/**
 * Capabilities a plan may unlock.
 *
 * Named after the product surface rather than the implementation, so a feature
 * can be rebuilt without renaming the entitlement that gates it.
 */
export const PLAN_FEATURES = [
  'ssl_monitoring',
  'domain_monitoring',
  'performance_monitoring',
  'change_detection',
  'seo_monitoring',
  'broken_link_monitoring',
  'reports',
  'scheduled_reports',
  'clients',
  'client_portal',
  'white_label',
  'custom_domains',
  'slack_notifications',
  'discord_notifications',
  'webhooks',
  'status_pages',
  'api_access',
  'audit_logs',
  'anomaly_detection',
  'ai_insights',
] as const;

export type PlanFeature = (typeof PLAN_FEATURES)[number];

export const PLAN_FEATURE_LABELS: Record<PlanFeature, string> = {
  ssl_monitoring: 'SSL certificate monitoring',
  domain_monitoring: 'Domain expiry monitoring',
  performance_monitoring: 'Performance monitoring',
  change_detection: 'Website change detection',
  seo_monitoring: 'SEO health monitoring',
  broken_link_monitoring: 'Broken link scanning',
  reports: 'Reports',
  scheduled_reports: 'Scheduled reports',
  clients: 'Client management',
  client_portal: 'Client portal',
  white_label: 'White labelling',
  custom_domains: 'Custom domains',
  slack_notifications: 'Slack notifications',
  discord_notifications: 'Discord notifications',
  webhooks: 'Outgoing webhooks',
  status_pages: 'Public status pages',
  api_access: 'API access',
  audit_logs: 'Audit logs',
  anomaly_detection: 'Response-time anomaly detection',
  ai_insights: 'AI incident analysis and summaries',
};

export interface PlanLimits {
  readonly maxWebsites: number;
  readonly maxMembers: number;
  /** Fastest uptime-monitoring interval the plan may select, in seconds. */
  readonly minMonitoringIntervalSeconds: number;
  /**
   * Fastest interval for the heavier auxiliary monitors (SSL, SEO, crawls).
   * Separate from the uptime interval because these cost far more per run.
   */
  readonly minMonitorIntervalSeconds: number;
  /** How long raw check documents are retained, in days. */
  readonly checkRetentionDays: number;
  readonly maxClients: number;
  readonly maxStatusPages: number;
  readonly maxApiKeys: number;
  readonly maxIntegrations: number;
  readonly maxReportSchedules: number;
  readonly maxCustomDomains: number;
  /** Requests an organization's API keys may make per rolling day, in total. */
  readonly apiRequestsPerDay: number;
  /** Upper bound on pages one broken-link crawl may fetch. */
  readonly maxCrawlPages: number;
  /** AI generations (analyses plus summaries) allowed per calendar month. */
  readonly aiGenerationsPerMonth: number;
}

/**
 * Everything a plan grants.
 *
 * Features are listed per plan rather than inherited from the tier below.
 * Inheritance reads more cleanly right up until a plan has to *drop* something,
 * at which point it becomes a subtraction nobody can find.
 */
export interface PlanDefinition {
  readonly limits: PlanLimits;
  readonly features: readonly PlanFeature[];
}

const FREE_FEATURES: readonly PlanFeature[] = ['ssl_monitoring', 'domain_monitoring'];

const STARTER_FEATURES: readonly PlanFeature[] = [
  ...FREE_FEATURES,
  'performance_monitoring',
  'change_detection',
  'seo_monitoring',
  'broken_link_monitoring',
  'reports',
  'scheduled_reports',
  'slack_notifications',
  'discord_notifications',
  'webhooks',
  'status_pages',
  'audit_logs',
  'anomaly_detection',
];

const AGENCY_FEATURES: readonly PlanFeature[] = [
  ...STARTER_FEATURES,
  'clients',
  'client_portal',
  'white_label',
  'custom_domains',
  'api_access',
  'ai_insights',
];

const PRO_FEATURES: readonly PlanFeature[] = AGENCY_FEATURES;

export const PLAN_DEFINITIONS: Record<Plan, PlanDefinition> = {
  free: {
    limits: {
      maxWebsites: 3,
      maxMembers: 2,
      minMonitoringIntervalSeconds: 300,
      minMonitorIntervalSeconds: 86_400,
      checkRetentionDays: 30,
      maxClients: 0,
      maxStatusPages: 0,
      maxApiKeys: 0,
      maxIntegrations: 0,
      maxReportSchedules: 0,
      maxCustomDomains: 0,
      apiRequestsPerDay: 0,
      maxCrawlPages: 0,
      aiGenerationsPerMonth: 0,
    },
    features: FREE_FEATURES,
  },
  starter: {
    limits: {
      maxWebsites: 10,
      maxMembers: 5,
      minMonitoringIntervalSeconds: 300,
      minMonitorIntervalSeconds: 21_600,
      checkRetentionDays: 60,
      maxClients: 0,
      maxStatusPages: 1,
      maxApiKeys: 0,
      maxIntegrations: 3,
      maxReportSchedules: 2,
      maxCustomDomains: 0,
      apiRequestsPerDay: 0,
      maxCrawlPages: 50,
      aiGenerationsPerMonth: 0,
    },
    features: STARTER_FEATURES,
  },
  agency: {
    limits: {
      maxWebsites: 50,
      maxMembers: 20,
      minMonitoringIntervalSeconds: 60,
      minMonitorIntervalSeconds: 3_600,
      checkRetentionDays: 90,
      maxClients: 50,
      maxStatusPages: 10,
      maxApiKeys: 5,
      maxIntegrations: 20,
      maxReportSchedules: 20,
      maxCustomDomains: 5,
      apiRequestsPerDay: 20_000,
      maxCrawlPages: 250,
      aiGenerationsPerMonth: 100,
    },
    features: AGENCY_FEATURES,
  },
  pro: {
    limits: {
      maxWebsites: 200,
      maxMembers: 100,
      minMonitoringIntervalSeconds: 60,
      minMonitorIntervalSeconds: 3_600,
      checkRetentionDays: 90,
      maxClients: 200,
      maxStatusPages: 50,
      maxApiKeys: 20,
      maxIntegrations: 100,
      maxReportSchedules: 100,
      maxCustomDomains: 25,
      apiRequestsPerDay: 200_000,
      maxCrawlPages: 500,
      aiGenerationsPerMonth: 500,
    },
    features: PRO_FEATURES,
  },
};

/** Kept for the many call sites that only need the numbers. */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: PLAN_DEFINITIONS.free.limits,
  starter: PLAN_DEFINITIONS.starter.limits,
  agency: PLAN_DEFINITIONS.agency.limits,
  pro: PLAN_DEFINITIONS.pro.limits,
};

export const DEFAULT_PLAN: Plan = 'free';

export const PLAN_LABELS: Record<Plan, string> = {
  free: 'Free',
  starter: 'Professional',
  agency: 'Agency',
  pro: 'Pro',
};

/** Ordering for upgrade prompts and for naming the cheapest plan with a feature. */
const PLAN_RANK: Record<Plan, number> = { free: 0, starter: 1, agency: 2, pro: 3 };

export function limitsFor(plan: Plan): PlanLimits {
  return PLAN_DEFINITIONS[plan].limits;
}

export function featuresFor(plan: Plan): readonly PlanFeature[] {
  return PLAN_DEFINITIONS[plan].features;
}

export function planHasFeature(plan: Plan, feature: PlanFeature): boolean {
  return PLAN_DEFINITIONS[plan].features.includes(feature);
}

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && PLANS.includes(value as Plan);
}

export function planRank(plan: Plan): number {
  return PLAN_RANK[plan];
}

/**
 * The cheapest plan that includes `feature`, so an upgrade prompt can name the
 * right one rather than always pointing at the most expensive tier.
 *
 * Null only if no plan offers it, which would mean the feature is unreachable —
 * worth surfacing as an absence rather than papering over with a default.
 */
export function cheapestPlanWith(feature: PlanFeature): Plan | null {
  const candidates = PLANS.filter((plan) => planHasFeature(plan, feature));
  return candidates.sort((a, b) => PLAN_RANK[a] - PLAN_RANK[b])[0] ?? null;
}
