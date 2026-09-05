/**
 * Transport-agnostic email shapes.
 *
 * Templates produce an {@link EmailContent}; the service decides how it is
 * delivered. Keeping the two apart means a template can be unit-tested without
 * a mail provider, and the provider can be swapped without touching copy.
 */

export interface EmailContent {
  readonly subject: string;
  readonly html: string;
  /**
   * Plain-text alternative. Always provided: a text/plain part materially
   * improves deliverability and is what some clients actually render.
   */
  readonly text: string;
}

export interface EmailMessage extends EmailContent {
  readonly to: string;
}

export interface EmailDeliveryResult {
  readonly delivered: boolean;
  readonly providerId?: string;
  readonly reason?: string;
  /**
   * Whether another attempt could plausibly succeed.
   *
   * False for a message that was never going to be sent — no provider is
   * configured — so the caller records the failure instead of burning its whole
   * retry budget on a configuration problem.
   */
  readonly retryable?: boolean;
}
