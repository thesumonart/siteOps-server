import type { Types } from 'mongoose';

import { planHasFeature, type Plan, type PlanFeature } from '../contracts/index.js';
import { OrganizationModel } from '../models/index.js';

/**
 * What plan an organization is on, as the worker sees it.
 *
 * The API reads the plan from the organization document `requireOrganization`
 * already loaded. The worker has no request, only an organization id on the
 * thing it is processing, and anomaly detection needs to know on every check —
 * so without this, gating a paid feature would add a query to the hottest path
 * in the product.
 *
 * Cached for a short time per organization. The consequence is bounded and
 * stated: a plan change reaches the worker within one TTL. An upgrade starts
 * detecting a minute late; a downgrade stops a minute late. Neither charges
 * anyone or grants anything the API itself would not.
 */
export class PlanLookup {
  private readonly cache = new Map<
    string,
    { readonly plan: Plan | null; readonly expiresAt: number }
  >();

  constructor(private readonly ttlMs: number) {}

  /** Null when the organization no longer exists. */
  async planOf(organizationId: Types.ObjectId, now: number = Date.now()): Promise<Plan | null> {
    const key = organizationId.toHexString();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.plan;

    const organization = await OrganizationModel.findById(organizationId)
      .select({ plan: 1 })
      .lean<{ plan: Plan }>()
      .exec();

    const plan = organization?.plan ?? null;
    this.cache.set(key, { plan, expiresAt: now + this.ttlMs });
    return plan;
  }

  async hasFeature(organizationId: Types.ObjectId, feature: PlanFeature): Promise<boolean> {
    const plan = await this.planOf(organizationId);
    return plan !== null && planHasFeature(plan, feature);
  }
}
