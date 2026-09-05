import type { RequestAuthContext } from './auth.types.js';
import type { OrganizationContext } from './common.types.js';

/**
 * Express request augmentations owned by SiteOps middleware.
 *
 * Declared centrally so a handler cannot read a field that nothing sets, and so
 * the two security-relevant ones are visible in one place: `auth` is set only
 * by `requireAuth`, `organization` only by `requireOrganization`. A handler
 * that reads either without the corresponding middleware in its chain is a
 * wiring bug, and both accessors throw rather than returning undefined.
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation id assigned by `requestId`. Present on every request. */
      id: string;
      /** Set by `requireAuth`. Absent on public routes. */
      auth?: RequestAuthContext;
      /** Set by `requireOrganization`. Absent on routes that declare no permission. */
      organization?: OrganizationContext;
      /** Parsed and normalized input, written by `validate`. */
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
