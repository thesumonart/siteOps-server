import type {
  BillingRedirectDto,
  Plan,
  PlanCatalogDto,
  PlanCatalogEntryDto,
  StartCheckoutInput,
  SubscriptionDto,
} from '../contracts/index.js';
import {
  DEFAULT_PLAN,
  FEATURED_PLAN,
  PLANS,
  PLAN_FEATURE_LABELS,
  PLAN_LABELS,
  PLAN_PRICING,
  PLAN_TAGLINES,
  availableFeaturesFor,
  isEntitledStatus,
  isPurchasablePlan,
  limitsFor,
  upcomingFeaturesFor,
  yearlyMonthsFree,
} from '../contracts/index.js';
import type { BillingProvider, BillingWebhookEvent } from '../billing/billing-provider.js';
import type { PriceCatalog } from '../billing/price-catalog.js';
import { ApiError } from '../errors/ApiError.js';
import type { OrganizationBilling } from '../models/index.js';
import type {
  OrganizationRecord,
  OrganizationRepository,
} from '../repositories/organization.repository.js';
import type { BillingEventRepository } from '../repositories/billing-event.repository.js';
import type { OrganizationActor, OrganizationContext } from '../types/common.types.js';
import { createLogger } from '../utils/logger.js';
import { toObjectId } from '../utils/object-id.js';
import type { AuditService } from './audit.service.js';

const logger = createLogger('billing');

/** Metadata key that carries the tenant through the provider and back. */
const ORGANIZATION_METADATA_KEY = 'organizationId';

export interface BillingServiceOptions {
  /**
   * Null when no payment provider is configured on this deployment.
   *
   * Represented as an absent provider rather than a stub that pretends to work,
   * because the two are genuinely different situations and the dashboard should
   * say which one it is in. A stub would produce fake checkout URLs and fake
   * successes — the one thing billing code must never do.
   */
  readonly provider: BillingProvider | null;
  readonly prices: PriceCatalog;
  readonly organizations: OrganizationRepository;
  readonly events: BillingEventRepository;
  readonly audit: AuditService;
  /** Dashboard origin, used to build the URLs the provider returns the browser to. */
  readonly appUrl: string;
}

/**
 * Subscriptions: what a plan costs, what an organization is on, and how it
 * changes.
 *
 * Three rules hold throughout, and the shape of this service exists to make
 * them true rather than merely intended:
 *
 *  1. **The plan changes only on a signed provider event.** No route sets it.
 *     `startCheckout` returns a redirect and writes nothing about the plan;
 *     `handleWebhook` is the only path into `applySubscriptionState`. A caller
 *     who replays, edits or forges the browser's return from checkout changes
 *     nothing at all, because the return trip is not what grants the plan.
 *  2. **The price is never in the request.** A checkout names a plan and an
 *     interval; the provider price id comes from this deployment's
 *     configuration. There is no field a caller could send to be charged less.
 *  3. **A tenant is resolved from provider-held state.** The organization comes
 *     from metadata the provider stored and echoed, or from the customer id
 *     mapping — never from anything the browser carried between the two hops.
 *
 * Entitlement enforcement is deliberately *not* here. `EntitlementService`
 * still reads `organization.plan` and knows nothing about billing, so a
 * provider outage cannot make every limit check fail.
 */
export class BillingService {
  private readonly provider: BillingProvider | null;
  private readonly prices: PriceCatalog;
  private readonly organizations: OrganizationRepository;
  private readonly events: BillingEventRepository;
  private readonly audit: AuditService;
  private readonly appUrl: string;

  constructor(options: BillingServiceOptions) {
    this.provider = options.provider;
    this.prices = options.prices;
    this.organizations = options.organizations;
    this.events = options.events;
    this.audit = options.audit;
    this.appUrl = options.appUrl.replace(/\/+$/, '');
  }

  get isConfigured(): boolean {
    return this.provider !== null;
  }

