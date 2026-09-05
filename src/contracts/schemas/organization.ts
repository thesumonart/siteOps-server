import { z } from 'zod';

import { ORGANIZATION_ROLES } from '../domain/roles.js';
import { emailSchema } from './auth.js';
import { humanNameSchema } from './common.js';

/**
 * URL-safe organization identifier. Reserved words are refused so a slug can
 * never shadow a dashboard route segment.
 */
const RESERVED_SLUGS: readonly string[] = [
  'api',
  'admin',
  'app',
  'auth',
  'dashboard',
  'login',
  'logout',
  'new',
  'register',
  'settings',
  'siteops',
  'status',
  'support',
  'www',
];

export const organizationSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Use at least 3 characters.')
  .max(48, 'Use 48 characters or fewer.')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase letters, numbers and single hyphens between them.',
  )
  .refine((value) => !RESERVED_SLUGS.includes(value), { message: 'This name is reserved.' });

export const createOrganizationSchema = z.object({
  name: humanNameSchema,
  slug: organizationSlugSchema.optional(),
});

export type CreateOrganizationFormValues = z.input<typeof createOrganizationSchema>;
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z.object({
  name: humanNameSchema.optional(),
  /** IANA timezone used to render timestamps for the whole organization. */
  timezone: z.string().trim().min(1).max(64).optional(),
});

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

/** Owner is intentionally not assignable through the invite flow — ownership is transferred. */
export const assignableRoleSchema = z.enum(['admin', 'member']);

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: assignableRoleSchema.default('member'),
});

export type InviteMemberFormValues = z.input<typeof inviteMemberSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(1, 'This invitation link is invalid.').max(256),
});

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const updateMemberRoleSchema = z.object({
  role: z.enum(ORGANIZATION_ROLES),
});

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

/**
 * Derives a slug candidate from a display name. The server still has to check
 * uniqueness and fall back to a suffixed variant.
 */
export function slugifyOrganizationName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug.length >= 3 ? slug : `org-${slug}`.slice(0, 48);
}
