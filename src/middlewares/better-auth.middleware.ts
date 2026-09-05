import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { Auth } from '../config/auth.js';
import { env } from '../config/env.js';
import { toApiError, type BetterAuthErrorBody } from '../services/auth.error-mapping.js';
import { createLogger } from '../utils/logger.js';
import { RateLimiter, type RateLimitRule } from '../utils/rate-limiter.js';

const logger = createLogger('auth');

/**
 * Adapts Better Auth's Web `Request`/`Response` handler to Express, and rewrites
 * its bodies into the SiteOps envelope.
 *
 * The library ships a Node adapter that would work, but it passes responses
 * through in Better Auth's own shape — `{ message, code }` on failure, a bare
 * object on success. These routes are mounted as raw middleware, ahead of the
 * body parser and outside the router, so neither the error handler nor any
 * response helper sees them. Without this the API would speak two envelopes and
 * the dashboard would need two parsers.
 */

/** Rebuilds the absolute URL Better Auth needs from the Express request. */
function absoluteUrl(request: Request): string {
  const forwardedProto = request.get('x-forwarded-proto');
  const protocol = forwardedProto?.split(',')[0]?.trim() ?? request.protocol;
  const host = request.get('host') ?? 'localhost';
  return `${protocol}://${host}${request.originalUrl}`;
}

function readBody(request: Request): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

export function betterAuthHandler(auth: Auth): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const body = await readBody(request);

        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item);
          } else {
            headers.set(name, value);
          }
        }

        const authResponse = await auth.handler(
          new Request(absoluteUrl(request), {
            method: request.method,
            headers,
            body: body && body.length > 0 ? body : undefined,
          }),
        );

        // Cookies arrive as repeated Set-Cookie headers and must not be joined
        // into one value, or the browser stores a single malformed cookie.
        for (const cookie of authResponse.headers.getSetCookie()) {
          response.append('Set-Cookie', cookie);
        }
        authResponse.headers.forEach((value, name) => {
          if (name.toLowerCase() === 'set-cookie') return;
          response.setHeader(name, value);
        });

        response.status(authResponse.status);

        const contentType = authResponse.headers.get('content-type') ?? '';
        const isJson = contentType.includes('application/json');
        const text = await authResponse.text();

        if (authResponse.status >= 400 && isJson) {
          const parsed = JSON.parse(text) as BetterAuthErrorBody;
          const envelope = toApiError(authResponse.status, parsed);
          logger.warn(
            {
              requestId: request.id,
              path: request.path,
              status: authResponse.status,
              code: envelope.error.code,
            },
            'auth.rejected',
          );
          response.json(envelope);
          return;
        }

        /*
         * Successful payloads are wrapped too, so the whole API speaks one
         * envelope. Redirects and empty bodies pass through untouched — the
         * verification link relies on a real 302 with its Location header, and
         * wrapping that would leave the person staring at JSON.
         */
        if (authResponse.status < 400 && isJson && text.length > 0) {
          response.json({ success: true, data: JSON.parse(text) as unknown });
          return;
        }

        if (text.length === 0) {
          response.end();
          return;
        }
        response.send(text);
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * Rate limiting for the auth routes.
 *
 * They are mounted as raw middleware — Better Auth needs the unparsed body — so
 * the router's own limiter never sees them. This applies the same limiter, in
 * the same shape, ahead of the handler.
 *
 * Credential endpoints get their own tight budget: brute force and credential
 * stuffing are the attacks this exists to blunt, and they must not be able to
 * consume the general API allowance either.
 */
const limiter = new RateLimiter();

interface AuthRouteRule {
  /** Matched against the path *after* the auth base path. */
  readonly match: (path: string) => boolean;
  readonly scope: string;
  readonly rule: RateLimitRule;
}

const MINUTE = 60_000;

function buildRules(): readonly AuthRouteRule[] {
  const credentialLimit = env.AUTH_RATE_LIMIT_MAX_REQUESTS;

  return [
    {
      // Sign-in and sign-up share one scope on purpose: alternating between
      // them must not double an attacker's budget.
      match: (path) => path.startsWith('/sign-in') || path.startsWith('/sign-up'),
      scope: 'auth-credentials',
      rule: { windowMs: 15 * MINUTE, limit: credentialLimit },
    },
    {
      // Each of these sends an email, so the limit also protects the sending
      // reputation of the domain, not just the account.
      match: (path) =>
        path.startsWith('/forget-password') ||
        path.startsWith('/request-password-reset') ||
        path.startsWith('/reset-password') ||
        path.startsWith('/send-verification-email'),
      scope: 'auth-email',
      rule: { windowMs: 60 * MINUTE, limit: Math.max(3, Math.floor(credentialLimit / 2)) },
    },
  ];
}

const DEFAULT_RULE = (): RateLimitRule => ({
  windowMs: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
  limit: env.RATE_LIMIT_MAX_REQUESTS,
});

export function authRateLimit(): RequestHandler {
  const rules = buildRules();

  return (request: Request, response: Response, next: NextFunction): void => {
    // Reads such as `/get-session` are not credential attempts and only need
    // the general allowance.
    const matched = rules.find((candidate) => candidate.match(request.path));

    const scope = matched?.scope ?? 'auth-general';
    const rule = matched?.rule ?? DEFAULT_RULE();

    const client = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const verdict = limiter.consume(`${scope}|${client}`, rule);

    response.setHeader('RateLimit-Limit', verdict.limit);
    response.setHeader('RateLimit-Remaining', verdict.remaining);
    response.setHeader('RateLimit-Reset', Math.ceil((verdict.resetAt - Date.now()) / 1000));

    if (!verdict.allowed) {
      response.setHeader('Retry-After', verdict.retryAfterSeconds);
      // Written directly rather than thrown: these routes sit outside the
      // router, so the error handler is not in this chain.
      response.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again shortly.' },
      });
      return;
    }

    next();
  };
}

/** Test-only reset, so limiter state does not leak between cases. */
export function resetAuthRateLimiter(): void {
  limiter.reset();
}
