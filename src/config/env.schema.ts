import { z } from 'zod';

/**
 * The shape of a valid SiteOps process configuration.
 *
 * Kept free of side effects so it can be unit-tested and so `.env.example` can
 * be checked against it. `env.ts` is what actually reads the environment.
 *
 * One schema covers both processes. The API ignores the monitor settings and
 * the worker ignores most of the HTTP ones, but a single schema means one
 * `.env`, one place to look a variable up, and no way for the two to disagree
 * about what a shared value means.
 */

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const csvOrigins = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(z.array(z.url()).min(1));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    /** Public origin of the dashboard. Used for CORS, cookies and email links. */
    APP_URL: z.url(),
    /** Public origin of this API. Used to build absolute callback URLs. */
    API_URL: z.url(),
    /** Extra browser origins permitted by CORS, comma-separated. */
    ADDITIONAL_TRUSTED_ORIGINS: csvOrigins.optional(),

    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required.'),
    MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    /**
     * Applies every declared index at startup. Convenient locally and wrong in
     * production, where an index build issued by a starting process can stall a
     * live cluster; deployments run `pnpm indexes:sync` as an explicit step.
     */
    MONGODB_AUTO_INDEX: booleanFromEnv.default(false),

    /**
     * Signing key for sessions and email tokens. 32 bytes of entropy minimum —
     * generate with `openssl rand -base64 32`.
     */
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters.'),
    /** Set when the API and the dashboard are served from different hosts. */
    COOKIE_DOMAIN: z.string().min(1).optional(),

    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(3).default('SiteOps <onboarding@resend.dev>'),

    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(120),
    AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(10),

    /** Trust `X-Forwarded-For` only behind a proxy that actually sets it. */
    TRUST_PROXY: booleanFromEnv.default(false),

    /** Probe port. Most platforms treat a worker with no listening port as crashed. */
    WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(4001),
    /** How often the scheduler looks for websites that are due. */
    MONITOR_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(300).default(15),
    /** Websites checked simultaneously. Bounds outbound sockets and memory. */
    MONITOR_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(10),
    MONITOR_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(5),
    /** Attempts per scheduled check, including the first. Never retries forever. */
    MONITOR_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
    /** Delivery attempts for one alert email before it is recorded as failed. */
    NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    /**
     * Raw check retention, in days. This is also the TTL index's expiry, so a
     * change here only takes effect after `pnpm indexes:sync`.
     */
    CHECK_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),

    /** How often the worker looks for queued reports and due schedules. */
    REPORT_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    /** Reports built per tick. Each is a burst of aggregation, not a network call. */
    REPORT_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(3),

    /**
     * Google PageSpeed Insights API key.
     *
     * Optional. With it, the performance monitor gets real Lighthouse scores
     * and real Core Web Vitals from Google's own infrastructure. Without it,
     * the monitor falls back to server-side measurement, which reports time to
     * first byte, page weight and render-blocking resources but no Lighthouse
     * score and no LCP or CLS — see docs/MONITORING.md.
     */
    PAGESPEED_API_KEY: z.string().min(1).optional(),

    /* --- Billing ---------------------------------------------------------
     *
     * All optional. Without `STRIPE_SECRET_KEY` no payment provider is
     * constructed at all: the billing routes answer `BILLING_NOT_CONFIGURED`
     * and the dashboard says so plainly. That is the honest state for a
     * deployment that does not sell anything — the alternative, a stub that
     * returns fabricated checkout URLs and fake successes, is the one thing
     * billing code must never do.
     *
     * The price ids are per-deployment because Stripe's test mode and live mode
     * have different ones, and a plan with no configured price is simply not
     * sold there: the pricing page still describes it, checkout refuses it with
     * a clear message.
     */
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    /** Signing secret for the webhook endpoint, from the Stripe dashboard. */
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),

    STRIPE_PRICE_STARTER_MONTHLY: z.string().min(1).optional(),
    STRIPE_PRICE_STARTER_YEARLY: z.string().min(1).optional(),
    STRIPE_PRICE_AGENCY_MONTHLY: z.string().min(1).optional(),
    STRIPE_PRICE_AGENCY_YEARLY: z.string().min(1).optional(),
    STRIPE_PRICE_PRO_MONTHLY: z.string().min(1).optional(),
    STRIPE_PRICE_PRO_YEARLY: z.string().min(1).optional(),

    /**
     * Disables SSRF address filtering so the test suite can reach a mock server
     * on loopback. Enabling it in production would turn the worker into an open
     * proxy into the private network, so it is refused there outright.
     */
    MONITOR_ALLOW_PRIVATE_ADDRESSES: booleanFromEnv.default(false),
  })
  .superRefine((value, ctx) => {
    // Without a mail provider, verification links and outage alerts silently go
    // nowhere. Acceptable locally, never in production.
    if (value.NODE_ENV === 'production' && !value.RESEND_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY is required in production so emails can be delivered.',
      });
    }
    if (value.NODE_ENV === 'production' && value.APP_URL.startsWith('http://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_URL'],
        message: 'APP_URL must use https in production; session cookies are Secure-only.',
      });
    }
    /*
     * A secret key with no webhook secret is the worst of the three states: the
     * deployment can take money, and then has no verified way to learn that it
     * did. Every subscription would stay stuck at whatever it was when checkout
     * opened. Refused everywhere, not just in production, because it is just as
     * broken locally and far cheaper to notice here.
     */
    if (value.STRIPE_SECRET_KEY && !value.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_WEBHOOK_SECRET'],
        message:
          'STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set: without it no subscription change can be verified.',
      });
    }
    /*
     * A live key on a non-production build would charge real cards from a
     * developer machine or a staging environment. Test keys (`sk_test_`) are
     * unrestricted.
     */
    if (value.NODE_ENV !== 'production' && value.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_SECRET_KEY'],
        message: 'A live Stripe key must not be used outside production. Use a sk_test_ key.',
      });
    }
    if (value.NODE_ENV === 'production' && value.MONITOR_ALLOW_PRIVATE_ADDRESSES) {
      ctx.addIssue({
        code: 'custom',
        path: ['MONITOR_ALLOW_PRIVATE_ADDRESSES'],
        message:
          'MONITOR_ALLOW_PRIVATE_ADDRESSES must never be enabled in production: it disables SSRF protection.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;
