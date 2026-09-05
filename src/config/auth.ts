import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../contracts/index.js';
import { getMongoDb } from '../database/connection.js';
import type { EmailService } from '../email/email.service.js';
import { resetPasswordTemplate, verifyEmailTemplate } from '../email/templates/index.js';
import { createLogger } from '../utils/logger.js';
import { env, isProduction, trustedOrigins } from './env.js';

const logger = createLogger('auth');

/** Base path the auth routes are mounted at, including the API prefix. */
export const AUTH_BASE_PATH = '/api/auth';

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_REFRESH_AGE_SECONDS = 60 * 60 * 24;

/**
 * Verification and reset links are short-lived because they are bearer
 * credentials: anyone holding the URL can act as the account.
 */
export const EMAIL_TOKEN_TTL_SECONDS = 60 * 60;

export type Auth = ReturnType<typeof createAuth>;

/**
 * Builds the Better Auth instance.
 *
 * Password hashing, session issuing and token lifecycles are delegated here
 * rather than hand-rolled. That is the single most valuable thing this library
 * provides, and re-implementing it is how authentication bugs happen.
 *
 * It is also a contract, not just an implementation detail. The dashboard's
 * end-to-end suite mints its own email-verification token — an HS256 JWT over
 * `{ email }` signed with `AUTH_SECRET` — and its routing middleware matches
 * the session cookie by name. Replacing the library means reproducing both
 * exactly, so the settings below (`cookiePrefix`, the token TTL, the base path)
 * are compatibility surface and must not be changed casually.
 *
 * Must be called after the database connection is open: the adapter needs a
 * live driver handle. Sharing that handle avoids a second connection pool,
 * which matters on the MongoDB Atlas free tier.
 */
export function createAuth(emailService: EmailService) {
  const expiresInMinutes = EMAIL_TOKEN_TTL_SECONDS / 60;

  return betterAuth({
    appName: 'SiteOps',
    baseURL: env.API_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.AUTH_SECRET,
    database: mongodbAdapter(getMongoDb()),

    // Only origins on the allowlist may drive authentication, which is what
    // stops a hostile page initiating flows against this API.
    trustedOrigins: [...trustedOrigins],

    emailAndPassword: {
      enabled: true,
      // An unverified address must not be able to receive outage alerts, so the
      // account cannot be used until the address is proven.
      requireEmailVerification: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      resetPasswordTokenExpiresIn: EMAIL_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        // Built against APP_URL rather than using the library's default link,
        // which points back at the API. The reset form lives in the dashboard
        // and submits the token itself.
        const content = resetPasswordTemplate({
          name: user.name,
          resetUrl: `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`,
          expiresInMinutes,
        });
        await emailService.send({ to: user.email, ...content });
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: EMAIL_TOKEN_TTL_SECONDS,
      sendVerificationEmail: async ({ user, token }) => {
        // The API verifies the token and then redirects; `callbackURL` decides
        // where the person actually lands, so it must be the dashboard.
        const callback = `${env.APP_URL}/verify-email/confirmed`;
        const verificationUrl =
          `${env.API_URL}${AUTH_BASE_PATH}/verify-email` +
          `?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(callback)}`;

        const content = verifyEmailTemplate({
          name: user.name,
          verificationUrl,
          expiresInMinutes,
        });
        await emailService.send({ to: user.email, ...content });
      },
    },

    session: {
      expiresIn: SESSION_MAX_AGE_SECONDS,
      updateAge: SESSION_REFRESH_AGE_SECONDS,
    },

    advanced: {
      // Produces `siteops.session_token`, which the dashboard's routing
      // middleware matches by name. Renaming it signs everyone out.
      cookiePrefix: 'siteops',
      useSecureCookies: isProduction,
      defaultCookieAttributes: {
        httpOnly: true,
        // Lax rather than Strict: a verification link arrives from a mail
        // client as a cross-site navigation, and Strict would drop the session
        // cookie on exactly that hop.
        sameSite: 'lax',
        secure: isProduction,
      },
      ...(env.COOKIE_DOMAIN
        ? { crossSubDomainCookies: { enabled: true, domain: env.COOKIE_DOMAIN } }
        : {}),
    },

    // Rate limiting is applied by our own middleware, so there is one budget
    // and one 429 shape across the whole API.
    rateLimit: { enabled: false },

    onAPIError: {
      onError: (error) => {
        logger.warn({ err: error }, 'auth.request_failed');
      },
    },
  });
}
