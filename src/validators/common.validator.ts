import { z } from 'zod';

import { objectIdSchema } from '../contracts/index.js';

/**
 * Route-parameter schemas.
 *
 * These are server-only and stay out of `src/contracts`: the dashboard builds
 * these URLs from ids the API already gave it, so there is nothing for a
 * browser form to validate. What they do here is stop a malformed id reaching a
 * query — `new Types.ObjectId('nope')` throws, and an unhandled throw inside a
 * query builder turns what should be a 400 into a 500.
 *
 * Each parameter is named after its resource rather than a generic `:id`, which
 * is also what lets `requireOrganization` tell an organization id in the path
 * apart from a website's.
 */

export const organizationParamsSchema = z.object({
  organizationId: objectIdSchema,
});

export const websiteParamsSchema = z.object({
  websiteId: objectIdSchema,
});

export const incidentParamsSchema = z.object({
  incidentId: objectIdSchema,
});

export const memberParamsSchema = z.object({
  organizationId: objectIdSchema,
  memberId: objectIdSchema,
});

export const invitationParamsSchema = z.object({
  organizationId: objectIdSchema,
  invitationId: objectIdSchema,
});
