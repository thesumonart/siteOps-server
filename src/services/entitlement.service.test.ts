import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { Plan } from '../contracts/index.js';
import { isApiError } from '../errors/ApiError.js';
import type { OrganizationContext } from '../types/common.types.js';
import { EntitlementService, type UsageCounters } from './entitlement.service.js';

/**
 * Plan enforcement, tested against the real plan table rather than a fixture.
 *
 * The point of these cases is not that the numbers are right — those are data —
 * but that a refusal happens *at all*, carries `PLAN_LIMIT_REACHED` so the
 * dashboard can offer an upgrade rather than showing a generic failure, and
 * names the cheapest plan that would allow it.
 */

function organization(plan: Plan): OrganizationContext {
  return {
    id: '507f1f77bcf86cd799439011',
    objectId: new Types.ObjectId('507f1f77bcf86cd799439011'),
    name: 'Test',
    slug: 'test',
    plan,
    role: 'owner',
    permissions: [],
    clientScope: null,
  };
}

function counters(overrides: Partial<Record<keyof UsageCounters, number>> = {}): UsageCounters {
  const zero = (): Promise<number> => Promise.resolve(0);
  const at = (key: keyof UsageCounters): (() => Promise<number>) => {
    const value = overrides[key];
    return value === undefined ? zero : () => Promise.resolve(value);
  };

  return {
    websites: at('websites'),
    members: at('members'),
    clients: at('clients'),
    statusPages: at('statusPages'),
    apiKeys: at('apiKeys'),
    integrations: at('integrations'),
    reportSchedules: at('reportSchedules'),
    customDomains: at('customDomains'),
    apiRequestsToday: at('apiRequestsToday'),
    aiGenerationsThisMonth: at('aiGenerationsThisMonth'),
  };
}

function expectPlanLimit(action: () => unknown): { message: string } {
  try {
    action();
  } catch (error) {
    if (!isApiError(error)) throw error;
    expect(error.code).toBe('PLAN_LIMIT_REACHED');
    expect(error.statusCode).toBe(403);
    return { message: error.message };
  }
  throw new Error('Expected a plan-limit refusal, but the call succeeded.');
}

describe('EntitlementService.assertFeature', () => {
  it('allows a feature the plan includes', () => {
    const service = new EntitlementService(counters());
    expect(() => {
      service.assertFeature(organization('agency'), 'clients');
    }).not.toThrow();
  });

  it('refuses a feature the plan does not include, naming the cheapest plan that has it', () => {
    const service = new EntitlementService(counters());
    const { message } = expectPlanLimit(() => {
      service.assertFeature(organization('free'), 'clients');
    });

    // Agency is the cheapest tier with client management, so a Free
    // organization must be pointed at Agency rather than at Pro.
    expect(message).toContain('Agency');
    expect(message).not.toContain('Pro');
  });

  it('gates every agency feature away from the free plan', () => {
    const service = new EntitlementService(counters());
    const free = organization('free');

    for (const feature of ['clients', 'white_label', 'api_access', 'ai_insights'] as const) {
      expectPlanLimit(() => {
        service.assertFeature(free, feature);
      });
    }
  });
});

describe('EntitlementService.assertWithinLimit', () => {
  it('allows a create that stays within the limit', async () => {
    const service = new EntitlementService(counters({ websites: 2 }));
    await expect(
      service.assertWithinLimit(organization('free'), 'maxWebsites'),
    ).resolves.toBeUndefined();
  });

  it('refuses the create that would exceed the limit', async () => {
    const service = new EntitlementService(counters({ websites: 3 }));

    await expect(
      service.assertWithinLimit(organization('free'), 'maxWebsites'),
    ).rejects.toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
  });

  it('refuses outright when the plan allows none of the resource', async () => {
    const service = new EntitlementService(counters());

    await expect(
      service.assertWithinLimit(organization('free'), 'maxClients'),
    ).rejects.toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
  });

  it('does not query a counter for a resource the plan excludes', async () => {
    const clients = vi.fn(() => Promise.resolve(0));
    const service = new EntitlementService({ ...counters(), clients });

    await expect(service.assertWithinLimit(organization('free'), 'maxClients')).rejects.toThrow();
    // The refusal is decided by the plan alone, so the database is never asked.
    expect(clients).not.toHaveBeenCalled();
  });

  it('accounts for a bulk create through `additional`', async () => {
    const service = new EntitlementService(counters({ websites: 1 }));
    const free = organization('free');

    await expect(
      service.assertWithinLimit(free, 'maxWebsites', { additional: 2 }),
    ).resolves.toBeUndefined();
    await expect(
      service.assertWithinLimit(free, 'maxWebsites', { additional: 3 }),
    ).rejects.toThrow();
  });

  it('scopes the counter query to the organization being checked', async () => {
    const websites = vi.fn(() => Promise.resolve(0));
    const service = new EntitlementService({ ...counters(), websites });
    const context = organization('free');

    await service.assertWithinLimit(context, 'maxWebsites');

    expect(websites).toHaveBeenCalledWith(context.objectId);
  });
});

describe('EntitlementService.describe', () => {
  it('reports the plan, its features, its limits and current usage', async () => {
    const service = new EntitlementService(counters({ websites: 4, members: 2 }));

    const described = await service.describe(organization('agency'));

    expect(described.plan).toBe('agency');
    expect(described.features).toContain('clients');
    expect(described.limits.maxWebsites).toBe(50);
    expect(described.usage.websites).toBe(4);
    expect(described.usage.members).toBe(2);
  });
});
