import {
  BILLING_INTERVALS,
  PURCHASABLE_PLANS,
  planPriceKey,
  type BillingInterval,
  type Plan,
  type PlanPriceKey,
} from '../contracts/index.js';

/**
 * The map between SiteOps plans and provider price objects.
 *
 * This is the only place the two vocabularies meet, and it is the reason a
 * checkout request can name a plan without naming a price. It resolves in both
 * directions:
 *
 *  - **plan → price** when opening a checkout, so the amount charged is chosen
 *    by configuration rather than by the caller;
 *  - **price → plan** when a webhook arrives, so a subscription against a price
 *    we recognise sets the matching plan, and one against a price we do not is
 *    reported as unknown rather than guessed at.
 *
 * A deployment configures only the plans it sells. A plan with no price is not
 * purchasable there — the pricing page still describes it, and checkout refuses
 * it with a clear message, which is strictly better than a 500 from the
 * provider saying `No such price`.
 */
export class PriceCatalog {
  private readonly byKey = new Map<PlanPriceKey, string>();
  private readonly byPriceId = new Map<string, { plan: Plan; interval: BillingInterval }>();

  /**
   * @param prices Provider price ids, keyed `<plan>_<interval>`. Entries with
   *   no id are omitted rather than stored empty, so "configured" and "set to
   *   an empty string" cannot mean different things downstream.
   */
  constructor(prices: Partial<Record<PlanPriceKey, string | undefined>>) {
    for (const plan of PURCHASABLE_PLANS) {
      for (const interval of BILLING_INTERVALS) {
        const key = planPriceKey(plan, interval);
        const priceId = prices[key]?.trim();
        if (!priceId) continue;

        this.byKey.set(key, priceId);
        this.byPriceId.set(priceId, { plan, interval });
      }
    }
  }

  /** Provider price id for a plan and interval, or null if not sold here. */
  priceIdFor(plan: Plan, interval: BillingInterval): string | null {
    return this.byKey.get(planPriceKey(plan, interval)) ?? null;
  }

  /**
   * The plan a provider price belongs to.
   *
   * Null for an unrecognised price. The caller must not fall back to a default
   * plan: a subscription against an unknown price is a configuration problem,
   * and quietly resolving it to `free` would downgrade a paying customer while
   * resolving it to `pro` would give away the product.
   */
  planForPriceId(priceId: string): { plan: Plan; interval: BillingInterval } | null {
    return this.byPriceId.get(priceId) ?? null;
  }

  /** Plans this deployment can actually sell. Drives the pricing page's CTAs. */
  purchasablePlans(): readonly Plan[] {
    return PURCHASABLE_PLANS.filter((plan) =>
      BILLING_INTERVALS.some((interval) => this.byKey.has(planPriceKey(plan, interval))),
    );
  }

  get isEmpty(): boolean {
    return this.byKey.size === 0;
  }
}
