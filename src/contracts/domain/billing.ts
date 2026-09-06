/**
 * Subscription lifecycle vocabulary, and the public price catalogue.
 *
 * Two different kinds of truth live here, and the distinction matters:
 *
 *  - **What a plan costs** ({@link PLAN_PRICING}) is *display* information. It
 *    is public, it is rendered on the marketing page before anyone signs in,
 *    and it is deliberately platform-neutral. It is never what a customer is
 *    charged: the amount comes from the price object at the payment provider,
 *    selected server-side by {@link PlanPriceKey}. If the two ever disagree the
 *    provider wins, the customer is charged correctly, and the marketing page
 *    is wrong — which is a content bug, not a billing bug.
 *
 *  - **What state a subscription is in** ({@link SUBSCRIPTION_STATUSES}) is
 *    provider-owned truth mirrored onto the organization by webhook. Nothing in
 *    SiteOps sets it from a user action.
 *
 * Neither is ever read from the client. `EntitlementService` continues to be
 * the only thing that decides what a plan may do, and it reads the plan from
 * the organization document.
 */
import type { Plan } from './plan.js';

/**
 * How often a subscription renews.
 *
 * Only two, because a third interval multiplies the price catalogue and the
 * provider configuration without answering a question any customer has asked.
 */
export const BILLING_INTERVALS = ['month', 'year'] as const;

export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const BILLING_INTERVAL_LABELS: Record<BillingInterval, string> = {
  month: 'Monthly',
  year: 'Yearly',
};

/**
 * Subscription states SiteOps recognises.
 *
 * These mirror Stripe's vocabulary because inventing a parallel one would mean
 * a translation table that has to be right on every webhook. `none` is the
 * local addition: an organization that has never subscribed has no provider
 * subscription at all, which is different from having one that ended.
 */
export const SUBSCRIPTION_STATUSES = [
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
  'paused',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  none: 'No subscription',
  trialing: 'Trialing',
  active: 'Active',
  past_due: 'Past due',
  canceled: 'Canceled',
  incomplete: 'Incomplete',
  incomplete_expired: 'Expired',
  unpaid: 'Unpaid',
  paused: 'Paused',
};

/**
 * Statuses under which the paid plan's entitlements still apply.
 *
 * `past_due` is included on purpose: a failed renewal starts a dunning window
 * during which the provider retries the card. Cutting a paying customer off at
 * the first decline — often an expired card they will replace within the day —
 * turns a payment hiccup into an outage in their monitoring. The provider
 * eventually moves the subscription to `unpaid` or `canceled`, and *that* is
 * when access ends.
 */
export const ENTITLED_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
];

export function isEntitledStatus(status: SubscriptionStatus): boolean {
  return ENTITLED_SUBSCRIPTION_STATUSES.includes(status);
}

/**
 * Plans a customer can actually buy.
 *
 * `free` is every organization's starting point and is not purchasable — there
 * is nothing to check out. Excluding it here is what stops a checkout session
 * ever being opened for a zero-price plan.
 *
 * Written as a literal tuple rather than a filter over {@link PLANS} so it can
 * be a Zod enum directly. `billing.test.ts` asserts it stays in step with
 * `PLANS`, which is what catches a fifth plan that nobody added here.
 */
export const PURCHASABLE_PLANS = ['starter', 'agency', 'pro'] as const;

export type PurchasablePlan = (typeof PURCHASABLE_PLANS)[number];

export function isPurchasablePlan(plan: Plan): plan is PurchasablePlan {
  return (PURCHASABLE_PLANS as readonly Plan[]).includes(plan);
}

/**
 * The identifier for one (plan, interval) pair.
 *
 * Used as the key of the provider price map, so a misconfigured deployment
 * fails by naming exactly which price is missing rather than by charging the
 * wrong amount.
 */
export type PlanPriceKey = `${Plan}_${BillingInterval}`;

export function planPriceKey(plan: Plan, interval: BillingInterval): PlanPriceKey {
  return `${plan}_${interval}`;
}

/** What one plan costs, in the smallest unit of {@link PlanPricing.currency}. */
export interface PlanPricing {
  /** ISO 4217, lowercase, to match what the provider reports back. */
  readonly currency: string;
  /** Monthly price in minor units. 0 for the free plan. */
  readonly monthly: number;
  /**
   * Yearly price in minor units.
   *
   * Ten times the monthly rate across the paid tiers — two months free — which
   * is the discount the marketing copy claims. {@link yearlyMonthsFree} derives
   * that claim from these numbers rather than hard-coding it in a sentence that
   * can drift away from the arithmetic.
   */
  readonly yearly: number;
}

/**
 * Public price list.
 *
 * Amounts are in minor units (cents) so no display rounding can turn into a
 * charge, and no float ever touches a price.
 */
export const PLAN_PRICING: Record<Plan, PlanPricing> = {
  free: { currency: 'usd', monthly: 0, yearly: 0 },
  starter: { currency: 'usd', monthly: 1_900, yearly: 19_000 },
  agency: { currency: 'usd', monthly: 7_900, yearly: 79_000 },
  pro: { currency: 'usd', monthly: 19_900, yearly: 199_000 },
};

export function priceFor(plan: Plan, interval: BillingInterval): number {
  const pricing = PLAN_PRICING[plan];
  return interval === 'month' ? pricing.monthly : pricing.yearly;
}

/**
 * How many months a year of this plan saves, rounded down.
 *
 * Derived rather than written down, so the "2 months free" badge cannot outlive
 * a change to the yearly price.
 */
export function yearlyMonthsFree(plan: Plan): number {
  const { monthly, yearly } = PLAN_PRICING[plan];
  if (monthly <= 0) return 0;
  return Math.max(0, Math.floor((monthly * 12 - yearly) / monthly));
}

/**
 * One-line positioning for each plan.
 *
 * Kept beside the price rather than in the marketing page so the dashboard's
 * upgrade prompts and the public pricing table describe a plan identically.
 */
export const PLAN_TAGLINES: Record<Plan, string> = {
  free: 'Keep an eye on a handful of sites.',
  starter: 'Full monitoring for a growing portfolio.',
  agency: 'Client portals and white labelling for agencies.',
  pro: 'The same toolkit at the volume a large agency runs.',
};

/**
 * The plan the pricing table leads with.
 *
 * One plan, named here rather than decided in the markup, so the highlighted
 * card and any "most popular" copy cannot end up on different tiers.
 */
export const FEATURED_PLAN: Plan = 'agency';
