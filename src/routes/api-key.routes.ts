import { Router } from 'express';

import { ApiKeyController } from '../controllers/api-key.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireOrganization } from '../middlewares/organization.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { apiKeyValidators } from '../validators/index.js';
import type { ApiDependencies } from './index.js';

/**
 * Managing API keys, with a session, from the dashboard.
 *
 * These routes are how keys are made; they are not reachable *with* one. The
 * public API under `/api/v1` accepts keys and nothing else, and nothing here
 * accepts a key — a key that could mint more keys would outlive every attempt
 * to revoke it.
 */
export function apiKeyRoutes(dependencies: ApiDependencies): Router {
  const router = Router();
  const auth = requireAuth(dependencies.authService);
  const apiKeys = new ApiKeyController(dependencies.apiKeyService);

  router.get(
    '/api-keys',
    auth,
    requireOrganization(dependencies.organizations, 'api_key:read'),
    asyncHandler(apiKeys.list),
  );

  router.post(
    '/api-keys',
    auth,
    rateLimit({ limit: 20, windowSeconds: 3600, scope: 'api-key-issue' }),
    validate(apiKeyValidators.create),
    requireOrganization(dependencies.organizations, 'api_key:manage'),
    asyncHandler(apiKeys.create),
  );

  router.post(
    '/api-keys/:apiKeyId/rotate',
    auth,
    rateLimit({ limit: 20, windowSeconds: 3600, scope: 'api-key-issue' }),
    validate(apiKeyValidators.rotate),
    requireOrganization(dependencies.organizations, 'api_key:manage'),
    asyncHandler(apiKeys.rotate),
  );

  router.delete(
    '/api-keys/:apiKeyId',
    auth,
    validate(apiKeyValidators.revoke),
    requireOrganization(dependencies.organizations, 'api_key:manage'),
    asyncHandler(apiKeys.revoke),
  );

  return router;
}
