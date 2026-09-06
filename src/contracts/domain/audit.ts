/**
 * Auditable organization actions.
 *
 * The list is closed so the activity feed can render a readable sentence for
 * every entry without falling back to raw action strings, and so the filter
 * dropdown has something finite to offer.
 *
 * An action is added here when it changes security posture, spends money, or
 * changes what the organization monitors. Reads are not audited: they would
 * bury the writes that matter under noise nobody reviews.
 */
export const AUDIT_ACTIONS = [
  'organization.created',
  'organization.updated',
  'organization.branding_updated',
  'website.created',
  'website.updated',
  'website.deleted',
  'website.monitoring_paused',
  'website.monitoring_resumed',
  'website.monitor_updated',
  'member.invited',
  'member.joined',
  'member.role_updated',
  'member.removed',
  'incident.resolved_manually',
  'notification_settings.updated',
  'client.created',
  'client.updated',
  'client.deleted',
  'client.invited',
  'client.access_revoked',
  'integration.created',
  'integration.updated',
  'integration.deleted',
  'status_page.created',
  'status_page.updated',
  'status_page.deleted',
  'custom_domain.added',
  'custom_domain.verified',
  'custom_domain.removed',
  'api_key.created',
  'api_key.rotated',
  'api_key.revoked',
  'report.generated',
  'report.deleted',
  'report_schedule.created',
  'report_schedule.updated',
  'report_schedule.deleted',
  'billing.checkout_started',
  'billing.subscription_activated',
  'billing.subscription_updated',
  'billing.subscription_cancelled',
  'billing.plan_changed',
  'ai.analysis_generated',
  'ai.summary_generated',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  'organization.created': 'created the organization',
  'organization.updated': 'updated organization settings',
  'organization.branding_updated': 'updated branding',
  'website.created': 'added',
  'website.updated': 'updated',
  'website.deleted': 'deleted',
  'website.monitoring_paused': 'paused monitoring for',
  'website.monitoring_resumed': 'resumed monitoring for',
  'website.monitor_updated': 'changed a monitor on',
  'member.invited': 'invited',
  'member.joined': 'joined the organization',
  'member.role_updated': 'changed the role of',
  'member.removed': 'removed',
  'incident.resolved_manually': 'manually resolved an incident for',
  'notification_settings.updated': 'updated notification settings',
  'client.created': 'added the client',
  'client.updated': 'updated the client',
  'client.deleted': 'deleted the client',
  'client.invited': 'invited a contact for',
  'client.access_revoked': 'revoked portal access for',
  'integration.created': 'connected',
  'integration.updated': 'updated',
  'integration.deleted': 'disconnected',
  'status_page.created': 'published the status page',
  'status_page.updated': 'updated the status page',
  'status_page.deleted': 'removed the status page',
  'custom_domain.added': 'added the custom domain',
  'custom_domain.verified': 'verified the custom domain',
  'custom_domain.removed': 'removed the custom domain',
  'api_key.created': 'created the API key',
  'api_key.rotated': 'rotated the API key',
  'api_key.revoked': 'revoked the API key',
  'report.generated': 'generated a report for',
  'report.deleted': 'deleted a report for',
  'report_schedule.created': 'scheduled a report for',
  'report_schedule.updated': 'updated a report schedule for',
  'report_schedule.deleted': 'removed a report schedule for',
  'billing.checkout_started': 'started checkout for',
  'billing.subscription_activated': 'activated the subscription',
  'billing.subscription_updated': 'updated the subscription',
  'billing.subscription_cancelled': 'cancelled the subscription',
  'billing.plan_changed': 'changed the plan to',
  'ai.analysis_generated': 'generated an incident analysis for',
  'ai.summary_generated': 'generated a monthly summary for',
};

/**
 * Coarse grouping for the audit log filter.
 *
 * Derived from the action's prefix rather than stored, so adding an action to
 * an existing area needs no migration.
 */
export const AUDIT_AREAS = [
  'organization',
  'website',
  'member',
  'incident',
  'notification_settings',
  'client',
  'integration',
  'status_page',
  'custom_domain',
  'api_key',
  'report',
  'report_schedule',
  'billing',
  'ai',
] as const;

export type AuditArea = (typeof AUDIT_AREAS)[number];

export const AUDIT_AREA_LABELS: Record<AuditArea, string> = {
  organization: 'Organization',
  website: 'Websites',
  member: 'Members',
  incident: 'Incidents',
  notification_settings: 'Notifications',
  client: 'Clients',
  integration: 'Integrations',
  status_page: 'Status pages',
  custom_domain: 'Custom domains',
  api_key: 'API keys',
  report: 'Reports',
  report_schedule: 'Report schedules',
  billing: 'Billing',
  ai: 'AI',
};

export function areaOfAuditAction(action: AuditAction): AuditArea {
  return action.slice(0, action.indexOf('.')) as AuditArea;
}

/** Every action belonging to one area, for translating a filter into a query. */
export function auditActionsInArea(area: AuditArea): readonly AuditAction[] {
  const prefix = `${area}.`;
  return AUDIT_ACTIONS.filter((action) => action.startsWith(prefix));
}
