import type { MonitorFinding, SslCheckData, SslMonitorConfig } from '../../contracts/index.js';
import { DEFAULT_SSL_CRITICAL_DAYS, DEFAULT_SSL_WARNING_DAYS } from '../../contracts/index.js';
import {
  monitorError,
  worstStatus,
  type MonitorRunContext,
  type MonitorRunResult,
  type MonitorRunner,
} from '../monitor-runner.js';
import { checkSslCertificate } from '../ssl-checker.js';

/**
 * The SSL certificate monitor.
 *
 * Reports three separable things, because they fail for different reasons and
 * are fixed by different people: whether the chain verifies, whether the
 * certificate covers the hostname, and how long is left before it expires.
 *
 * Expiry is the one that matters most in practice. A certificate that has
 * already lapsed is `failing`; one inside the critical window is also
 * `failing`, because at that point automation has demonstrably not worked and
 * the site is days from an outage every visitor will see. The warning window is
 * `warning`.
 */

const EMPTY_DATA: SslCheckData = {
  valid: false,
  issuer: null,
  subject: null,
  validFrom: null,
  validTo: null,
  daysRemaining: null,
  hostnameMatches: false,
  selfSigned: false,
  protocol: null,
  keyAlgorithm: null,
  serialNumber: null,
  subjectAlternativeNames: [],
  validationError: null,
};

function configOf(context: MonitorRunContext): SslMonitorConfig {
  const config = context.monitor.config;
  return config.type === 'ssl'
    ? config
    : // Unreachable in normal operation — the queue only hands an SSL monitor to
      // this runner — but a mismatched document must not crash the worker.
      { warningDays: DEFAULT_SSL_WARNING_DAYS, criticalDays: DEFAULT_SSL_CRITICAL_DAYS };
}

function describeDaysRemaining(days: number): string {
  if (days < 0) return `Certificate expired ${String(Math.abs(days))} days ago`;
  if (days === 0) return 'Certificate expires today';
  if (days === 1) return 'Certificate expires tomorrow';
  return `Certificate expires in ${String(days)} days`;
}

export function createSslRunner(): MonitorRunner {
  return {
    type: 'ssl',

    async run(context: MonitorRunContext): Promise<MonitorRunResult> {
      const config = configOf(context);

      const outcome = await checkSslCertificate(
        context.monitor.websiteUrl,
        { timeoutMs: context.timeoutMs, allowLoopback: context.allowLoopback },
        context.now,
      );

      if (!outcome.ok) {
        /*
         * A site served over plain HTTP has no certificate, which is a settled
         * fact rather than a failed check — reporting it as `error` would show
         * a permanently broken monitor and hide the actual advice, which is to
         * move to HTTPS.
         */
        if (outcome.reason.includes('not served over HTTPS')) {
          return {
            status: 'failing',
            summary: 'This website is not served over HTTPS.',
            data: { type: 'ssl', ...EMPTY_DATA },
            findings: [
              {
                code: 'ssl.no_https',
                severity: 'critical',
                message: 'The website is served over plain HTTP, so there is no certificate.',
                detail: context.monitor.websiteUrl,
              },
            ],
          };
        }

        return monitorError(outcome.reason, { type: 'ssl', ...EMPTY_DATA });
      }

      const data = outcome.data;
      const findings: MonitorFinding[] = [];
      const statuses: ('passing' | 'warning' | 'failing')[] = [];

      if (!data.hostnameMatches) {
        findings.push({
          code: 'ssl.hostname_mismatch',
          severity: 'critical',
          message: 'The certificate does not cover this hostname.',
          detail:
            data.subjectAlternativeNames.length > 0
              ? `Covers ${data.subjectAlternativeNames.slice(0, 5).join(', ')}`
              : null,
        });
        statuses.push('failing');
      }

      if (data.validationError !== null && data.hostnameMatches) {
        findings.push({
          code: data.selfSigned ? 'ssl.self_signed' : 'ssl.chain_invalid',
          severity: 'critical',
          message: data.selfSigned
            ? 'The certificate is self-signed, so browsers will refuse it.'
            : 'The certificate chain could not be verified.',
          detail: data.validationError,
        });
        statuses.push('failing');
      }

      if (data.daysRemaining === null) {
        findings.push({
          code: 'ssl.no_expiry',
          severity: 'warning',
          message: 'The certificate did not state a validity period that could be read.',
          detail: null,
        });
        statuses.push('warning');
      } else if (data.daysRemaining < 0) {
        findings.push({
          code: 'ssl.expired',
          severity: 'critical',
          message: describeDaysRemaining(data.daysRemaining),
          detail: data.validTo,
        });
        statuses.push('failing');
      } else if (data.daysRemaining <= config.criticalDays) {
        findings.push({
          code: 'ssl.expiring_critical',
          severity: 'critical',
          message: `${describeDaysRemaining(data.daysRemaining)}, inside the ${String(config.criticalDays)}-day critical window.`,
          detail: data.validTo,
        });
        statuses.push('failing');
      } else if (data.daysRemaining <= config.warningDays) {
        findings.push({
          code: 'ssl.expiring_soon',
          severity: 'warning',
          message: `${describeDaysRemaining(data.daysRemaining)}, inside the ${String(config.warningDays)}-day warning window.`,
          detail: data.validTo,
        });
        statuses.push('warning');
      }

      const status = worstStatus(...(statuses.length > 0 ? statuses : (['passing'] as const)));

      return {
        status,
        summary: summarise(data, status),
        data: { type: 'ssl', ...data },
        findings,
      };
    },
  };
}

function summarise(data: SslCheckData, status: string): string {
  if (status === 'passing') {
    const issuer = data.issuer ? ` from ${data.issuer}` : '';
    return data.daysRemaining === null
      ? `Certificate is valid${issuer}.`
      : `Valid${issuer}, ${String(data.daysRemaining)} days remaining.`;
  }

  if (!data.hostnameMatches) return 'The certificate does not cover this hostname.';
  if (data.daysRemaining !== null && data.daysRemaining < 0) {
    return describeDaysRemaining(data.daysRemaining) + '.';
  }
  if (data.validationError) return data.validationError;
  return data.daysRemaining === null
    ? 'The certificate could not be fully verified.'
    : `${describeDaysRemaining(data.daysRemaining)}.`;
}
