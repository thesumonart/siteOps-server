import { Router, raw } from 'express';

import { BillingController } from '../controllers/billing.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { billingValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

/** Largest webhook body accepted. Stripe's are a few kB; this is generous. */
const WEBHOOK_BODY_LIMIT = '1mb';

/** The webhook route, relative to the `/api` prefix this router is mounted at. */
const WEBHOOK_ROUTE = '/billing/webhook';

/**
 * The same path as the application sees it.
 *
 * Exported because `app.ts` must exempt it from the global JSON parser, and a
 * second literal over there is exactly the kind of thing that drifts. See the
 * mounting note below for why the exemption is load-bearing.
 */
export const STRIPE_WEBHOOK_PATH = `/api${WEBHOOK_ROUTE}`;

/**
 * Plans, subscriptions and provider webhooks.
 *
 * The permission split is the product's, not an implementation detail:
 *
 * - **`/billing/plans`** takes no session at all. It is the marketing page's
 *   data and describes plans, never customers.
 * - **`billing:read`** — owners only, by `ROLE_PERMISSIONS`. What an
 *   organization pays is not something every member is entitled to see, unlike
 *   entitlements, which every role can read so a locked button can explain
 *   itself.
 * - **`billing:manage`** — owners only, and the reason an admin cannot start a
 *   checkout: committing the organization to a recurring charge is an
 *   ownership-level act.
 * - **`/billing/webhook`** has no session either, and is authorized by the
 *   signature on its body instead.
 */
export function billingRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const controller = new BillingController(dependencies.billingService);

  router.get('/billing/plans', controller.catalog);

  /*
   * Mounted with a raw body parser of its own, so the handler receives the
   * exact bytes the provider signed. Parsing and re-serialising would change
   * key order and whitespace, and the signature would never verify again — the
   * controller asserts it got a Buffer rather than trusting this stays true.
   *
   * This only works because `app.ts` exempts `STRIPE_WEBHOOK_PATH` from the
   * global `express.json()`. Express does not run "the first parser that claims
   * the request": body-parser marks a request as read, and a raw parser reached
   * after a JSON one skips silently. Registered globally without the exemption,
   * the JSON parser wins, the controller sees an object and refuses every
   * event — which is a total, silent billing outage, because this route is the
   * only writer of `organization.plan`.
   *
   * No rate limit: the provider decides how often it delivers, and throttling
   * it would turn a burst of legitimate events into lost subscription changes.
   * The signature check is the gate, and it is cheap.
   */
  router.post(
    WEBHOOK_ROUTE,
    raw({ type: 'application/json', limit: WEBHOOK_BODY_LIMIT }),
    asyncHandler(controller.webhook),
  );

  router.get(
    '/organizations/:organizationId/subscription',
    auth,
    validate(billingValidators.subscription),
    requireOrganization(dependencies.organizations, 'billing:read'),
    asyncHandler(controller.subscription),
  );

  /*
   * Rate limited tightly. Each call creates a session at the provider and
   * counts against their API budget, and no legitimate user opens more than a
   * handful in an hour.
   */
  router.post(
    '/organizations/:organizationId/billing/checkout',
    auth,
    rateLimit({ limit: 20, windowSeconds: 3600, scope: 'billing-checkout' }),
    validate(billingValidators.checkout),
    requireOrganization(dependencies.organizations, 'billing:manage'),
    asyncHandler(controller.checkout),
  );

  router.post(
    '/organizations/:organizationId/billing/portal',
    auth,
    rateLimit({ limit: 20, windowSeconds: 3600, scope: 'billing-portal' }),
    validate(billingValidators.portal),
    requireOrganization(dependencies.organizations, 'billing:manage'),
    asyncHandler(controller.portal),
  );

  return router;
}
