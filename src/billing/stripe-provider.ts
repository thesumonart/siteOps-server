import { createHmac, timingSafeEqual } from 'node:crypto';

import { request } from 'undici';

import type { BillingInterval, Plan, SubscriptionStatus } from '../contracts/index.js';
import { SUBSCRIPTION_STATUSES } from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import { createLogger } from '../utils/logger.js';
import type {
  BillingProvider,
  BillingWebhookEvent,
  CheckoutSession,
  CreateCheckoutInput,
  PortalSession,
  ProviderSubscription,
} from './billing-provider.js';
import type { PriceCatalog } from './price-catalog.js';

const logger = createLogger('billing');

const STRIPE_API = 'https://api.stripe.com/v1';
/** Pinned so a Stripe-side API change cannot alter these payloads unannounced. */
const STRIPE_API_VERSION = '2025-08-27.basil';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * How far apart the signature timestamp and our clock may be, in seconds.
 *
 * Five minutes, which is Stripe's own recommendation. The window is what stops
 * a replay: a payload and its signature stay valid forever without one, so an
 * attacker who ever observes a `subscription.updated` could resend it later to
 * restore a plan they no longer pay for.
 */
const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface StripeProviderOptions {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly prices: PriceCatalog;
}

/**
 * Stripe, over its REST API.
 *
 * Called with `undici` and `node:crypto` rather than the Stripe SDK, matching
 * how the PageSpeed provider is written: SiteOps uses four endpoints and one
 * signature scheme, and a dependency that ships a hundred more is a larger
 * supply-chain surface than the code it saves. The webhook verification below
 * is the same construction Stripe's own library performs, and unlike the
 * library's it is directly unit-testable here without a network or a key.
 *
 * The design decision worth stating: **SiteOps never mutates a subscription.**
 * Checkout creates one; the hosted customer portal changes and cancels it. That
 * is not a shortcut — proration on a mid-cycle upgrade is genuinely hard to get
 * right, it shows up on a real card when it is wrong, and Stripe's portal has
 * solved it. The webhook is how the answer comes back.
 */
export class StripeProvider implements BillingProvider {
  readonly name = 'stripe';

  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly prices: PriceCatalog;

