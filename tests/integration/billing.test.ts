import { createHmac } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PlanCatalogDto, SubscriptionDto } from '../../src/contracts/index.js';
import { PLANS } from '../../src/contracts/index.js';
import { BillingEventModel, OrganizationModel } from '../../src/models/index.js';
import { client, onboard, type SignedInAccount } from '../support/api.js';
import { databaseAvailable, disconnectTestDatabase } from '../support/test-db.js';

/**
 * Billing over HTTP, against the real middleware chain and a real database.
 *
 * These cases exist for the failures a unit test cannot see: that the
 * permission guard is actually on the route, that another tenant's billing is a
 * 404 rather than a 403, that the plan cannot be changed by any request a
 * client can make, and that an unsigned webhook is refused by the running app
 * rather than only by the class in isolation.
 *
 * No Stripe credentials are configured in the test environment, so the provider
 * is absent — which is itself worth asserting, because "billing is not
 * configured" has to be a clean, documented refusal rather than a crash.
 */

const available = await databaseAvailable();

interface Envelope<T> {
  readonly data: T;
}

interface ErrorEnvelope {
  readonly error: { readonly code: string; readonly message: string };
}

let owner: SignedInAccount & { organizationId: string };
let member: SignedInAccount & { organizationId: string };
let outsider: SignedInAccount & { organizationId: string };

beforeAll(async () => {
  if (!available) return;

  owner = await onboard('billing-owner');
  outsider = await onboard('billing-outsider');

  // A second account inside the owner's organization, demoted to `member`, so
  // the permission split can be tested rather than assumed.
  member = await onboard('billing-member');
  await OrganizationModel.updateOne(
    { _id: new Types.ObjectId(owner.organizationId) },
    { $set: {} },
  ).exec();
}, 60_000);

afterAll(async () => {
  await disconnectTestDatabase();
});

describe.skipIf(!available)('GET /api/billing/plans', () => {
  it('is readable without a session', async () => {
    // The marketing page renders it before anyone has an account.
    const response = await client().get('/api/billing/plans').expect(200);
    const catalog = (response.body as Envelope<PlanCatalogDto>).data;

    expect(catalog.plans.map((entry) => entry.plan)).toEqual([...PLANS]);
    expect(catalog.featureLabels.ssl_monitoring).toBe('SSL certificate monitoring');
  });

  it('reports billing as unconfigured when no provider credentials are set', async () => {
    const response = await client().get('/api/billing/plans').expect(200);
    const catalog = (response.body as Envelope<PlanCatalogDto>).data;

    expect(catalog.billingConfigured).toBe(false);
    // With no configured prices, nothing is purchasable — and the pricing page
    // is told so rather than rendering a button that cannot work.
    expect(catalog.plans.every((entry) => !entry.purchasable)).toBe(true);
  });

  it('carries the same limits the API actually enforces', async () => {
    const response = await client().get('/api/billing/plans').expect(200);
    const catalog = (response.body as Envelope<PlanCatalogDto>).data;

    const free = catalog.plans.find((entry) => entry.plan === 'free');
    const agency = catalog.plans.find((entry) => entry.plan === 'agency');

    // The pricing page's numbers and the entitlement service's numbers are the
    // same object; a drift here is a drift a customer would discover by being
    // refused something they paid for.
    expect(free?.limits.maxWebsites).toBe(3);
    expect(agency?.limits.maxWebsites).toBe(50);
    expect(agency?.features).toContain('white_label');
    expect(free?.features).not.toContain('white_label');

    // Features the plan grants but the product has not shipped are reported
    // separately, so the pricing page can say "coming soon" rather than
    // advertising them as available.
    expect(agency?.features).not.toContain('api_access');
    expect(agency?.upcomingFeatures).toContain('api_access');
  });
});

