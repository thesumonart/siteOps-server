import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { Plan } from '../contracts/index.js';
import { PLANS, PURCHASABLE_PLANS, PLAN_PRICING, yearlyMonthsFree } from '../contracts/index.js';
import type { BillingWebhookEvent, ProviderSubscription } from '../billing/billing-provider.js';
import { PriceCatalog } from '../billing/price-catalog.js';
import { isApiError } from '../errors/ApiError.js';
import type { OrganizationBilling } from '../models/index.js';
import type {
  OrganizationRecord,
  OrganizationRepository,
} from '../repositories/organization.repository.js';
import type { OrganizationContext } from '../types/common.types.js';
import type { AuditService } from './audit.service.js';
import { BillingService } from './billing.service.js';

/**
 * Billing rules, tested without a provider, a database or a network.
 *
 * The cases that matter here are the ones where getting it wrong costs someone
 * money or access: a replayed webhook applied twice, an out-of-order event
 * restoring a cancelled plan, a subscription against a price we cannot map, and
 * a checkout for a plan that is not sold. Each is asserted as a *refusal or a
 * no-op*, because every one of them is a state the code must decline to act on
 * rather than guess at.
 */

const ORGANIZATION_ID = '507f1f77bcf86cd799439011';
const ORGANIZATION_OBJECT_ID = new Types.ObjectId(ORGANIZATION_ID);

function billing(overrides: Partial<OrganizationBilling> = {}): OrganizationBilling {
  return {
    customerId: null,
    subscriptionId: null,
    status: 'none',
    interval: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    lastEventAt: null,
    ...overrides,
  };
}