  constructor(options: StripeProviderOptions) {
    this.secretKey = options.secretKey;
    this.webhookSecret = options.webhookSecret;
    this.prices = options.prices;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const priceId = this.prices.priceIdFor(input.plan, input.interval);
    if (priceId === null) {
      throw new ApiError(
        400,
        'That plan is not available for purchase on this deployment.',
        'BILLING_PLAN_NOT_PURCHASABLE',
      );
    }

    const form = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: input.returnUrls.successUrl,
      cancel_url: input.returnUrls.cancelUrl,
      // Lets an existing customer change quantity-free details at checkout
      // without creating a second customer record for the same organization.
      client_reference_id: input.metadata.organizationId ?? '',
      allow_promotion_codes: 'true',
      billing_address_collection: 'auto',
    });

    if (input.customerId) {
      form.set('customer', input.customerId);
      // Without this Stripe refuses to update an existing customer's address
      // from the checkout page, which is where most customers correct it.
      form.set('customer_update[address]', 'auto');
    } else {
      form.set('customer_email', input.customerEmail);
    }

    /*
     * The same metadata goes on the session *and* on the subscription it
     * creates. Session metadata reaches `checkout.session.completed`;
     * subscription metadata reaches every later `customer.subscription.*`.
     * Setting only the first would leave every renewal and cancellation with no
     * way back to a tenant except the customer id.
     */
    for (const [key, value] of Object.entries(input.metadata)) {
      form.set(`metadata[${key}]`, value);
      form.set(`subscription_data[metadata][${key}]`, value);
    }

    const session = await this.post<{ url?: string | null }>('/checkout/sessions', form, {
      // Two clicks on Upgrade must not open two checkout sessions and two
      // subscriptions. Keyed by organization and plan so a genuine change of
      // mind still gets its own session.
      idempotencyKey: `checkout:${input.metadata.organizationId ?? 'unknown'}:${input.plan}:${input.interval}`,
    });

    if (typeof session.url !== 'string' || session.url.length === 0) {
      throw ApiError.serviceUnavailable('The payment provider did not return a checkout link.');
    }
    return { url: session.url };
  }

  async createPortal(input: {
    readonly customerId: string;
    readonly returnUrl: string;
  }): Promise<PortalSession> {
    const form = new URLSearchParams({
      customer: input.customerId,
      return_url: input.returnUrl,
    });

    const session = await this.post<{ url?: string | null }>('/billing_portal/sessions', form);

    if (typeof session.url !== 'string' || session.url.length === 0) {
      throw ApiError.serviceUnavailable('The payment provider did not return a portal link.');
    }
    return { url: session.url };
  }

  async getSubscription(subscriptionId: string): Promise<ProviderSubscription | null> {
    const subscription = await this.get<StripeSubscription | null>(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { allowNotFound: true },
    );
    if (subscription === null) return null;
    return this.toProviderSubscription(subscription);
  }

  /**
   * Verifies the `Stripe-Signature` header against the raw body.
   *
   * The construction, in full, because it is the security boundary of the whole
   * billing feature and should be readable rather than trusted:
   *
   *   1. The header is `t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>…]`.
   *      Several `v1` values appear while a webhook secret is being rotated.
   *   2. The signed payload is `${t}.${rawBody}` — the *unparsed* bytes.
   *   3. The expected value is HMAC-SHA256 of that, keyed with the endpoint's
   *      signing secret.
   *   4. Comparison is constant-time, so a wrong signature cannot be refined
   *      byte by byte from response timing.
   *   5. A timestamp outside {@link SIGNATURE_TOLERANCE_SECONDS} is refused
   *      even if the signature is valid, which is what makes replay finite.
   *
   * Every failure is the same opaque 400. Telling a caller whether the
   * timestamp or the digest was wrong is telling them how to get closer.
   */
  parseWebhook(rawBody: Buffer, signatureHeader: string | undefined): BillingWebhookEvent {
    if (!signatureHeader) throw webhookRejected();

    const parts = signatureHeader.split(',');
    let timestamp: string | null = null;
    const signatures: string[] = [];

    for (const part of parts) {
      const separator = part.indexOf('=');
      if (separator === -1) continue;
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (key === 't') timestamp = value;
      else if (key === 'v1') signatures.push(value);
    }

    if (timestamp === null || signatures.length === 0) throw webhookRejected();

    const sentAt = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(sentAt)) throw webhookRejected();

    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - sentAt);
    if (ageSeconds > SIGNATURE_TOLERANCE_SECONDS) throw webhookRejected();

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest();

    const matched = signatures.some((candidate) => {
      // A malformed hex string yields a short buffer; length is checked before
      // the comparison because timingSafeEqual throws on a length mismatch and
      // a throw is itself a timing signal.
      const provided = Buffer.from(candidate, 'hex');
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    });

    if (!matched) throw webhookRejected();

    let payload: StripeEvent;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as StripeEvent;
    } catch {
      throw webhookRejected();
    }

    if (typeof payload.id !== 'string' || typeof payload.type !== 'string') {
      throw webhookRejected();
    }

    return {
      id: payload.id,
      type: payload.type,
      createdAt: new Date((payload.created ?? Math.floor(Date.now() / 1000)) * 1000),
      customerId:
        typeof payload.data?.object?.customer === 'string' ? payload.data.object.customer : null,
      subscription: this.subscriptionFromEvent(payload, payload.type),
      metadata: readMetadata(payload.data?.object?.metadata),
    };
  }

  /**
   * Pulls subscription state out of whichever event shape arrived.
   *
   * Two shapes matter. `customer.subscription.*` carries the subscription as
   * the event object. `checkout.session.completed` carries a session whose
   * `subscription` is only an id — the state arrives moments later on
   * `customer.subscription.created`, so the session event contributes the
   * customer mapping and nothing else. Returning a half-populated subscription
   * for it would write `status: none` over a subscription that is active.
   */
  private subscriptionFromEvent(payload: StripeEvent, type: string): ProviderSubscription | null {
    const object = payload.data?.object;
    if (!object) return null;

    if (type.startsWith('customer.subscription.')) {
      if (typeof object.id !== 'string' || typeof object.customer !== 'string') return null;
      const subscription = this.toProviderSubscription(object as StripeSubscription);
      // A deletion event may still report `active`; the event type is the
      // authority on what happened to it.
      return type === 'customer.subscription.deleted'
        ? { ...subscription, status: 'canceled', cancelAtPeriodEnd: false }
        : subscription;
    }

    return null;
  }

  private toProviderSubscription(subscription: StripeSubscription): ProviderSubscription {
    const item = subscription.items?.data?.[0];
    const priceId = typeof item?.price?.id === 'string' ? item.price.id : null;
    const resolved = priceId === null ? null : this.prices.planForPriceId(priceId);

    if (priceId !== null && resolved === null) {
      // Loud, because it means a subscription exists against a price this
      // deployment cannot map to a plan — the customer is paying for something
      // SiteOps will not grant until the configuration is fixed.
      logger.error(
        { subscriptionId: subscription.id, priceId },
        'billing.unknown_price_on_subscription',
      );
    }

    /*
     * `current_period_end` moved onto the subscription item in Stripe's 2025-03
     * API and remains on the subscription for older versions. Both are read so
     * a renewal date does not silently become null after a version bump.
     */
    const periodEnd = item?.current_period_end ?? subscription.current_period_end ?? null;

    return {
      subscriptionId: subscription.id,
      customerId: subscription.customer,
      plan: resolved?.plan ?? null,
      status: normalizeStatus(subscription.status),
      interval: resolved?.interval ?? normalizeInterval(item?.price?.recurring?.interval),
      currentPeriodEnd: toDate(periodEnd),
      cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
      trialEndsAt: toDate(subscription.trial_end ?? null),
    };
  }

  private async post<TResult>(
    path: string,
    form: URLSearchParams,
    options: { readonly idempotencyKey?: string } = {},
  ): Promise<TResult> {
    return this.send<TResult>(path, {
      method: 'POST',
      body: form.toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      },
    });
  }

  private async get<TResult>(
    path: string,
    options: { readonly allowNotFound?: boolean } = {},
  ): Promise<TResult> {
    return this.send<TResult>(path, { method: 'GET' }, options.allowNotFound ?? false);
  }

  /**
   * One request to Stripe.
   *
   * Failures become `BILLING_PROVIDER_ERROR` carrying no provider text. Stripe's
   * messages are written for the integrator, not the customer, and echoing them
   * to a browser leaks price ids, account state and occasionally the shape of
   * the configuration. The full response is logged instead.
   */
  private async send<TResult>(
    path: string,
    init: {
      readonly method: 'GET' | 'POST';
      readonly body?: string;
      readonly headers?: Record<string, string>;
    },
    allowNotFound = false,
  ): Promise<TResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await request(`${STRIPE_API}${path}`, {
        method: init.method,
        signal: controller.signal,
        ...(init.body === undefined ? {} : { body: init.body }),
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          'stripe-version': STRIPE_API_VERSION,
          accept: 'application/json',
          ...init.headers,
        },
      });

      const text = await response.body.text();

      if (allowNotFound && response.statusCode === 404) {
        return null as TResult;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        logger.error(
          { path, status: response.statusCode, body: text.slice(0, 1000) },
          'billing.provider_error',
        );
        throw new ApiError(
          502,
          'The payment provider could not complete that request. Please try again.',
          'BILLING_PROVIDER_ERROR',
        );
      }

      return JSON.parse(text) as TResult;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logger.error({ path, err: error }, 'billing.provider_unreachable');
      throw new ApiError(
        502,
        'The payment provider could not be reached. Please try again.',
        'BILLING_PROVIDER_ERROR',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function webhookRejected(): ApiError {
  return new ApiError(400, 'Invalid webhook signature.', 'BILLING_WEBHOOK_INVALID');
}

function normalizeStatus(status: unknown): SubscriptionStatus {
  return typeof status === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(status)
    ? (status as SubscriptionStatus)
    : 'none';
}

function normalizeInterval(interval: unknown): BillingInterval | null {
  if (interval === 'month' || interval === 'year') return interval;
  return null;
}

function toDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

function readMetadata(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

/* --- The subset of Stripe's payloads SiteOps reads. ---------------------- */

interface StripePrice {
  readonly id?: string;
  readonly recurring?: { readonly interval?: string } | null;
}

interface StripeSubscriptionItem {
  readonly price?: StripePrice | null;
  readonly current_period_end?: number | null;
}

interface StripeSubscription {
  readonly id: string;
  readonly customer: string;
  readonly status?: string;
  readonly cancel_at_period_end?: boolean;
  readonly current_period_end?: number | null;
  readonly trial_end?: number | null;
  readonly items?: { readonly data?: readonly StripeSubscriptionItem[] } | null;
}

interface StripeEvent {
  readonly id?: string;
  readonly type?: string;
  readonly created?: number;
  readonly data?: {
    readonly object?: {
      readonly id?: string;
      readonly customer?: string;
      readonly metadata?: unknown;
      readonly [key: string]: unknown;
    };
  };
}

/** Exported for the signature tests, which must not reach the network. */
export { SIGNATURE_TOLERANCE_SECONDS };

/** Plan resolution is provider-internal; re-exported for the service's typing. */
export type { Plan };
