import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { Permission } from '../contracts/index.js';
import { hasEveryPermission, permissionsFor } from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type { OrganizationRepository } from '../repositories/organization.repository.js';
import type { OrganizationActor, OrganizationContext } from '../types/common.types.js';

/** Header the dashboard uses to name the organization it is currently showing. */
export const ORGANIZATION_HEADER = 'x-organization-id';

/**
 * Resolves and authorizes the active organization.
 *
 * The organization id supplied by the client — header or path parameter — is
 * treated as a *hint*. Membership is looked up from the authenticated user on
 * every request, and only the role stored server-side decides what is allowed.
 *
 * A resource in an organization the caller does not belong to produces a 404,
 * never a 403. A 403 would confirm the id exists, which turns this endpoint
 * into an oracle for enumerating other tenants' identifiers.
 *
 * Permissions are named, never roles. A capability change then happens in
 * `contracts/domain/permissions.ts` rather than across every route.
 */
export function requireOrganization(
  organizations: OrganizationRepository,
  ...required: readonly Permission[]
): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const user = request.auth?.user;
        // Reaching here without a session means the route omitted `requireAuth`.
        if (!user) throw ApiError.unauthenticated();

        const requestedId = readOrganizationId(request);
        if (!requestedId) {
          throw ApiError.badRequest(
            'VALIDATION_ERROR',
            'Choose an organization before making this request.',
          );
        }

        const membership = await organizations.findMembership(requestedId, user.id);
        if (!membership) {
          // Covers both "no such organization" and "not yours" — deliberately
          // indistinguishable from the outside.
          throw ApiError.notFound('ORGANIZATION_NOT_FOUND', 'Organization not found.');
        }

        const organization = await organizations.findById(requestedId);
        if (!organization) {
          throw ApiError.notFound('ORGANIZATION_NOT_FOUND', 'Organization not found.');
        }

        if (!hasEveryPermission(membership.role, required)) {
          throw ApiError.forbidden(
            'INSUFFICIENT_ROLE',
            'Your role does not allow that in this organization.',
          );
        }

        request.organization = {
          id: organization._id.toHexString(),
          objectId: organization._id,
          name: organization.name,
          slug: organization.slug,
          plan: organization.plan,
          role: membership.role,
          permissions: permissionsFor(membership.role),
        };

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * A path parameter wins over the header: an explicitly addressed resource is
 * unambiguous, while the header only describes what the UI is showing.
 *
 * Only `organizationId` is read, never a generic `:id`. A route naming its
 * parameter `:id` for some *other* resource — a website, an incident — would
 * otherwise have that id silently treated as an organization, and every request
 * to it would resolve the wrong tenant or none at all.
 */
function readOrganizationId(request: Request): string | null {
  // Express types a route parameter as `string | string[]`; a repeated
  // parameter is not a valid id, so only a plain string is accepted.
  const params: Record<string, string | string[] | undefined> = request.params;
  const fromPath = params.organizationId;
  if (typeof fromPath === 'string' && fromPath.length > 0) return fromPath;

  const fromHeader = request.header(ORGANIZATION_HEADER);
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;

  return null;
}

/**
 * The verified organization, for a handler running behind
 * {@link requireOrganization}.
 *
 * Throws rather than returning undefined: reaching this without the middleware
 * is a wiring bug, and an undefined tenant scope is the one thing that must
 * never reach a query.
 */
export function currentOrganization(request: Request): OrganizationContext {
  if (!request.organization) throw ApiError.forbidden();
  return request.organization;
}

/** The caller together with the role they hold in the organization being acted on. */
export function currentActor(request: Request): OrganizationActor {
  const organization = currentOrganization(request);
  if (!request.auth) throw ApiError.unauthenticated();
  return {
    id: request.auth.user.id,
    name: request.auth.user.name,
    role: organization.role,
  };
}
