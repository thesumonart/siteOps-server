import type { Request, Response } from 'express';

import type { StartCheckoutInput } from '../contracts/index.js';
import { currentUser } from '../middlewares/auth.middleware.js';
import { currentOrganization } from '../middlewares/organization.middleware.js';
import { validatedBody } from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { BillingService } from '../services/billing.service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('billing');

/**
 * Subscription and plan HTTP handlers.
 *
 * Thin like every other controller here, with one route that is genuinely
 * different: {@link webhook} is the only handler in SiteOps with no session, no
 * organization context and no permission check. Its authorization *is* the
 * signature on the request body, verified inside the service before a single
 * field is read. That is why it takes a raw Buffer rather than a parsed body —
 * see the mounting order in `app.ts`.
 */
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /**
   * The public price list.
   *
   * Unauthenticated on purpose: the marketing page renders it before anyone has
   * an account, and it describes plans rather than customers. Nothing here
   * varies by caller.
   */
  catalog = (_request: Request, response: Response): void => {
    ApiResponse.ok(response, this.billing.catalog());
  };

  /** The active organization's subscription. Requires `billing:read`. */
  subscription = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    ApiResponse.ok(response, await this.billing.describe(organization));
  };

  /**
   * Starts a checkout and answers with the URL to send the browser to.
   *
   * The response is a redirect target rather than a 302 because the caller is
   * `fetch` from the dashboard, which would follow a redirect into a cross-origin
   * HTML page it cannot do anything with.
   */
  checkout = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const input = validatedBody<StartCheckoutInput>(request);

    const redirect = await this.billing.startCheckout(organization, input, {
      id: user.id,
      name: user.name,
      email: user.email,
      role: organization.role,
    });

    ApiResponse.ok(response, redirect);
  };

  /** Opens the provider's management portal for the active organization. */
  portal = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);

    const redirect = await this.billing.openPortal(organization, {
      id: user.id,
      name: user.name,
      role: organization.role,
    });

    ApiResponse.ok(response, redirect);
  };

  /**
   * Receives a provider webhook.
   *
   * Answers 200 as soon as the event is applied, and — deliberately — also for
   * an event this deployment does not recognise. A 4xx tells the provider to
   * retry something we will never act on, and enough of those get the endpoint
   * disabled for the events that matter.
   *
   * A genuine failure still propagates: a bad signature is a 400 and a database
   * failure a 500, both of which the provider *should* retry.
   */
  webhook = async (request: Request, response: Response): Promise<void> => {
    const signature = request.header('stripe-signature');

    /*
     * `express.raw` leaves the body as a Buffer. Anything else means the route
     * was mounted after a JSON parser, at which point the bytes that were
     * signed no longer exist and verification is meaningless — so this refuses
     * rather than verifying a re-serialisation of the payload.
     */
    if (!Buffer.isBuffer(request.body)) {
      logger.error('billing.webhook_body_not_raw');
      response.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Webhook receiver is misconfigured.',
        },
      });
      return;
    }

    await this.billing.handleWebhook(request.body, signature);
    response.status(200).json({ success: true, data: { received: true } });
  };
}