  /**
   * The public price list.
   *
   * Served unauthenticated: it is the marketing page's data, and there is
   * nothing tenant-specific in it. Every plan in {@link PLANS} appears, so a
   * plan the backend can put an organization on is never one a visitor cannot
   * see. `purchasable` is false where this deployment has no configured price,
   * which is what lets the pricing page offer "Contact us" instead of a button
   * that would fail.
   */
  catalog(): PlanCatalogDto {
    const sellable = new Set(this.prices.purchasablePlans());

    const plans: PlanCatalogEntryDto[] = PLANS.map((plan) => ({
      plan,
      name: PLAN_LABELS[plan],
      tagline: PLAN_TAGLINES[plan],
      currency: PLAN_PRICING[plan].currency,
      monthlyPrice: PLAN_PRICING[plan].monthly,
      yearlyPrice: PLAN_PRICING[plan].yearly,
      yearlyMonthsFree: yearlyMonthsFree(plan),
      limits: limitsFor(plan),
      features: availableFeaturesFor(plan),
      upcomingFeatures: upcomingFeaturesFor(plan),
      // The free plan is always available and never "purchasable": signing up
      // is how you get it.
      purchasable: isPurchasablePlan(plan) && sellable.has(plan),
      featured: plan === FEATURED_PLAN,
    }));

    return {
      plans,
      featureLabels: PLAN_FEATURE_LABELS,
      billingConfigured: this.isConfigured,
    };
  }

  /**
   * The organization's subscription as the dashboard shows it.
   *
   * Read from the organization document, not from the provider. The document is
   * kept current by webhooks, and calling the provider on every page load would
   * put a third-party network hop on a screen the user opened to read four
   * fields — and take the screen down whenever the provider is slow.
   */
  async describe(organization: OrganizationContext): Promise<SubscriptionDto> {
    const record = await this.organizations.findById(organization.id);
    if (!record) {
      throw ApiError.notFound('ORGANIZATION_NOT_FOUND', 'That organization no longer exists.');
    }
    return toSubscriptionDto(record, this.isConfigured);
  }

