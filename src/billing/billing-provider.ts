import type { BillingInterval, Plan, SubscriptionStatus } from '../contracts/index.js';

/**
 * What SiteOps needs from a payment provider, and nothing more.
 *
 * The interface is deliberately small. SiteOps does not implement a shopping
 * cart, a proration engine, an invoice renderer or a card form — every provider
 * worth using already has all four, hosted, PCI-compliant and localised. What
 * SiteOps does is decide *which plan* a checkout is for, and mirror the answer
 * back onto the organization.
 *
 * That split is also the security boundary. `createCheckout` is handed a plan
 * identifier, never a price: the provider price is looked up server-side from
 * configuration, so no request can influence what is charged. And
 * `parseWebhook` verifies a signature before returning anything, so no request
 * can influence what is recorded either.
 *
 * A second provider means one more implementation of this file. Nothing above
 * it — service, controller, routes, dashboard — changes.
 */

/** Where the provider sends the browser back to when it is done. */
export interface BillingReturnUrls {
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface CreateCheckoutInput {
  readonly plan: Plan;
  readonly interval: BillingInterval;
  /** Existing provider customer, when the organization already has one. */
  readonly customerId: string | null;
  /** Used to create the customer on first purchase. */
  readonly customerEmail: string;
  /**
   * Opaque values the provider echoes back on the resulting webhook.
   *
   * This is how an event is tied to a tenant. It travels through the provider
   * rather than through the browser, so it cannot be edited between the
   * checkout and the confirmation.
   */
  readonly metadata: Readonly<Record<string, string>>;
  readonly returnUrls: BillingReturnUrls;
}

export interface CheckoutSession {
  readonly url: string;
}

export interface PortalSession {
  readonly url: string;
}

/**
 * Subscription state as the provider reports it, already translated into
 * SiteOps' vocabulary.
 *
 * `plan` is resolved by the provider adapter from the price the subscription is
 * against, because only the adapter knows the provider's price identifiers.
 * Null when the subscription is against a price this deployment does not
 * recognise — a real possibility after a price is retired, and one the service
 * has to handle rather than crash on.
 */
export interface ProviderSubscription {
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly plan: Plan | null;
  readonly status: SubscriptionStatus;
  readonly interval: BillingInterval | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly trialEndsAt: Date | null;
}

/**
 * A verified webhook.
 *
 * Only produced after the signature check passes. `subscription` is null for
 * events that carry no subscription state — those are acknowledged and ignored.
 */
export interface BillingWebhookEvent {
  readonly id: string;
  readonly type: string;
  /** Provider clock, used to discard events that arrive out of order. */
  readonly createdAt: Date;
  /**
   * The provider customer this event concerns, when its object names one.
   *
   * Carried separately from {@link subscription} because the event that first
   * introduces a customer — a completed checkout — has no subscription state
   * yet. That event's whole contribution is this id and the metadata beside it.
   */
  readonly customerId: string | null;
  readonly subscription: ProviderSubscription | null;
  /** Metadata echoed back from the checkout that started this subscription. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface BillingProvider {
  readonly name: string;

  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;

  /**
   * Opens the provider's hosted management portal.
   *
   * This is where upgrades, downgrades, cancellations, payment methods and
   * invoice history live. Reimplementing any of it in SiteOps would mean
   * reimplementing proration — and getting it subtly wrong in a way that
   * shows up on someone's card.
   */
  createPortal(input: {
    readonly customerId: string;
    readonly returnUrl: string;
  }): Promise<PortalSession>;

  /** Current state, for reconciling an organization that missed a webhook. */
  getSubscription(subscriptionId: string): Promise<ProviderSubscription | null>;

  /**
   * Verifies a webhook signature and decodes the payload.
   *
   * Takes the **raw** body. A parsed-and-reserialised body will not match the
   * signature — key order and whitespace both change — and an implementation
   * that accepted one would be verifying nothing.
   *
   * Throws `ApiError` with `BILLING_WEBHOOK_INVALID` when the signature does
   * not verify. It must never return a partially trusted result.
   */
  parseWebhook(rawBody: Buffer, signatureHeader: string | undefined): BillingWebhookEvent;
}
