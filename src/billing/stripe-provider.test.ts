import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { isApiError } from '../errors/ApiError.js';
import { PriceCatalog } from './price-catalog.js';
import { StripeProvider, SIGNATURE_TOLERANCE_SECONDS } from './stripe-provider.js';

/**
 * Webhook signature verification.
 *
 * This is the whole authorization for the one route in SiteOps that has no
 * session and no permission check: a forged webhook that verified would let
 * anyone put any organization on any plan. So every way it can be wrong gets a
 * case, and each asserts a *refusal* — a test that only proves the happy path
 * would pass just as well against a function that returned true unconditionally.
 *
 * No network is involved. Signing is deterministic and reproduced here from the
 * documented construction, so these run offline and without a Stripe account.
 */

const WEBHOOK_SECRET = 'whsec_test_secret_value';
const OTHER_SECRET = 'whsec_a_completely_different_secret';

function provider(): StripeProvider {
  return new StripeProvider({
    secretKey: 'sk_test_not_a_real_key',
    webhookSecret: WEBHOOK_SECRET,
    prices: new PriceCatalog({
      starter_month: 'price_starter_month',
      starter_year: 'price_starter_year',
      agency_month: 'price_agency_month',
    }),
  });
}

/** Signs a payload exactly as Stripe does: HMAC-SHA256 over `${t}.${body}`. */
function sign(
  body: string,
  options: { readonly secret?: string; readonly timestamp?: number } = {},
): string {
  const secret = options.secret ?? WEBHOOK_SECRET;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex');
  return `t=${String(timestamp)},v1=${signature}`;
}

function subscriptionEvent(
  overrides: {
    readonly type?: string;
    readonly priceId?: string;
    readonly status?: string;
    readonly organizationId?: string;
    readonly cancelAtPeriodEnd?: boolean;
  } = {},
): string {
  return JSON.stringify({
    id: 'evt_test_1',
    type: overrides.type ?? 'customer.subscription.updated',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'sub_test_1',
        customer: 'cus_test_1',
        status: overrides.status ?? 'active',
        cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
        trial_end: null,
        metadata: overrides.organizationId ? { organizationId: overrides.organizationId } : {},
        items: {
          data: [
            {
              current_period_end: 1_800_000_000,
              price: {
                id: overrides.priceId ?? 'price_agency_month',
                recurring: { interval: 'month' },
              },
            },
          ],
        },
      },
    },
  });
}