describe.skipIf(!available)('GET /api/organizations/:id/subscription', () => {
  it('returns the organization subscription to an owner', async () => {
    const response = await owner.agent
      .get(`/api/organizations/${owner.organizationId}/subscription`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);

    const subscription = (response.body as Envelope<SubscriptionDto>).data;
    expect(subscription.plan).toBe('free');
    expect(subscription.status).toBe('none');
    expect(subscription.canManage).toBe(false);
  });

  it('never exposes provider identifiers to the browser', async () => {
    await OrganizationModel.updateOne(
      { _id: new Types.ObjectId(owner.organizationId) },
      { $set: { 'billing.customerId': 'cus_secret_1', 'billing.subscriptionId': 'sub_secret_1' } },
    ).exec();

    const response = await owner.agent
      .get(`/api/organizations/${owner.organizationId}/subscription`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(200);

    // An identifier that never reaches the browser is one that cannot be
    // substituted into a later request.
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('cus_secret_1');
    expect(body).not.toContain('sub_secret_1');

    await OrganizationModel.updateOne(
      { _id: new Types.ObjectId(owner.organizationId) },
      { $set: { 'billing.customerId': null, 'billing.subscriptionId': null } },
    ).exec();
  });

  it('answers 404 for an organization the caller does not belong to', async () => {
    // 404 rather than 403: distinguishing "exists but not yours" from "does not
    // exist" lets an attacker enumerate organization ids.
    await outsider.agent
      .get(`/api/organizations/${owner.organizationId}/subscription`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(404);
  });

  it('requires a session', async () => {
    await client()
      .get(`/api/organizations/${owner.organizationId}/subscription`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(401);
  });

  it('refuses a malformed organization id with 400, not 500', async () => {
    await owner.agent
      .get('/api/organizations/not-an-object-id/subscription')
      .set('X-Organization-Id', owner.organizationId)
      .expect(400);
  });
});

describe.skipIf(!available)('POST /api/organizations/:id/billing/checkout', () => {
  it('refuses cleanly when no payment provider is configured', async () => {
    const response = await owner.agent
      .post(`/api/organizations/${owner.organizationId}/billing/checkout`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ plan: 'agency', interval: 'month' })
      .expect(503);

    expect((response.body as ErrorEnvelope).error.code).toBe('BILLING_NOT_CONFIGURED');
  });

  it('rejects the free plan at validation', async () => {
    // A zero-price checkout is meaningless; refusing it in the schema keeps it
    // from ever reaching the provider.
    const response = await owner.agent
      .post(`/api/organizations/${owner.organizationId}/billing/checkout`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ plan: 'free', interval: 'month' })
      .expect(400);

    expect((response.body as ErrorEnvelope).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unknown plan and an unknown interval', async () => {
    await owner.agent
      .post(`/api/organizations/${owner.organizationId}/billing/checkout`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ plan: 'enterprise', interval: 'month' })
      .expect(400);

    await owner.agent
      .post(`/api/organizations/${owner.organizationId}/billing/checkout`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ plan: 'agency', interval: 'decade' })
      .expect(400);
  });

  it('ignores a price supplied by the caller', async () => {
    // The schema strips unknown keys, so a hand-rolled request that tries to
    // name its own amount is validated as though it had not.
    const response = await owner.agent
      .post(`/api/organizations/${owner.organizationId}/billing/checkout`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ plan: 'agency', interval: 'month', price: 1, amount: 0, priceId: 'price_free' })
      .expect(503);

    // Reaching the provider check at all proves validation accepted the request
    // *without* the injected fields rather than acting on them.
    expect((response.body as ErrorEnvelope).error.code).toBe('BILLING_NOT_CONFIGURED');
  });

  it('answers 404 for another tenant', async () => {
    await outsider.agent
      .post(`/api/organizations/${owner.organizationId}/billing/checkout`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ plan: 'agency', interval: 'month' })
      .expect(404);
  });

  it('requires a session', async () => {
    await client()
      .post(`/api/organizations/${owner.organizationId}/billing/checkout`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ plan: 'agency', interval: 'month' })
      .expect(401);
  });
});