  /**
   * Opens a hosted checkout for a plan.
   *
   * Returns a URL and changes nothing. If the customer abandons the page, or
   * never pays, the organization stays exactly where it was — which is the
   * behaviour you want and the reason the plan is not written here.
   */
  async startCheckout(
    organization: OrganizationContext,
    input: StartCheckoutInput,
    actor: OrganizationActor & { readonly email: string },
  ): Promise<BillingRedirectDto> {
    const provider = this.requireProvider();

    if (this.prices.priceIdFor(input.plan, input.interval) === null) {
      throw new ApiError(
        400,
        `The ${PLAN_LABELS[input.plan]} plan is not available for purchase on this deployment.`,
        'BILLING_PLAN_NOT_PURCHASABLE',
      );
    }

    const record = await this.organizations.findById(organization.id);
    if (!record) {
      throw ApiError.notFound('ORGANIZATION_NOT_FOUND', 'That organization no longer exists.');
    }

    /*
     * An organization that already has a subscription is sent to the portal
     * instead. Running a second checkout would leave two live subscriptions on
     * one customer and bill them both — the provider has no idea the first one
     * was meant to be replaced.
     */
    const billing = readBilling(record);
    if (billing.subscriptionId !== null && billing.status !== 'canceled') {
      return this.openPortal(organization, actor);
    }

    const session = await provider.createCheckout({
      plan: input.plan,
      interval: input.interval,
      customerId: billing.customerId,
      customerEmail: actor.email,
      metadata: { [ORGANIZATION_METADATA_KEY]: organization.id },
      returnUrls: {
        successUrl: `${this.appUrl}/dashboard/billing?checkout=success`,
        cancelUrl: `${this.appUrl}/dashboard/billing?checkout=cancelled`,
      },
    });

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'billing.checkout_started',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'organization',
      targetId: organization.objectId,
      targetLabel: PLAN_LABELS[input.plan],
    });

    return { url: session.url };
  }

  /**
   * Opens the provider's management portal.
   *
   * Everything after the first purchase happens there: upgrade, downgrade,
   * cancel, resume, change card, download invoices. The portal session is
   * created against the customer id stored on the organization, so it can only
   * ever open the billing of the tenant the caller was authorized for.
   */
  async openPortal(
    organization: OrganizationContext,
    actor: OrganizationActor,
  ): Promise<BillingRedirectDto> {
    const provider = this.requireProvider();

    const record = await this.organizations.findById(organization.id);
    if (!record) {
      throw ApiError.notFound('ORGANIZATION_NOT_FOUND', 'That organization no longer exists.');
    }

    const customerId = readBilling(record).customerId;
    if (customerId === null) {
      throw new ApiError(
        400,
        'This organization has no billing account yet. Choose a plan to get started.',
        'BILLING_NO_CUSTOMER',
      );
    }

    const session = await provider.createPortal({
      customerId,
      returnUrl: `${this.appUrl}/dashboard/billing`,
    });

    /*
     * Logged rather than audited. Opening the portal changes nothing — every
     * change made inside it comes back as a webhook and is audited there, with
     * the provider as the actor. An audit entry here would claim a change that
     * may never happen. The log line is what a support question needs.
     */
    logger.info(
      { organizationId: organization.id, actorUserId: actor.id },
      'billing.portal_opened',
    );

    return { url: session.url };
  }

  /**
   * Applies one provider webhook.
   *
   * The order of operations is the whole design:
   *
   *   1. **Verify the signature.** Nothing is read from the payload first —
   *      an unverified body is attacker-controlled JSON, and parsing it to
   *      decide whether to verify would be reading it first.
   *   2. **Claim the event id.** A duplicate delivery stops here, so the
   *      handler below runs exactly once per event even under concurrent
   *      retries.
   *   3. **Apply it**, releasing the claim if that throws — otherwise a
   *      transient database failure would make the provider's retry look like
   *      a duplicate and the change would be lost for good.
   *
   * Unrecognised event types are acknowledged, not refused. A 4xx would make
   * the provider retry an event we will never act on, and eventually disable
   * the endpoint for the events we do act on.
   */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<void> {
    const provider = this.requireProvider();

    const event = provider.parseWebhook(rawBody, signature);

    const claimed = await this.events.claim(event.id, event.type);
    if (!claimed) {
      logger.info({ eventId: event.id, type: event.type }, 'billing.webhook_duplicate');
      return;
    }

    try {
      await this.applyEvent(event);
    } catch (error) {
      await this.events.release(event.id);
      throw error;
    }
  }

  private async applyEvent(event: BillingWebhookEvent): Promise<void> {
    const organization = await this.resolveOrganization(event);
    if (!organization) {
      // Not an error: a Stripe account can serve more than one deployment, and
      // an event for a customer we do not know is simply not ours.
      logger.warn(
        { eventId: event.id, type: event.type, customerId: event.customerId },
        'billing.webhook_unmatched',
      );
      return;
    }

    /*
     * A completed checkout is where the customer id first becomes known. It
     * carries no usable subscription state — Stripe sends that moments later on
     * `customer.subscription.created` — so this branch does the mapping and
     * stops. Writing a plan from here would race the subscription event.
     */
    if (event.subscription === null) {
      if (event.customerId !== null && readBilling(organization).customerId === null) {
        await this.organizations.attachBillingCustomer(organization._id, event.customerId);
        logger.info(
          { organizationId: organization._id.toHexString(), eventId: event.id },
          'billing.customer_attached',
        );
      }
      return;
    }

    const subscription = event.subscription;

    if (readBilling(organization).customerId === null) {
      await this.organizations.attachBillingCustomer(organization._id, subscription.customerId);
    }

    /*
     * Which plan the organization lands on:
     *
     *  - a subscription in an entitled state grants the plan its price maps to;
     *  - one that has ended falls back to the default plan, which is the
     *    product's floor rather than a punishment — a lapsed customer keeps
     *    their data and their free-tier monitoring;
     *  - a subscription against a price this deployment cannot map is left
     *    alone. Guessing would either downgrade someone who is paying or hand
     *    out a tier nobody bought.
     */
    const entitled = isEntitledStatus(subscription.status);
    let plan: Plan;

    if (entitled) {
      if (subscription.plan === null) {
        logger.error(
          { eventId: event.id, subscriptionId: subscription.subscriptionId },
          'billing.unmappable_price_ignored',
        );
        return;
      }
      plan = subscription.plan;
    } else {
      plan = DEFAULT_PLAN;
    }

    const previousPlan = organization.plan;

    const updated = await this.organizations.applySubscriptionState(organization._id, {
      plan,
      status: subscription.status,
      subscriptionId: subscription.subscriptionId,
      interval: subscription.interval,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      trialEndsAt: subscription.trialEndsAt,
      eventAt: event.createdAt,
    });

    if (!updated) {
      // The guard in the repository refused it: a newer event has already been
      // applied. Acknowledged and dropped, which is the correct outcome.
      logger.info(
        { eventId: event.id, organizationId: organization._id.toHexString() },
        'billing.webhook_stale',
      );
      return;
    }

    await this.recordBillingAudit(updated, event, previousPlan, plan);

    logger.info(
      {
        organizationId: updated._id.toHexString(),
        eventId: event.id,
        type: event.type,
        plan,
        status: subscription.status,
      },
      'billing.subscription_applied',
    );
  }

  /**
   * Finds the tenant an event belongs to.
   *
   * Metadata first, because it is set by us at checkout and survives a customer
   * being reassigned; the customer-id mapping second, because renewals and
   * cancellations for a subscription created before the metadata existed carry
   * only that. Both come from provider-held state — neither is anything the
   * browser could have supplied.
   */
  private async resolveOrganization(
    event: BillingWebhookEvent,
  ): Promise<OrganizationRecord | null> {
    const fromMetadata = event.metadata[ORGANIZATION_METADATA_KEY];
    if (fromMetadata) {
      const organization = await this.organizations.findById(fromMetadata);
      if (organization) return organization;
    }

    const customerId = event.subscription?.customerId ?? event.customerId;
    if (customerId) {
      return this.organizations.findByBillingCustomerId(customerId);
    }

    return null;
  }

  /** Writes the activity-feed entry that matches what actually changed. */
  private async recordBillingAudit(
    organization: OrganizationRecord,
    event: BillingWebhookEvent,
    previousPlan: Plan,
    plan: Plan,
  ): Promise<void> {
    const action =
      event.type === 'customer.subscription.created'
        ? 'billing.subscription_activated'
        : event.type === 'customer.subscription.deleted'
          ? 'billing.subscription_cancelled'
          : previousPlan === plan
            ? 'billing.subscription_updated'
            : 'billing.plan_changed';

    await this.audit.record({
      organizationId: organization._id,
      action,
      // No user: the provider is the actor. A webhook is not attributable to
      // whoever happened to click Upgrade, and inventing an actor would put a
      // name against a change they may not have made.
      actorUserId: null,
      actorName: 'Billing',
      targetType: 'organization',
      targetId: organization._id,
      targetLabel: PLAN_LABELS[plan],
    });
  }

  private requireProvider(): BillingProvider {
    if (this.provider === null) {
      throw new ApiError(
        503,
        'Billing is not configured on this deployment.',
        'BILLING_NOT_CONFIGURED',
      );
    }
    return this.provider;
  }
}

/**
 * The billing record, with the defaults an older document does not carry.
 *
 * Organizations created before billing existed have no `billing` subdocument at
 * all — Mongoose applies a schema default on write, not to documents already in
 * the collection, and `.lean()` returns exactly what is stored. Reading through
 * this keeps every caller from having to remember that, and means no backfill
 * migration is needed for a shape whose absence is indistinguishable from its
 * default.
 */
function readBilling(organization: OrganizationRecord): OrganizationBilling {
  return (
    organization.billing ?? {
      customerId: null,
      subscriptionId: null,
      status: 'none',
      interval: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEndsAt: null,
      lastEventAt: null,
    }
  );
}

export function toSubscriptionDto(
  organization: OrganizationRecord,
  billingConfigured: boolean,
): SubscriptionDto {
  const billing = readBilling(organization);

  return {
    plan: organization.plan,
    status: billing.status,
    interval: billing.interval,
    currentPeriodEnd: billing.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
    trialEndsAt: billing.trialEndsAt?.toISOString() ?? null,
    billingConfigured,
    // The portal needs a customer to open against; before the first purchase
    // there is none, and the only useful action is checkout.
    canManage: billingConfigured && billing.customerId !== null,
  };
}
