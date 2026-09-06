import type { Types } from 'mongoose';

import type { EntitlementsDto, PlanFeature, PlanLimits, PlanUsageDto } from '../contracts/index.js';
import {
  PLAN_FEATURE_LABELS,
  PLAN_LABELS,
  cheapestPlanWith,
  featuresFor,
  limitsFor,
  planHasFeature,
} from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type { OrganizationContext } from '../types/common.types.js';

/** Counts one limited resource for one organization. */
export type UsageCounter = (organizationId: Types.ObjectId) => Promise<number>;

/**
 * How many of each limited resource an organization is using.
 *
 * Every counter is a function rather than a number so nothing is queried
 * unless the limit being checked actually needs it — asserting a website limit
 * must not cost nine extra round trips.
 *
 * Supplied by the composition root, which is the only place that knows every
 * repository. That keeps this service free of repository imports and lets the
 * counters be substituted wholesale in a unit test.
 */
export interface UsageCounters {
  readonly websites: UsageCounter;
  readonly members: UsageCounter;
  readonly clients: UsageCounter;
  readonly statusPages: UsageCounter;
  readonly apiKeys: UsageCounter;
  readonly integrations: UsageCounter;
  readonly reportSchedules: UsageCounter;
  readonly customDomains: UsageCounter;
  readonly apiRequestsToday: UsageCounter;
  readonly aiGenerationsThisMonth: UsageCounter;
}

/** The countable limits, and the counter that measures each. */
type CountableLimit = Extract<
  keyof PlanLimits,
  | 'maxWebsites'
  | 'maxMembers'
  | 'maxClients'
  | 'maxStatusPages'
  | 'maxApiKeys'
  | 'maxIntegrations'
  | 'maxReportSchedules'
  | 'maxCustomDomains'
  | 'apiRequestsPerDay'
  | 'aiGenerationsPerMonth'
>;

interface CountableDescriptor {
  readonly counter: keyof UsageCounters;
  /** Plural noun used in the refusal message: "monitors up to 3 websites". */
  readonly noun: string;
}

const COUNTABLE: Record<CountableLimit, CountableDescriptor> = {
  maxWebsites: { counter: 'websites', noun: 'websites' },
  maxMembers: { counter: 'members', noun: 'team members' },
  maxClients: { counter: 'clients', noun: 'clients' },
  maxStatusPages: { counter: 'statusPages', noun: 'status pages' },
  maxApiKeys: { counter: 'apiKeys', noun: 'API keys' },
  maxIntegrations: { counter: 'integrations', noun: 'integrations' },
  maxReportSchedules: { counter: 'reportSchedules', noun: 'scheduled reports' },
  maxCustomDomains: { counter: 'customDomains', noun: 'custom domains' },
  apiRequestsPerDay: { counter: 'apiRequestsToday', noun: 'API requests per day' },
  aiGenerationsPerMonth: { counter: 'aiGenerationsThisMonth', noun: 'AI generations per month' },
};

/**
 * The one place a plan decides whether something is allowed.
 *
 * Two rules hold everywhere in SiteOps, and this service exists so they hold in
 * exactly one implementation:
 *
 *  1. The plan comes from the organization document that `requireOrganization`
 *     loaded from the database. It is never read from a request body, a header,
 *     a token claim or anything else the caller controls.
 *  2. Hiding a button is not enforcement. Every gated route calls
 *     `assertFeature` or `assertWithinLimit` before it does any work, so an API
 *     client, a stale tab or a hand-rolled request is refused identically to
 *     the button that was never rendered.
 *
 * Refusals carry `PLAN_LIMIT_REACHED` and name the plan that would allow the
 * action, so the dashboard can offer the correct upgrade rather than a generic
 * one.
 */
export class EntitlementService {
  constructor(private readonly usage: UsageCounters) {}

  has(organization: OrganizationContext, feature: PlanFeature): boolean {
    return planHasFeature(organization.plan, feature);
  }

  /** Refuses unless the organization's plan includes `feature`. */
  assertFeature(organization: OrganizationContext, feature: PlanFeature): void {
    if (this.has(organization, feature)) return;

    const required = cheapestPlanWith(feature);
    const label = PLAN_FEATURE_LABELS[feature];

    throw ApiError.planLimit(
      required === null
        ? `${label} is not available.`
        : `${label} is available on the ${PLAN_LABELS[required]} plan. Upgrade to use it.`,
    );
  }

  /**
   * Refuses unless one more of `limit` would still be within the plan.
   *
   * The count is read at the moment of the check, so two concurrent creates can
   * in principle both pass at the boundary. That is accepted deliberately: the
   * alternative is a distributed lock on every create for a limit whose worst
   * case is one extra row, and the numbers are reconciled on the next read.
   * Where an off-by-one genuinely cannot be tolerated, a unique index is the
   * right tool and is used instead.
   */
  async assertWithinLimit(
    organization: OrganizationContext,
    limit: CountableLimit,
    options: { readonly additional?: number } = {},
  ): Promise<void> {
    const allowed = limitsFor(organization.plan)[limit];
    const descriptor = COUNTABLE[limit];
    const additional = options.additional ?? 1;

    if (allowed <= 0) {
      throw ApiError.planLimit(
        `The ${PLAN_LABELS[organization.plan]} plan does not include ${descriptor.noun}. Upgrade to add them.`,
      );
    }

    const current = await this.usage[descriptor.counter](organization.objectId);
    if (current + additional > allowed) {
      throw ApiError.planLimit(
        `The ${PLAN_LABELS[organization.plan]} plan allows up to ${String(allowed)} ${descriptor.noun}. Upgrade to add more.`,
      );
    }
  }

  /** The numeric value of one limit, for callers that clamp rather than refuse. */
  limit<TKey extends keyof PlanLimits>(
    organization: OrganizationContext,
    key: TKey,
  ): PlanLimits[TKey] {
    return limitsFor(organization.plan)[key];
  }

  /**
   * Everything the dashboard needs to explain the current plan.
   *
   * All ten counters are read here, which is the one place that cost is
   * justified: this backs a settings screen the user opened on purpose, not a
   * check on a hot path.
   */
  async describe(organization: OrganizationContext): Promise<EntitlementsDto> {
    const [
      websites,
      members,
      clients,
      statusPages,
      apiKeys,
      integrations,
      reportSchedules,
      customDomains,
      apiRequestsToday,
      aiGenerationsThisMonth,
    ] = await Promise.all([
      this.usage.websites(organization.objectId),
      this.usage.members(organization.objectId),
      this.usage.clients(organization.objectId),
      this.usage.statusPages(organization.objectId),
      this.usage.apiKeys(organization.objectId),
      this.usage.integrations(organization.objectId),
      this.usage.reportSchedules(organization.objectId),
      this.usage.customDomains(organization.objectId),
      this.usage.apiRequestsToday(organization.objectId),
      this.usage.aiGenerationsThisMonth(organization.objectId),
    ]);

    const usage: PlanUsageDto = {
      websites,
      members,
      clients,
      statusPages,
      apiKeys,
      integrations,
      reportSchedules,
      customDomains,
      apiRequestsToday,
      aiGenerationsThisMonth,
    };

    return {
      plan: organization.plan,
      features: featuresFor(organization.plan),
      limits: limitsFor(organization.plan),
      usage,
    };
  }
}
