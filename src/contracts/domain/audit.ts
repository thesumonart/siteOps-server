/**
 * Auditable organization actions.
 *
 * The list is closed so the activity feed can render a readable sentence for
 * every entry without falling back to raw action strings.
 */
export const AUDIT_ACTIONS = [
  'organization.created',
  'organization.updated',
  'website.created',
  'website.updated',
  'website.deleted',
  'website.monitoring_paused',
  'website.monitoring_resumed',
  'member.invited',
  'member.joined',
  'member.role_updated',
  'member.removed',
  'incident.resolved_manually',
  'notification_settings.updated',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  'organization.created': 'created the organization',
  'organization.updated': 'updated organization settings',
  'website.created': 'added',
  'website.updated': 'updated',
  'website.deleted': 'deleted',
  'website.monitoring_paused': 'paused monitoring for',
  'website.monitoring_resumed': 'resumed monitoring for',
  'member.invited': 'invited',
  'member.joined': 'joined the organization',
  'member.role_updated': 'changed the role of',
  'member.removed': 'removed',
  'incident.resolved_manually': 'manually resolved an incident for',
  'notification_settings.updated': 'updated notification settings',
};
