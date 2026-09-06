import type {
  DomainCheckData,
  DomainMonitorConfig,
  MonitorFinding,
} from '../../contracts/index.js';
import {
  DEFAULT_DOMAIN_CRITICAL_DAYS,
  DEFAULT_DOMAIN_WARNING_DAYS,
} from '../../contracts/index.js';
import { createRdapProvider } from '../domain/rdap-provider.js';
import {
  lookupRegistration,
  registrableCandidates,
  type DomainRegistrationProvider,
} from '../domain/registration-provider.js';
import { createWhoisProvider } from '../domain/whois-provider.js';
import {
  monitorError,
  type MonitorRunContext,
  type MonitorRunResult,
  type MonitorRunner,
} from '../monitor-runner.js';

/**
 * The domain expiry monitor.
 *
 * A lapsed domain is the most expensive failure a small business can have: the
 * site, the email and often the ability to reset passwords all stop at once,
 * and recovery can take weeks. So the warning windows are much wider than for a
 * certificate, and a domain in the critical window is `failing` rather than
 * `warning` — at that point somebody has to act, not be informed.
 *
 * A lookup that cannot answer is `error`, never `passing`. Reporting "no expiry
 * known" as healthy would silently clear a warning that is still true, and this
 * is precisely the monitor where a false reassurance is most costly.
 */

function emptyData(domain: string): DomainCheckData {
  return {
    domain,
    registrar: null,
    registeredAt: null,
    expiresAt: null,
    daysRemaining: null,
    statuses: [],
    nameServers: [],
    source: 'none',
  };
}

function configOf(context: MonitorRunContext): DomainMonitorConfig {
  const config = context.monitor.config;
  return config.type === 'domain'
    ? config
    : { warningDays: DEFAULT_DOMAIN_WARNING_DAYS, criticalDays: DEFAULT_DOMAIN_CRITICAL_DAYS };
}

function daysUntil(date: Date, now: Date): number {
  return Math.floor((date.getTime() - now.getTime()) / 86_400_000);
}

export interface DomainRunnerOptions {
  /**
   * Providers, in the order they are asked.
   *
   * Injected rather than constructed inside, so a test can supply a fake
   * registry and so a deployment can put a paid API in front of the free ones
   * without changing this file.
   */
  readonly providers?: readonly DomainRegistrationProvider[];
}

export function createDomainRunner(options: DomainRunnerOptions = {}): MonitorRunner {
  const providers = options.providers ?? [createRdapProvider(), createWhoisProvider()];

  return {
    type: 'domain',

    async run(context: MonitorRunContext): Promise<MonitorRunResult> {
      const config = configOf(context);

      let hostname: string;
      try {
        hostname = new URL(context.monitor.websiteUrl).hostname;
      } catch {
        return monitorError('The website URL could not be parsed.', {
          type: 'domain',
          ...emptyData(''),
        });
      }

      const candidates = registrableCandidates(hostname);
      if (candidates.length === 0) {
        return monitorError(`${hostname} is not a registrable domain name.`, {
          type: 'domain',
          ...emptyData(hostname),
        });
      }

      /*
       * Walk the candidates from the shortest (`example.com`) outwards until a
       * registry recognises one. This is what stands in for a public suffix
       * list: `www.example.co.uk` fails at `co.uk` (not registrable) and
       * succeeds at `example.co.uk`, with the registry itself as the authority.
       */
      let lastReason = 'No registry recognised this domain.';
      for (const candidate of candidates) {
        const result = await lookupRegistration(providers, candidate, {
          timeoutMs: context.timeoutMs,
        });

        if (result.outcome === 'found') {
          return evaluate(result.registration, config, context.now);
        }
        if (result.outcome !== 'not_found') lastReason = result.reason;
      }

      return monitorError(lastReason, {
        type: 'domain',
        ...emptyData(candidates[0] ?? hostname),
      });
    },
  };
}

function evaluate(
  registration: {
    readonly domain: string;
    readonly registrar: string | null;
    readonly registeredAt: Date | null;
    readonly expiresAt: Date | null;
    readonly statuses: readonly string[];
    readonly nameServers: readonly string[];
    readonly source: string;
  },
  config: DomainMonitorConfig,
  now: Date,
): MonitorRunResult {
  const daysRemaining = registration.expiresAt ? daysUntil(registration.expiresAt, now) : null;

  const data: DomainCheckData = {
    domain: registration.domain,
    registrar: registration.registrar,
    registeredAt: registration.registeredAt?.toISOString() ?? null,
    expiresAt: registration.expiresAt?.toISOString() ?? null,
    daysRemaining,
    statuses: registration.statuses,
    nameServers: registration.nameServers,
    source: registration.source,
  };

  const findings: MonitorFinding[] = [];

  /*
   * A registry lock is the opposite of a problem — it is what stops a domain
   * being transferred out from under its owner — so its *absence* on a domain
   * that is otherwise healthy is worth a notice, not its presence.
   */
  const locked = registration.statuses.some((status) =>
    status.toLowerCase().includes('transferprohibited'),
  );
  if (!locked && registration.statuses.length > 0) {
    findings.push({
      code: 'domain.transfer_unlocked',
      severity: 'notice',
      message: 'The domain is not transfer-locked at the registrar.',
      detail: registration.statuses.slice(0, 3).join(', '),
    });
  }

  if (daysRemaining === null) {
    findings.push({
      code: 'domain.no_expiry',
      severity: 'warning',
      message: 'The registry did not publish an expiry date for this domain.',
      detail: registration.source,
    });

    return {
      status: 'warning',
      summary: 'The registry did not publish an expiry date.',
      data: { type: 'domain', ...data },
      findings,
    };
  }

  if (daysRemaining < 0) {
    findings.push({
      code: 'domain.expired',
      severity: 'critical',
      message: `The registration lapsed ${String(Math.abs(daysRemaining))} days ago.`,
      detail: data.expiresAt,
    });
    return {
      status: 'failing',
      summary: `Registration lapsed ${String(Math.abs(daysRemaining))} days ago.`,
      data: { type: 'domain', ...data },
      findings,
    };
  }

  if (daysRemaining <= config.criticalDays) {
    findings.push({
      code: 'domain.expiring_critical',
      severity: 'critical',
      message: `The registration expires in ${String(daysRemaining)} days.`,
      detail: data.expiresAt,
    });
    return {
      status: 'failing',
      summary: `Registration expires in ${String(daysRemaining)} days — renew now.`,
      data: { type: 'domain', ...data },
      findings,
    };
  }

  if (daysRemaining <= config.warningDays) {
    findings.push({
      code: 'domain.expiring_soon',
      severity: 'warning',
      message: `The registration expires in ${String(daysRemaining)} days.`,
      detail: data.expiresAt,
    });
    return {
      status: 'warning',
      summary: `Registration expires in ${String(daysRemaining)} days.`,
      data: { type: 'domain', ...data },
      findings,
    };
  }

  return {
    status: 'passing',
    summary: registration.registrar
      ? `Registered with ${registration.registrar}, ${String(daysRemaining)} days remaining.`
      : `${String(daysRemaining)} days remaining.`,
    data: { type: 'domain', ...data },
    findings,
  };
}
