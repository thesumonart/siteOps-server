/**
 * Subscription plans and the limits enforced for each.
 *
 * Limits are enforced server-side only. Nothing about a plan may be trusted
 * from the client. Billing itself is not implemented yet; this module exists so
 * limit checks have a single home when a payment provider is introduced.
 */
export const PLANS = ['free', 'starter', 'agency', 'pro'] as const;

export type Plan = (typeof PLANS)[number];

export interface PlanLimits {
  readonly maxWebsites: number;
  readonly maxMembers: number;
  /** Fastest monitoring interval the plan may select, in seconds. */
  readonly minMonitoringIntervalSeconds: number;
  /** How long raw check documents are retained, in days. */
  readonly checkRetentionDays: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    maxWebsites: 3,
    maxMembers: 2,
    minMonitoringIntervalSeconds: 300,
    checkRetentionDays: 30,
  },
  starter: {
    maxWebsites: 10,
    maxMembers: 5,
    minMonitoringIntervalSeconds: 300,
    checkRetentionDays: 60,
  },
  agency: {
    maxWebsites: 50,
    maxMembers: 20,
    minMonitoringIntervalSeconds: 60,
    checkRetentionDays: 90,
  },
  pro: {
    maxWebsites: 200,
    maxMembers: 100,
    minMonitoringIntervalSeconds: 60,
    checkRetentionDays: 90,
  },
};

export const DEFAULT_PLAN: Plan = 'free';

export const PLAN_LABELS: Record<Plan, string> = {
  free: 'Free',
  starter: 'Starter',
  agency: 'Agency',
  pro: 'Pro',
};

export function limitsFor(plan: Plan): PlanLimits {
  return PLAN_LIMITS[plan];
}
