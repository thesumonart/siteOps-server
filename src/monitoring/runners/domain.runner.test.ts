import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DomainCheckData, MonitorConfig } from '../../contracts/index.js';
import type { ClaimedMonitor } from '../../queues/monitor.queue.js';
import { parsePublicSuffixList, seedPublicSuffixRules } from '../domain/reference-data.js';
import type {
  DomainLookupResult,
  DomainRegistrationProvider,
} from '../domain/registration-provider.js';
import type { MonitorRunContext } from '../monitor-runner.js';
import { createDomainRunner } from './domain.runner.js';

/**
 * The domain monitor's verdicts.
 *
 * The distinction these cases exist to protect is between "the registry says
 * this expires soon" and "the registry did not answer". A lapsed domain takes a
 * business offline entirely and can take weeks to recover, so a lookup failure
 * reported as healthy would be the most expensive bug in the product.
 */

const NOW = new Date('2026-01-01T00:00:00Z');

/**
 * A miniature Public Suffix List, seeded so no test reaches the network.
 *
 * Written in the real file's format and parsed by the real parser, so the
 * section markers and rule syntax are exercised rather than assumed.
 */
const SUFFIX_FIXTURE = [
  '// ===BEGIN ICANN DOMAINS===',
  'com',
  'uk',
  'co.uk',
  'dev',
  '*.bd',
  'ck',
  '*.ck',
  '!www.ck',
  '// ===END ICANN DOMAINS===',
  '// ===BEGIN PRIVATE DOMAINS===',
  'github.io',
  '// ===END PRIVATE DOMAINS===',
].join('\n');

function provider(result: DomainLookupResult): DomainRegistrationProvider {
  return { name: 'test', lookup: () => Promise.resolve(result) };
}

function found(expiresAt: string | null, statuses: readonly string[] = []): DomainLookupResult {
  return {
    outcome: 'found',
    registration: {
      domain: 'example.com',
      registrar: 'Example Registrar',
      registeredAt: new Date('2010-01-01T00:00:00Z'),
      expiresAt: expiresAt === null ? null : new Date(expiresAt),
      statuses,
      nameServers: ['ns1.example.com'],
      source: 'test',
    },
  };
}

function context(
  config?: Partial<{ warningDays: number; criticalDays: number }>,
): MonitorRunContext {
  const monitorConfig: MonitorConfig = {
    type: 'domain',
    warningDays: config?.warningDays ?? 45,
    criticalDays: config?.criticalDays ?? 14,
  };

  const monitor: ClaimedMonitor = {
    id: new Types.ObjectId(),
    organizationId: new Types.ObjectId(),
    websiteId: new Types.ObjectId(),
    type: 'domain',
    intervalSeconds: 86_400,
    config: monitorConfig,
    currentIncidentId: null,
    consecutiveErrors: 0,
    websiteName: 'Example',
    websiteUrl: 'https://www.example.com/',
    websitePaused: false,
  };

  return { monitor, allowLoopback: false, userAgent: 'test', timeoutMs: 5000, now: NOW };
}

function dataOf(result: { data: unknown }): DomainCheckData {
  return result.data as DomainCheckData;
}

