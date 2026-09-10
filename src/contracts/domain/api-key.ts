import type { Permission } from './permissions.js';

/**
 * API keys for the public `/api/v1` surface.
 *
 * A key belongs to an organization, not to a person, and says what it may do
 * with scopes rather than a role. Scopes are deliberately coarser than
 * permissions — an integration author thinks "read monitors", not
 * "`website:read` and `monitoring:read`" — and each maps onto the permissions it
 * stands for below, which is what keeps the two vocabularies from drifting.
 */

/** Every key starts with this, so a leaked one is recognisable in a scanner or a diff. */
export const API_KEY_PREFIX = 'so_live_';

export const API_KEY_SCOPES = [
  'monitors:read',
  'monitors:write',
  'checks:read',
  'incidents:read',
  'incidents:write',
  'metrics:read',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'monitors:read': 'Read monitors',
  'monitors:write': 'Create, change, pause and delete monitors',
  'checks:read': 'Read check history',
  'incidents:read': 'Read incidents',
  'incidents:write': 'Resolve incidents',
  'metrics:read': 'Read uptime and response-time metrics',
};

/**
 * The dashboard permissions each scope stands for.
 *
 * Used in one direction only: a person may grant a key a scope only when their
 * own role holds every permission behind it. Without that, a key would be the
 * way for a member to act with an admin's reach — the escalation path an API
 * key most easily becomes.
 */
export const API_KEY_SCOPE_PERMISSIONS: Record<ApiKeyScope, readonly Permission[]> = {
  'monitors:read': ['website:read', 'monitoring:read'],
  'monitors:write': ['website:create', 'website:update', 'website:delete', 'monitoring:toggle'],
  'checks:read': ['monitoring:read'],
  'incidents:read': ['incident:read'],
  'incidents:write': ['incident:update'],
  'metrics:read': ['monitoring:read'],
};

export const API_KEY_STATUSES = ['active', 'expired', 'revoked'] as const;

export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

/** Longest a key may be issued for. A key that never expires is also allowed, and is the default. */
export const MAX_API_KEY_EXPIRY_DAYS = 365;
