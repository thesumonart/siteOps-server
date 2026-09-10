import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { env } from '../config/env.js';
import {
  API_KEY_PREFIX,
  API_KEY_SCOPE_PERMISSIONS,
  type ApiKeyScope,
  type Permission,
} from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type { ApiKeyService } from '../services/api-key.service.js';
import type { EntitlementService } from '../services/entitlement.service.js';
import type { ApiKeyContext, Actor } from '../types/auth.types.js';
import { toObjectIdOrThrow } from '../utils/object-id.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import { currentOrganization } from './organization.middleware.js';

/**
 * Authentication and budgets for the public API.
 *
 * `/api/v1` accepts an API key and nothing else. A session cookie is not
 * consulted there at all: an endpoint that honoured both would let any page a
 * signed-in admin visits make authenticated requests with their cookie, which
 * is the cross-site request forgery the dashboard's routes are shaped to avoid.
 * A key, sent in a header a browser never attaches on its own, has no such
 * failure mode.
 */

const BEARER = 'Bearer ';

function invalidKey(message: string): ApiError {
  return new ApiError(401, message, 'API_KEY_INVALID');
}

/** Every dashboard permission a key's scopes stand for, once each. */
function permissionsFor(scopes: readonly ApiKeyScope[]): readonly Permission[] {
  return [...new Set(scopes.flatMap((scope) => API_KEY_SCOPE_PERMISSIONS[scope]))];
}

/**
 * Resolves the key, and from it the tenant.
 *
 * The organization comes from the key's own document, never from a header or a
 * path: there is no `X-Organization-Id` on this surface, because a key already
 * says exactly which organization it belongs to.
 *
 * `role` is set to `member` and consulted by nothing on this path — what a key
 * may do is its scopes, checked per route. `member` is the least an internal
 * caller can be, so a service that ever did read it would not over-grant.
 * `clientScope` is null: a key speaks for the whole organization.
 *
 * Every failure to authenticate is the same 401. Whether the key was
 * malformed, unknown, revoked or expired is not something to tell a caller
 * probing for one that works.
 */
export function requireApiKey(
  apiKeys: ApiKeyService,
  entitlements: EntitlementService,
): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const header = request.get('authorization') ?? '';
        const token = header.startsWith(BEARER) ? header.slice(BEARER.length).trim() : '';

        if (token.length === 0) {
          response.setHeader('WWW-Authenticate', 'Bearer realm="siteops"');
          throw invalidKey(`Send an API key as "Authorization: Bearer ${API_KEY_PREFIX}…".`);
        }

        const authenticated = await apiKeys.authenticate(token, new Date());
        if (!authenticated) {
          response.setHeader('WWW-Authenticate', 'Bearer realm="siteops", error="invalid_token"');
          throw invalidKey('That API key is not valid.');
        }

        const { key, organization } = authenticated;

        request.apiKey = {
          id: key._id.toHexString(),
          name: key.name,
          scopes: key.scopes,
          createdByUserId: key.createdByUserId.toHexString(),
        };
        request.organization = {
          id: organization._id.toHexString(),
          objectId: organization._id,
          name: organization.name,
          slug: organization.slug,
          plan: organization.plan,
          role: 'member',
          permissions: permissionsFor(key.scopes),
          clientScope: null,
        };

        // A downgrade leaves the keys in place and stops them working, rather
        // than deleting something the organization may want back.
        entitlements.assertFeature(request.organization, 'api_access');

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * The key behind a public API request, for a handler behind {@link requireApiKey}.
 *
 * Throws rather than returning undefined: reaching this without the middleware
 * is a wiring bug.
 */
export function currentApiKey(request: Request): ApiKeyContext {
  if (!request.apiKey) throw invalidKey('That API key is not valid.');
  return request.apiKey;
}

/**
 * Who an audit entry names for something a key did.
 *
 * The person who issued the key, with the key's name in place of theirs — so
 * the feed reads "API key “Terraform” deleted Acme" and still leads back to a
 * person who can answer for it.
 */
export function apiKeyActor(request: Request): Actor {
  const key = currentApiKey(request);
  return { id: key.createdByUserId, name: `API key “${key.name}”` };
}

/** Refuses unless the key carries `scope`. Declared on the line of each route, like a permission. */
export function requireScope(scope: ApiKeyScope): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const key = request.apiKey;
    if (!key) {
      next(invalidKey('That API key is not valid.'));
      return;
    }
    if (!key.scopes.includes(scope)) {
      next(new ApiError(403, `This key needs the "${scope}" scope.`, 'INSUFFICIENT_SCOPE'));
      return;
    }
    next();
  };
}

/*
 * Per-key smoothing. Keyed by the key rather than the address: several
 * customers' integrations can share one cloud egress IP, and one of them
 * bursting must not throttle the others. Per process, like every limiter here
 * — the daily quota below is the one that is durable.
 */
const limiter = new RateLimiter();

export function apiKeyRateLimit(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const key = request.apiKey;
    if (!key) {
      next(invalidKey('That API key is not valid.'));
      return;
    }

    const verdict = limiter.consume(`api-key|${key.id}`, {
      windowMs: 60_000,
      limit: env.API_KEY_RATE_LIMIT_PER_MINUTE,
    });

    response.setHeader('RateLimit-Limit', verdict.limit);
    response.setHeader('RateLimit-Remaining', verdict.remaining);
    response.setHeader('RateLimit-Reset', Math.ceil((verdict.resetAt - Date.now()) / 1000));

    if (!verdict.allowed) {
      response.setHeader('Retry-After', verdict.retryAfterSeconds);
      next(ApiError.rateLimited());
      return;
    }
    next();
  };
}

/** Test-only reset, so limiter state does not leak between cases. */
export function resetApiKeyRateLimiter(): void {
  limiter.reset();
}

/** Seconds until the next UTC midnight, when the daily quota starts again. */
function secondsUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * The plan's daily request quota, counted in the database.
 *
 * Every request is counted, including the one that goes over — the count is
 * of requests made, not requests served — and the refusal says when the quota
 * resets rather than leaving an integration to retry into the wall.
 */
export function apiQuota(apiKeys: ApiKeyService, entitlements: EntitlementService): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const organization = currentOrganization(request);
        const key = currentApiKey(request);
        const now = new Date();

        const allowed = entitlements.limit(organization, 'apiRequestsPerDay');
        const used = await apiKeys.recordUse(toObjectIdOrThrow(key.id), organization.objectId, now);

        response.setHeader('X-Quota-Limit', allowed);
        response.setHeader('X-Quota-Remaining', Math.max(0, allowed - used));

        if (used > allowed) {
          response.setHeader('Retry-After', secondsUntilUtcMidnight(now));
          throw new ApiError(
            429,
            `This organization has used its ${String(allowed)} API requests for today. The quota resets at midnight UTC.`,
            'API_QUOTA_EXCEEDED',
          );
        }

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}