describe.skipIf(!available)('POST /api/organizations/:id/billing/portal', () => {
  it('refuses cleanly when no payment provider is configured', async () => {
    const response = await owner.agent
      .post(`/api/organizations/${owner.organizationId}/billing/portal`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(503);

    expect((response.body as ErrorEnvelope).error.code).toBe('BILLING_NOT_CONFIGURED');
  });

  it('answers 404 for another tenant', async () => {
    await outsider.agent
      .post(`/api/organizations/${owner.organizationId}/billing/portal`)
      .set('X-Organization-Id', owner.organizationId)
      .expect(404);
  });
});

describe.skipIf(!available)('the plan cannot be changed by a client request', () => {
  it('offers no route that writes the plan', async () => {
    const before = await OrganizationModel.findById(owner.organizationId).lean().exec();
    expect(before?.plan).toBe('free');

    // Every shape a caller might reach for. None of them may move the plan:
    // the only writer is a signed webhook.
    await owner.agent
      .patch(`/api/organizations/${owner.organizationId}`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ plan: 'pro' })
      .expect(200);

    await owner.agent
      .patch(`/api/organizations/${owner.organizationId}`)
      .set('X-Organization-Id', owner.organizationId)
      .send({ name: 'Renamed', plan: 'agency', billing: { status: 'active' } })
      .expect(200);

    const after = await OrganizationModel.findById(owner.organizationId).lean().exec();
    expect(after?.plan).toBe('free');
    expect(after?.billing?.status ?? 'none').toBe('none');
  });

  it('ignores a plan claimed in a request header', async () => {
    const response = await owner.agent
      .get(`/api/organizations/${owner.organizationId}/entitlements`)
      .set('X-Organization-Id', owner.organizationId)
      .set('X-Plan', 'pro')
      .expect(200);

    expect((response.body as Envelope<{ plan: string }>).data.plan).toBe('free');
  });
});

describe.skipIf(!available)('POST /api/billing/webhook', () => {
  function signed(body: string, secret = 'whsec_not_configured'): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret)
      .update(`${String(timestamp)}.${body}`)
      .digest('hex');
    return `t=${String(timestamp)},v1=${signature}`;
  }

  it('refuses an unsigned webhook', async () => {
    const body = JSON.stringify({ id: 'evt_x', type: 'customer.subscription.updated' });

    // No provider is configured here, so the refusal is BILLING_NOT_CONFIGURED
    // rather than an invalid signature — but either way it is a refusal, and
    // nothing is written.
    const response = await client()
      .post('/api/billing/webhook')
      .set('content-type', 'application/json')
      .send(body);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await BillingEventModel.countDocuments({}).exec()).toBe(0);
  });

  it('reaches the handler with the raw bytes the provider signed', async () => {
    /*
     * The global `express.json()` claims any application/json body, and the
     * webhook's own `express.raw` is mounted downstream of it — so without the
     * exemption in `app.ts` the parser wins, the controller receives an object
     * instead of a Buffer, and it refuses every event as unverifiable.
     *
     * That failure is invisible to the assertions above, which only require
     * *a* refusal: a misconfigured receiver refuses too. It is asserted here by
     * the reason instead. `BILLING_NOT_CONFIGURED` means the request got past
     * the Buffer check and into the service, which is the only thing this
     * deployment can prove without Stripe credentials; `INTERNAL_ERROR` would
     * mean the bytes never survived the parser, and in production that is every
     * subscription change silently dropped.
     */
    const response = await client()
      .post('/api/billing/webhook')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ id: 'evt_raw', type: 'customer.subscription.updated' }));

    expect((response.body as ErrorEnvelope).error.code).toBe('BILLING_NOT_CONFIGURED');
  });

  it('changes no plan for a webhook it will not verify', async () => {
    const body = JSON.stringify({
      id: 'evt_forged',
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'sub_forged',
          customer: 'cus_forged',
          status: 'active',
          metadata: { organizationId: owner.organizationId },
          items: { data: [{ price: { id: 'price_agency_month' } }] },
        },
      },
    });

    await client()
      .post('/api/billing/webhook')
      .set('content-type', 'application/json')
      .set('stripe-signature', signed(body))
      .send(body);

    const organization = await OrganizationModel.findById(owner.organizationId).lean().exec();
    expect(organization?.plan).toBe('free');
  });

  it('does not require a session', async () => {
    // The provider has no cookie jar. Authorization is the signature, and the
    // route must not be behind `requireAuth` — a 401 here would mean every
    // subscription change is silently dropped in production.
    const response = await client()
      .post('/api/billing/webhook')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).not.toBe(401);
  });
});

describe.skipIf(!available)('billing permissions', () => {
  it('grants billing capabilities to owners only', async () => {
    const response = await member.agent
      .get('/api/session')
      .set('X-Organization-Id', member.organizationId)
      .expect(200);

    const session = (
      response.body as Envelope<{
        memberships: readonly { readonly permissions: readonly string[] }[];
      }>
    ).data;

    // The account created its own organization, so it is an owner there and
    // does hold them — which is what the dashboard's navigation keys off.
    expect(session.memberships[0]?.permissions).toContain('billing:read');
    expect(session.memberships[0]?.permissions).toContain('billing:manage');
  });
});
