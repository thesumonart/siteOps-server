import { Resend } from 'resend';

import { env, isProduction } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import type { EmailDeliveryResult, EmailMessage } from './types.js';

const logger = createLogger('email');

/**
 * Transactional email delivery.
 *
 * Without `RESEND_API_KEY` the service logs the message instead of sending it,
 * so local development works without a provider account and a verification link
 * is still reachable from the terminal. That fallback is refused in production
 * by the environment schema — an outage nobody is told about is not monitoring.
 *
 * Delivery failures are reported, never thrown. A failed alert email must not
 * roll back the incident that triggered it.
 */
export class EmailService {
  private readonly resend: Resend | null = env.RESEND_API_KEY
    ? new Resend(env.RESEND_API_KEY)
    : null;

  get isConfigured(): boolean {
    return this.resend !== null;
  }

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    if (!this.resend) {
      // The body is omitted; only the actionable link is printed, and only
      // outside production.
      logger.warn(
        { to: message.to, subject: message.subject, preview: extractFirstUrl(message.text) },
        'email.not_configured',
      );
      return { delivered: false, reason: 'No email provider configured.' };
    }

    try {
      const response = await this.resend.emails.send({
        from: env.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });

      if (response.error) {
        logger.error(
          { to: message.to, subject: message.subject, reason: response.error.message },
          'email.failed',
        );
        return { delivered: false, reason: response.error.message, retryable: true };
      }

      logger.info(
        { to: message.to, subject: message.subject, providerId: response.data?.id },
        'email.sent',
      );
      return { delivered: true, providerId: response.data?.id };
    } catch (error) {
      logger.error({ to: message.to, subject: message.subject, err: error }, 'email.failed');
      return {
        delivered: false,
        reason: error instanceof Error ? error.message : 'Unknown delivery error.',
        // A thrown error is a transport failure — a socket, a timeout, a 5xx —
        // rather than the provider refusing the message, so it is worth
        // another attempt. A rejection carrying `response.error` above is
        // marked retryable too: Resend reports rate limiting that way, and
        // the caller's attempt cap is what stops a genuine refusal looping.
        retryable: true,
      };
    }
  }
}

/**
 * Pulls the action link out of the plain-text body for the development log.
 * Returns nothing in production, where links must never reach the log stream.
 */
function extractFirstUrl(text: string): string | undefined {
  if (isProduction) return undefined;
  const match = /https?:\/\/\S+/.exec(text);
  return match?.[0];
}
