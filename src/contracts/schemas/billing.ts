import { z } from 'zod';

import { BILLING_INTERVALS, PURCHASABLE_PLANS } from '../domain/billing.js';

/**
 * What a caller may say when starting a checkout.
 *
 * Note what is absent: no price, no amount, no currency, no customer, no
 * quantity, no trial length. The request names a plan and an interval, and the
 * server looks up the provider price for that pair from its own configuration.
 * There is nothing here to tamper with — a caller cannot buy the Agency plan at
 * the Professional price because the price never travels.
 *
 * `free` is excluded from the enum rather than rejected later, so a checkout
 * for a zero-price plan fails at validation with a field error instead of
 * reaching the provider.
 */
export const startCheckoutSchema = z.object({
  plan: z.enum(PURCHASABLE_PLANS),
  interval: z.enum(BILLING_INTERVALS).default('month'),
});

export type StartCheckoutFormValues = z.input<typeof startCheckoutSchema>;
export type StartCheckoutInput = z.infer<typeof startCheckoutSchema>;