describe('domain runner', () => {
  beforeEach(() => {
    seedPublicSuffixRules(parsePublicSuffixList(SUFFIX_FIXTURE));
  });

  afterEach(() => {
    // Left seeded as null rather than cleared: an unseeded cache would let a
    // later test silently fetch the real list over the network.
    seedPublicSuffixRules(null);
  });

  it('passes a registration comfortably in the future', async () => {
    const runner = createDomainRunner({ providers: [provider(found('2027-06-01T00:00:00Z'))] });

    const result = await runner.run(context());

    expect(result.status).toBe('passing');
    expect(dataOf(result).daysRemaining).toBeGreaterThan(45);
    expect(result.summary).toContain('Example Registrar');
  });

  it('warns inside the warning window', async () => {
    // 30 days out: inside the 45-day warning window, outside the 14-day one.
    const runner = createDomainRunner({ providers: [provider(found('2026-01-31T00:00:00Z'))] });

    const result = await runner.run(context());

    expect(result.status).toBe('warning');
    expect(result.findings.some((finding) => finding.code === 'domain.expiring_soon')).toBe(true);
  });

  it('fails inside the critical window, because somebody has to act', async () => {
    const runner = createDomainRunner({ providers: [provider(found('2026-01-10T00:00:00Z'))] });

    const result = await runner.run(context());

    expect(result.status).toBe('failing');
    expect(result.findings.some((finding) => finding.code === 'domain.expiring_critical')).toBe(
      true,
    );
  });

  it('fails for a registration that has already lapsed', async () => {
    const runner = createDomainRunner({ providers: [provider(found('2025-12-01T00:00:00Z'))] });

    const result = await runner.run(context());

    expect(result.status).toBe('failing');
    expect(dataOf(result).daysRemaining).toBeLessThan(0);
    expect(result.summary).toContain('lapsed');
  });

  it('honours configured thresholds', async () => {
    const runner = createDomainRunner({ providers: [provider(found('2026-01-31T00:00:00Z'))] });

    // With a 10-day warning window, 30 days out is fine.
    const result = await runner.run(context({ warningDays: 10, criticalDays: 5 }));

    expect(result.status).toBe('passing');
  });

  it('reports an unanswerable lookup as an error, never as passing', async () => {
    const runner = createDomainRunner({
      providers: [provider({ outcome: 'error', reason: 'The registry timed out.' })],
    });

    const result = await runner.run(context());

    // This is the case that must never read as healthy: nothing was learned, so
    // an open expiry incident has to stay open.
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('timed out');
  });

  it('reports an unregistered name as failing, with its own wording', async () => {
    const runner = createDomainRunner({ providers: [provider({ outcome: 'not_found' })] });

    const result = await runner.run(context());

    /*
     * Every registry that answered agreed the name is not registered. For a
     * site someone is actively monitoring that is the most serious verdict this
     * monitor has — it is not "we could not find out", and filing it under
     * `error` would bury it among transient registry outages.
     */
    expect(result.status).toBe('failing');
    expect(result.summary).toContain('not registered');
    expect(result.findings.some((finding) => finding.code === 'domain.not_registered')).toBe(true);
  });

  it('keeps a genuine lookup failure distinct from an unregistered name', async () => {
    const runner = createDomainRunner({
      providers: [provider({ outcome: 'unsupported', reason: 'No RDAP service for this TLD.' })],
    });

    const result = await runner.run(context());

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('No RDAP service');
  });

  it('warns when the registry publishes no expiry date at all', async () => {
    const runner = createDomainRunner({ providers: [provider(found(null))] });

    const result = await runner.run(context());

    // Not `passing`: an unknown expiry is not a healthy one. Not `error`
    // either: the registry answered, it simply does not publish the date.
    expect(result.status).toBe('warning');
    expect(result.findings.some((finding) => finding.code === 'domain.no_expiry')).toBe(true);
  });

  it('notes an unlocked domain without treating it as a failure', async () => {
    const runner = createDomainRunner({
      providers: [provider(found('2027-06-01T00:00:00Z', ['ok']))],
    });

    const result = await runner.run(context());

    expect(result.status).toBe('passing');
    const notice = result.findings.find((finding) => finding.code === 'domain.transfer_unlocked');
    expect(notice?.severity).toBe('notice');
  });

  it('does not note a lock when the domain has one', async () => {
    const runner = createDomainRunner({
      providers: [provider(found('2027-06-01T00:00:00Z', ['clientTransferProhibited']))],
    });

    const result = await runner.run(context());

    expect(result.findings.some((finding) => finding.code === 'domain.transfer_unlocked')).toBe(
      false,
    );
  });

  it('errors on a URL with no registrable domain', async () => {
    const runner = createDomainRunner({ providers: [provider(found('2027-06-01T00:00:00Z'))] });
    const base = context();
    const monitor = { ...base.monitor, websiteUrl: 'https://localhost:3000/' };

    const result = await runner.run({ ...base, monitor });

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('not a registrable domain');
  });

  it('asks for the registrable domain directly, and only that', async () => {
    const asked = recordingProvider();
    const runner = createDomainRunner({ providers: [asked.provider] });
    const base = context();
    const monitor = { ...base.monitor, websiteUrl: 'https://shop.example.co.uk/' };

    const result = await runner.run({ ...base, monitor });

    expect(result.status).toBe('passing');
    // One request, and it names the right thing. `co.uk` is never asked about,
    // because the suffix list already knows it is a suffix — which matters:
    // Nominet answers HTTP 200 for `co.uk` with a registrar and no expiry, so
    // asking would produce a confident wrong answer rather than a miss.
    expect(asked.domains).toEqual(['example.co.uk']);
  });

  it('keeps a multi-level ccTLD whole', async () => {
    const asked = recordingProvider();
    const runner = createDomainRunner({ providers: [asked.provider] });
    const base = context();
    const monitor = { ...base.monitor, websiteUrl: 'https://www.shop.example.com.bd/' };

    await runner.run({ ...base, monitor });

    // `*.bd` makes `com.bd` the suffix, so the registrable name is three
    // labels — not the last two.
    expect(asked.domains).toEqual(['example.com.bd']);
  });

  it('falls back to walking labels when the suffix list is unavailable', async () => {
    seedPublicSuffixRules(null);

    const asked: string[] = [];
    const walking: DomainRegistrationProvider = {
      name: 'walking',
      lookup: (domain) => {
        asked.push(domain);
        /*
         * Reproduces what Nominet actually returns: `co.uk` is a real RDAP
         * object with a registrar and no dates. Believing it is the bug this
         * fallback has to survive, so the runner must keep walking and settle
         * on the dated answer.
         */
        if (domain === 'co.uk') {
          return Promise.resolve<DomainLookupResult>({
            outcome: 'found',
            registration: {
              domain: 'co.uk',
              registrar: 'Nominet UK',
              registeredAt: null,
              expiresAt: null,
              statuses: [],
              nameServers: [],
              source: 'test',
            },
          });
        }
        return Promise.resolve(
          domain === 'example.co.uk' ? found('2027-06-01T00:00:00Z') : { outcome: 'not_found' },
        );
      },
    };

    const runner = createDomainRunner({ providers: [walking] });
    const base = context();
    const monitor = { ...base.monitor, websiteUrl: 'https://shop.example.co.uk/' };

    const result = await runner.run({ ...base, monitor });

    expect(asked).toEqual(['co.uk', 'example.co.uk']);
    expect(result.status).toBe('passing');
    expect(dataOf(result).domain).toBe('example.com');
    expect(dataOf(result).expiresAt).not.toBeNull();
  });
});

/** A provider that records what it was asked and always answers. */
function recordingProvider(): {
  readonly provider: DomainRegistrationProvider;
  readonly domains: string[];
} {
  const domains: string[] = [];
  return {
    domains,
    provider: {
      name: 'recording',
      lookup: (domain) => {
        domains.push(domain);
        return Promise.resolve(found('2027-06-01T00:00:00Z'));
      },
    },
  };
}