describe('StripeProvider.parseWebhook', () => {
  it('accepts a correctly signed payload and maps the price to a plan', () => {
    const body = subscriptionEvent({ organizationId: '507f1f77bcf86cd799439011' });
    const event = provider().parseWebhook(Buffer.from(body), sign(body));

    expect(event.id).toBe('evt_test_1');
    expect(event.type).toBe('customer.subscription.updated');
    expect(event.customerId).toBe('cus_test_1');
    expect(event.metadata.organizationId).toBe('507f1f77bcf86cd799439011');
    expect(event.subscription?.plan).toBe('agency');
    expect(event.subscription?.interval).toBe('month');
    expect(event.subscription?.status).toBe('active');
    expect(event.subscription?.currentPeriodEnd?.getTime()).toBe(1_800_000_000_000);
  });

  it('refuses a payload with no signature header at all', () => {
    const body = subscriptionEvent();
    expect(() => provider().parseWebhook(Buffer.from(body), undefined)).toThrowError();

    try {
      provider().parseWebhook(Buffer.from(body), undefined);
    } catch (error) {
      expect(isApiError(error) && error.code).toBe('BILLING_WEBHOOK_INVALID');
      expect(isApiError(error) && error.statusCode).toBe(400);
    }
  });

  it('refuses a payload signed with a different secret', () => {
    const body = subscriptionEvent();
    const header = sign(body, { secret: OTHER_SECRET });

    expect(() => provider().parseWebhook(Buffer.from(body), header)).toThrowError();
  });

  it('refuses a payload that was altered after signing', () => {
    const original = subscriptionEvent({ priceId: 'price_starter_month' });
    const header = sign(original);

    // The attack this prevents: swap the price for a more expensive plan and
    // replay the signature that was valid for the cheaper one.
    const tampered = original.replace('price_starter_month', 'price_agency_month');
    expect(tampered).not.toBe(original);

    expect(() => provider().parseWebhook(Buffer.from(tampered), header)).toThrowError();
  });

  it('refuses a signature older than the replay window', () => {
    const body = subscriptionEvent();
    const stale = Math.floor(Date.now() / 1000) - SIGNATURE_TOLERANCE_SECONDS - 1;

    // Correctly signed — just too old. Without the timestamp check, any
    // captured event could be replayed forever.
    expect(() =>
      provider().parseWebhook(Buffer.from(body), sign(body, { timestamp: stale })),
    ).toThrowError();
  });

  it('accepts a signature at the edge of the replay window', () => {
    const body = subscriptionEvent();
    const edge = Math.floor(Date.now() / 1000) - (SIGNATURE_TOLERANCE_SECONDS - 5);

    expect(() =>
      provider().parseWebhook(Buffer.from(body), sign(body, { timestamp: edge })),
    ).not.toThrow();
  });

  it('accepts when any one of several rotated signatures matches', () => {
    const body = subscriptionEvent();
    const timestamp = Math.floor(Date.now() / 1000);
    const valid = createHmac('sha256', WEBHOOK_SECRET)
      .update(`${String(timestamp)}.${body}`)
      .digest('hex');

    // Stripe sends several `v1` values while a secret is being rotated. Only
    // one of them is signed with the secret this endpoint holds.
    const header = `t=${String(timestamp)},v1=${'0'.repeat(64)},v1=${valid}`;
    expect(() => provider().parseWebhook(Buffer.from(body), header)).not.toThrow();
  });

  it('refuses a malformed signature header rather than throwing an unhandled error', () => {
    const body = subscriptionEvent();

    for (const header of [
      '',
      'garbage',
      't=abc,v1=xyz',
      'v1=deadbeef',
      `t=${String(Date.now())}`,
    ]) {
      let code: string | null = null;
      try {
        provider().parseWebhook(Buffer.from(body), header);
      } catch (error) {
        code = isApiError(error) ? error.code : 'NOT_AN_API_ERROR';
      }
      expect(code).toBe('BILLING_WEBHOOK_INVALID');
    }
  });

  it('refuses a signature whose hex is the wrong length', () => {
    const body = subscriptionEvent();
    const timestamp = Math.floor(Date.now() / 1000);

    // `timingSafeEqual` throws on a length mismatch; the implementation must
    // check the length itself rather than letting that escape as a 500.
    const header = `t=${String(timestamp)},v1=abcd`;
    let code: string | null = null;
    try {
      provider().parseWebhook(Buffer.from(body), header);
    } catch (error) {
      code = isApiError(error) ? error.code : 'NOT_AN_API_ERROR';
    }
    expect(code).toBe('BILLING_WEBHOOK_INVALID');
  });

  it('reports a deletion as canceled even when the payload still says active', () => {
    const body = subscriptionEvent({ type: 'customer.subscription.deleted', status: 'active' });
    const event = provider().parseWebhook(Buffer.from(body), sign(body));

    expect(event.subscription?.status).toBe('canceled');
    expect(event.subscription?.cancelAtPeriodEnd).toBe(false);
  });

  it('leaves the plan unresolved for a price this deployment does not know', () => {
    const body = subscriptionEvent({ priceId: 'price_from_another_account' });
    const event = provider().parseWebhook(Buffer.from(body), sign(body));

    // Not an error, and emphatically not a default plan: the service refuses to
    // act on it rather than guessing a tier nobody bought.
    expect(event.subscription?.plan).toBeNull();
  });

  it('carries the customer but no subscription for a completed checkout', () => {
    const body = JSON.stringify({
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'cs_test_1',
          customer: 'cus_test_9',
          subscription: 'sub_test_9',
          metadata: { organizationId: '507f1f77bcf86cd799439011' },
        },
      },
    });

    const event = provider().parseWebhook(Buffer.from(body), sign(body));

    expect(event.customerId).toBe('cus_test_9');
    expect(event.metadata.organizationId).toBe('507f1f77bcf86cd799439011');
    // The session names a subscription id but carries none of its state. A
    // half-populated subscription here would overwrite an active one.
    expect(event.subscription).toBeNull();
  });

  it('refuses a body that is not JSON, even when correctly signed', () => {
    const body = 'not json at all';
    let code: string | null = null;
    try {
      provider().parseWebhook(Buffer.from(body), sign(body));
    } catch (error) {
      code = isApiError(error) ? error.code : 'NOT_AN_API_ERROR';
    }
    expect(code).toBe('BILLING_WEBHOOK_INVALID');
  });
});

describe('PriceCatalog', () => {
  const catalog = new PriceCatalog({
    starter_month: 'price_a',
    starter_year: 'price_b',
    agency_month: 'price_c',
    // Deliberately unset, to prove a partly configured deployment is supported.
    agency_year: undefined,
    pro_month: '   ',
  });

  it('resolves a plan and interval to the configured price', () => {
    expect(catalog.priceIdFor('starter', 'month')).toBe('price_a');
    expect(catalog.priceIdFor('starter', 'year')).toBe('price_b');
  });

  it('returns null for a plan and interval with no configured price', () => {
    expect(catalog.priceIdFor('agency', 'year')).toBeNull();
    expect(catalog.priceIdFor('free', 'month')).toBeNull();
  });

  it('treats a blank price id as unconfigured', () => {
    // Otherwise an empty environment variable becomes a price id of "", which
    // reaches the provider and fails there instead of here.
    expect(catalog.priceIdFor('pro', 'month')).toBeNull();
  });

  it('resolves a price back to its plan and interval', () => {
    expect(catalog.planForPriceId('price_c')).toEqual({ plan: 'agency', interval: 'month' });
  });

  it('returns null for an unrecognised price', () => {
    expect(catalog.planForPriceId('price_unknown')).toBeNull();
  });

  it('lists only the plans that have at least one configured price', () => {
    expect([...catalog.purchasablePlans()]).toEqual(['starter', 'agency']);
  });

  it('reports an entirely unconfigured catalogue as empty', () => {
    expect(new PriceCatalog({}).isEmpty).toBe(true);
    expect(catalog.isEmpty).toBe(false);
  });
});