function organizationRecord(
  plan: Plan = 'free',
  billingOverrides: Partial<OrganizationBilling> = {},
): OrganizationRecord {
  return {
    _id: ORGANIZATION_OBJECT_ID,
    name: 'Test Agency',
    slug: 'test-agency',
    plan,
    timezone: 'UTC',
    branding: {
      brandName: null,
      logoUrl: null,
      primaryColor: null,
      footerText: null,
      hidePoweredBy: false,
      supportEmail: null,
    },
    billing: billing(billingOverrides),
    createdByUserId: new Types.ObjectId(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function context(plan: Plan = 'free'): OrganizationContext {
  return {
    id: ORGANIZATION_ID,
    objectId: ORGANIZATION_OBJECT_ID,
    name: 'Test Agency',
    slug: 'test-agency',
    plan,
    role: 'owner',
    permissions: ['billing:read', 'billing:manage'],
    clientScope: null,
  };
}

function providerSubscription(overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return {
    subscriptionId: 'sub_1',
    customerId: 'cus_1',
    plan: 'agency',
    status: 'active',
    interval: 'month',
    currentPeriodEnd: new Date('2026-01-01T00:00:00.000Z'),
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    ...overrides,
  };
}

function webhookEvent(overrides: Partial<BillingWebhookEvent> = {}): BillingWebhookEvent {
  return {
    id: 'evt_1',
    type: 'customer.subscription.updated',
    createdAt: new Date('2025-06-01T00:00:00.000Z'),
    customerId: 'cus_1',
    subscription: providerSubscription(),
    metadata: { organizationId: ORGANIZATION_ID },
    ...overrides,
  };
}

interface Harness {
  readonly service: BillingService;
  readonly organizations: {
    findById: ReturnType<typeof vi.fn>;
    findByBillingCustomerId: ReturnType<typeof vi.fn>;
    attachBillingCustomer: ReturnType<typeof vi.fn>;
    applySubscriptionState: ReturnType<typeof vi.fn>;
  };
  readonly events: { claim: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  readonly audit: { record: ReturnType<typeof vi.fn> };
  readonly provider: {
    createCheckout: ReturnType<typeof vi.fn>;
    createPortal: ReturnType<typeof vi.fn>;
    getSubscription: ReturnType<typeof vi.fn>;
    parseWebhook: ReturnType<typeof vi.fn>;
  };
}

function harness(
  options: {
    readonly record?: OrganizationRecord | null;
    readonly withProvider?: boolean;
    readonly claimed?: boolean;
    readonly applyResult?: OrganizationRecord | null;
  } = {},
): Harness {
  const record = options.record === undefined ? organizationRecord() : options.record;

  const organizations = {
    findById: vi.fn().mockResolvedValue(record),
    findByBillingCustomerId: vi.fn().mockResolvedValue(record),
    attachBillingCustomer: vi.fn().mockResolvedValue(record),
    applySubscriptionState: vi
      .fn()
      .mockResolvedValue(
        options.applyResult === undefined ? (record ?? organizationRecord()) : options.applyResult,
      ),
  };

  const events = {
    claim: vi.fn().mockResolvedValue(options.claimed ?? true),
    release: vi.fn().mockResolvedValue(undefined),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };

  const provider = {
    createCheckout: vi.fn().mockResolvedValue({ url: 'https://checkout.example/session' }),
    createPortal: vi.fn().mockResolvedValue({ url: 'https://portal.example/session' }),
    getSubscription: vi.fn().mockResolvedValue(null),
    parseWebhook: vi.fn(),
  };

  const service = new BillingService({
    provider: (options.withProvider ?? true) ? { name: 'test', ...provider } : null,
    prices: new PriceCatalog({
      starter_month: 'price_starter_month',
      starter_year: 'price_starter_year',
      agency_month: 'price_agency_month',
      agency_year: 'price_agency_year',
    }),
    organizations: organizations as unknown as OrganizationRepository,
    events,
    audit: audit as unknown as AuditService,
    appUrl: 'https://app.siteops.test/',
  });

  return { service, organizations, events, audit, provider };
}

describe('BillingService.catalog', () => {
  it('lists every plan the backend can put an organization on', () => {
    const catalog = harness().service.catalog();

    // A plan a visitor cannot see is a plan they cannot understand being moved
    // to, so the catalogue and PLANS must not diverge.
    expect(catalog.plans.map((entry) => entry.plan)).toEqual([...PLANS]);
  });

  it('marks a plan unpurchasable when this deployment has no price for it', () => {
    const catalog = harness().service.catalog();
    const byPlan = new Map(catalog.plans.map((entry) => [entry.plan, entry]));

    expect(byPlan.get('starter')?.purchasable).toBe(true);
    expect(byPlan.get('agency')?.purchasable).toBe(true);
    // No `pro_*` price is configured in the harness.
    expect(byPlan.get('pro')?.purchasable).toBe(false);
    // Free is never "purchasable": signing up is how you get it.
    expect(byPlan.get('free')?.purchasable).toBe(false);
  });

  it('reports billing as unconfigured when there is no provider', () => {
    const catalog = harness({ withProvider: false }).service.catalog();
    expect(catalog.billingConfigured).toBe(false);
  });

  it('carries the same prices and limits the backend enforces', () => {
    const catalog = harness().service.catalog();
    const agency = catalog.plans.find((entry) => entry.plan === 'agency');

    expect(agency?.monthlyPrice).toBe(PLAN_PRICING.agency.monthly);
    expect(agency?.yearlyPrice).toBe(PLAN_PRICING.agency.yearly);
    expect(agency?.yearlyMonthsFree).toBe(yearlyMonthsFree('agency'));
    expect(agency?.limits.maxWebsites).toBe(50);
  });
});

describe('BillingService.startCheckout', () => {
  it('refuses when no payment provider is configured', async () => {
    const { service } = harness({ withProvider: false });

    await expect(
      service.startCheckout(
        context(),
        { plan: 'agency', interval: 'month' },
        { id: 'u1', name: 'Owner', email: 'owner@example.com', role: 'owner' },
      ),
    ).rejects.toMatchObject({ code: 'BILLING_NOT_CONFIGURED' });
  });

  it('refuses a plan this deployment does not sell', async () => {
    const { service, provider } = harness();

    await expect(
      service.startCheckout(
        context(),
        { plan: 'pro', interval: 'month' },
        { id: 'u1', name: 'Owner', email: 'owner@example.com', role: 'owner' },
      ),
    ).rejects.toMatchObject({ code: 'BILLING_PLAN_NOT_PURCHASABLE' });

    // Refused before the provider is touched, so no session is created and no
    // provider quota is spent on a request that could never succeed.
    expect(provider.createCheckout).not.toHaveBeenCalled();
  });

  it('passes the plan, never a price, and tags the session with the tenant', async () => {
    const { service, provider } = harness();

    await service.startCheckout(
      context(),
      { plan: 'agency', interval: 'year' },
      { id: 'u1', name: 'Owner', email: 'owner@example.com', role: 'owner' },
    );

    const input = provider.createCheckout.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.plan).toBe('agency');
    expect(input.interval).toBe('year');
    expect(input.metadata).toEqual({ organizationId: ORGANIZATION_ID });
    // Nothing resembling an amount travels: the provider adapter resolves the
    // price from configuration.
    expect(Object.keys(input)).not.toContain('price');
    expect(Object.keys(input)).not.toContain('amount');
  });

  it('changes no plan of its own — a checkout only produces a redirect', async () => {
    const { service, organizations } = harness();

    const result = await service.startCheckout(
      context(),
      { plan: 'agency', interval: 'month' },
      { id: 'u1', name: 'Owner', email: 'owner@example.com', role: 'owner' },
    );

    expect(result.url).toBe('https://checkout.example/session');
    expect(organizations.applySubscriptionState).not.toHaveBeenCalled();
  });

  it('sends an organization that already subscribes to the portal instead', async () => {
    const { service, provider } = harness({
      record: organizationRecord('agency', {
        customerId: 'cus_1',
        subscriptionId: 'sub_1',
        status: 'active',
      }),
    });

    const result = await service.startCheckout(
      context('agency'),
      { plan: 'starter', interval: 'month' },
      { id: 'u1', name: 'Owner', email: 'owner@example.com', role: 'owner' },
    );

    // A second checkout would leave two live subscriptions on one customer and
    // bill for both.
    expect(provider.createCheckout).not.toHaveBeenCalled();
    expect(result.url).toBe('https://portal.example/session');
  });
});

describe('BillingService.openPortal', () => {
  it('refuses before the organization has a billing account', async () => {
    const { service } = harness();

    await expect(
      service.openPortal(context(), { id: 'u1', name: 'Owner', role: 'owner' }),
    ).rejects.toMatchObject({ code: 'BILLING_NO_CUSTOMER' });
  });

  it('opens the portal against the stored customer, not anything supplied', async () => {
    const { service, provider } = harness({
      record: organizationRecord('agency', { customerId: 'cus_stored' }),
    });

    await service.openPortal(context('agency'), { id: 'u1', name: 'Owner', role: 'owner' });

    expect(provider.createPortal).toHaveBeenCalledWith({
      customerId: 'cus_stored',
      returnUrl: 'https://app.siteops.test/dashboard/billing',
    });
  });
});

describe('BillingService.handleWebhook', () => {
  it('applies a subscription to the organization named in the metadata', async () => {
    const { service, provider, organizations } = harness();
    provider.parseWebhook.mockReturnValue(webhookEvent());

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(organizations.applySubscriptionState).toHaveBeenCalledWith(
      ORGANIZATION_OBJECT_ID,
      expect.objectContaining({ plan: 'agency', status: 'active', subscriptionId: 'sub_1' }),
    );
  });

  it('does nothing at all for a duplicate delivery', async () => {
    const { service, provider, organizations } = harness({ claimed: false });
    provider.parseWebhook.mockReturnValue(webhookEvent());

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    // The claim is the whole idempotency guarantee. A retry must not re-apply.
    expect(organizations.applySubscriptionState).not.toHaveBeenCalled();
  });

  it('releases the claim when applying the event fails', async () => {
    const { service, provider, organizations, events } = harness();
    provider.parseWebhook.mockReturnValue(webhookEvent());
    organizations.applySubscriptionState.mockRejectedValue(new Error('database is down'));

    await expect(service.handleWebhook(Buffer.from('{}'), 'sig')).rejects.toThrow();

    // Without this, a transient failure would make the provider's retry look
    // like a duplicate and the subscription change would be lost for good.
    expect(events.release).toHaveBeenCalledWith('evt_1');
  });

  it('drops an organization back to the free plan when the subscription ends', async () => {
    const { service, provider, organizations } = harness({
      record: organizationRecord('agency', { customerId: 'cus_1', subscriptionId: 'sub_1' }),
    });
    provider.parseWebhook.mockReturnValue(
      webhookEvent({
        type: 'customer.subscription.deleted',
        subscription: providerSubscription({ status: 'canceled' }),
      }),
    );

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(organizations.applySubscriptionState).toHaveBeenCalledWith(
      ORGANIZATION_OBJECT_ID,
      expect.objectContaining({ plan: 'free', status: 'canceled' }),
    );
  });

  it('keeps the paid plan while a renewal is being retried', async () => {
    const { service, provider, organizations } = harness({
      record: organizationRecord('agency', { customerId: 'cus_1', subscriptionId: 'sub_1' }),
    });
    provider.parseWebhook.mockReturnValue(
      webhookEvent({ subscription: providerSubscription({ status: 'past_due' }) }),
    );

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    // Cutting a customer off at the first declined card turns a payment hiccup
    // into an outage in their monitoring.
    expect(organizations.applySubscriptionState).toHaveBeenCalledWith(
      ORGANIZATION_OBJECT_ID,
      expect.objectContaining({ plan: 'agency', status: 'past_due' }),
    );
  });

  it('refuses to guess a plan for a price it cannot map', async () => {
    const { service, provider, organizations } = harness({
      record: organizationRecord('agency', { customerId: 'cus_1', subscriptionId: 'sub_1' }),
    });
    provider.parseWebhook.mockReturnValue(
      webhookEvent({ subscription: providerSubscription({ plan: null, status: 'active' }) }),
    );

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    // Guessing would either downgrade someone who is paying or hand out a tier
    // nobody bought. Leaving it alone is the only safe answer.
    expect(organizations.applySubscriptionState).not.toHaveBeenCalled();
  });

  it('attaches the customer and stops for a completed checkout', async () => {
    const { service, provider, organizations } = harness();
    provider.parseWebhook.mockReturnValue(
      webhookEvent({
        type: 'checkout.session.completed',
        subscription: null,
        customerId: 'cus_new',
      }),
    );

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(organizations.attachBillingCustomer).toHaveBeenCalledWith(
      ORGANIZATION_OBJECT_ID,
      'cus_new',
    );
    // The subscription state arrives on its own event moments later. Writing a
    // plan from here would race it.
    expect(organizations.applySubscriptionState).not.toHaveBeenCalled();
  });

  it('acknowledges an event for a customer this deployment does not know', async () => {
    const { service, provider, organizations } = harness({ record: null });
    organizations.findByBillingCustomerId.mockResolvedValue(null);
    provider.parseWebhook.mockReturnValue(webhookEvent({ metadata: {} }));

    // One Stripe account can serve several deployments. An event that is not
    // ours is not an error.
    await expect(service.handleWebhook(Buffer.from('{}'), 'sig')).resolves.toBeUndefined();
    expect(organizations.applySubscriptionState).not.toHaveBeenCalled();
  });

  it('falls back to the customer mapping when metadata carries no organization', async () => {
    const { service, provider, organizations } = harness();
    provider.parseWebhook.mockReturnValue(webhookEvent({ metadata: {} }));

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(organizations.findByBillingCustomerId).toHaveBeenCalledWith('cus_1');
    expect(organizations.applySubscriptionState).toHaveBeenCalled();
  });

  it('passes the provider event time so a stale event can be discarded', async () => {
    const { service, provider, organizations } = harness();
    const eventAt = new Date('2025-06-01T00:00:00.000Z');
    provider.parseWebhook.mockReturnValue(webhookEvent({ createdAt: eventAt }));

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    // The repository refuses a write older than the last one applied; it can
    // only do that if the service hands it the provider's clock.
    expect(organizations.applySubscriptionState).toHaveBeenCalledWith(
      ORGANIZATION_OBJECT_ID,
      expect.objectContaining({ eventAt }),
    );
  });

  it('records no audit entry when the repository rejects a stale event', async () => {
    const { service, provider, audit } = harness({ applyResult: null });
    provider.parseWebhook.mockReturnValue(webhookEvent());

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    // Nothing changed, so the activity feed must not claim it did.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a webhook when no payment provider is configured', async () => {
    const { service } = harness({ withProvider: false });

    await expect(service.handleWebhook(Buffer.from('{}'), 'sig')).rejects.toMatchObject({
      code: 'BILLING_NOT_CONFIGURED',
    });
  });
});

describe('BillingService.describe', () => {
  it('reports a free organization that has never subscribed', async () => {
    const { service } = harness();
    const subscription = await service.describe(context());

    expect(subscription).toMatchObject({
      plan: 'free',
      status: 'none',
      interval: null,
      cancelAtPeriodEnd: false,
      billingConfigured: true,
      // No customer yet, so there is nothing for a portal to open against.
      canManage: false,
    });
  });

  it('reports a paid organization with its renewal date', async () => {
    const renewal = new Date('2026-03-01T00:00:00.000Z');
    const { service } = harness({
      record: organizationRecord('agency', {
        customerId: 'cus_1',
        subscriptionId: 'sub_1',
        status: 'active',
        interval: 'year',
        currentPeriodEnd: renewal,
      }),
    });

    const subscription = await service.describe(context('agency'));

    expect(subscription).toMatchObject({
      plan: 'agency',
      status: 'active',
      interval: 'year',
      currentPeriodEnd: renewal.toISOString(),
      canManage: true,
    });
  });

  it('reads an organization created before billing existed without failing', async () => {
    // `.lean()` returns what is stored, and a document written before the
    // billing subdocument existed simply has no such field.
    const legacy = organizationRecord() as unknown as Record<string, unknown>;
    delete legacy.billing;

    const { service } = harness({ record: legacy as unknown as OrganizationRecord });
    const subscription = await service.describe(context());

    expect(subscription.status).toBe('none');
    expect(subscription.canManage).toBe(false);
  });

  it('says so when the deployment has no payment provider', async () => {
    const { service } = harness({ withProvider: false });
    const subscription = await service.describe(context());

    expect(subscription.billingConfigured).toBe(false);
    expect(subscription.canManage).toBe(false);
  });
});

describe('plan catalogue consistency', () => {
  it('prices every plan the backend defines', () => {
    for (const plan of PLANS) {
      expect(PLAN_PRICING[plan]).toBeDefined();
    }
  });

  it('lists every non-free plan as purchasable', () => {
    // A paid plan missing from PURCHASABLE_PLANS could never be bought, and a
    // free plan present in it would open a zero-price checkout.
    expect([...PURCHASABLE_PLANS].sort()).toEqual([...PLANS].filter((p) => p !== 'free').sort());
  });

  it('discounts a yearly plan by exactly two months', () => {
    for (const plan of PURCHASABLE_PLANS) {
      expect(yearlyMonthsFree(plan)).toBe(2);
    }
  });

  it('charges nothing for the free plan', () => {
    expect(PLAN_PRICING.free.monthly).toBe(0);
    expect(PLAN_PRICING.free.yearly).toBe(0);
    expect(yearlyMonthsFree('free')).toBe(0);
  });

  it('prices plans in strictly increasing order', () => {
    const ladder: readonly Plan[] = ['free', 'starter', 'agency', 'pro'];
    for (let index = 1; index < ladder.length; index += 1) {
      const previous = ladder[index - 1]!;
      const current = ladder[index]!;
      expect(PLAN_PRICING[current].monthly).toBeGreaterThan(PLAN_PRICING[previous].monthly);
    }
  });
});

describe('isApiError contract', () => {
  it('reports billing refusals as ApiError so the handler can shape them', async () => {
    const { service } = harness({ withProvider: false });

    try {
      await service.describe(context());
      await service.handleWebhook(Buffer.from('{}'), 'sig');
      expect.unreachable('handleWebhook should have thrown');
    } catch (error) {
      expect(isApiError(error)).toBe(true);
    }
  });
});
