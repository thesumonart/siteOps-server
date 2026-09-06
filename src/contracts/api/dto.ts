import { type AuditAction, type AuditArea } from '../domain/audit.js';
import { type CheckErrorType, type CheckStatus, type StatsRange } from '../domain/check.js';
import { type ClientStatus } from '../domain/client.js';
import {
  type IncidentCategory,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentType,
} from '../domain/incident.js';
import {
  type NotificationChannel,
  type NotificationEvent,
  type NotificationPreferences,
  type NotificationStatus,
} from '../domain/notification.js';
import {
  type MonitorCheckData,
  type MonitorConfig,
  type MonitorFinding,
  type MonitorStatus,
  type MonitorType,
} from '../domain/monitor.js';
import { type Plan, type PlanFeature, type PlanLimits } from '../domain/plan.js';
import {
  type ReportFormat,
  type ReportStatus,
  type ReportType,
  type ScheduleFrequency,
} from '../domain/report.js';
import { type OrganizationRole } from '../domain/roles.js';
import { type Permission } from '../domain/permissions.js';
import { type WebsiteStatus } from '../domain/website.js';

/**
 * Wire shapes returned by the API.
 *
 * Every date is an ISO 8601 string in UTC. Conversion to a user's timezone is a
 * presentation concern and happens in the browser.
 */

export interface UserDto {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly image: string | null;
  readonly createdAt: string;
}

export interface OrganizationDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly plan: Plan;
  readonly timezone: string;
  readonly websiteCount: number;
  readonly createdAt: string;
}

/**
 * What the current organization's plan allows, resolved server-side.
 *
 * Sent to the dashboard so it can explain a locked feature instead of failing a
 * request the user could not have known would be refused. It is never the
 * enforcement: every one of these is re-checked on the request itself.
 */
export interface EntitlementsDto {
  readonly plan: Plan;
  readonly features: readonly PlanFeature[];
  readonly limits: PlanLimits;
  readonly usage: PlanUsageDto;
}

/** Current consumption against the countable limits. */
export interface PlanUsageDto {
  readonly websites: number;
  readonly members: number;
  readonly clients: number;
  readonly statusPages: number;
  readonly apiKeys: number;
  readonly integrations: number;
  readonly reportSchedules: number;
  readonly customDomains: number;
  readonly apiRequestsToday: number;
  readonly aiGenerationsThisMonth: number;
}

export interface OrganizationMembershipDto {
  readonly organization: OrganizationDto;
  readonly role: OrganizationRole;
  readonly permissions: readonly Permission[];
  readonly joinedAt: string;
}

export interface OrganizationMemberDto {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: OrganizationRole;
  readonly joinedAt: string;
}

export interface WebsiteDto {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly url: string;
  readonly status: WebsiteStatus;
  readonly monitoringEnabled: boolean;
  readonly monitoringIntervalSeconds: number;
  readonly requestTimeoutMs: number;
  readonly failureThreshold: number;
  readonly recoveryThreshold: number;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessfulCheckAt: string | null;
  readonly lastFailedAt: string | null;
  readonly lastResponseTimeMs: number | null;
  readonly lastStatusCode: number | null;
  /** The agency client this website belongs to, or null. */
  readonly clientId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A website row enriched with the rolled-up numbers the dashboard table shows. */
export interface WebsiteSummaryDto extends WebsiteDto {
  readonly uptimePercentage24h: number | null;
  readonly averageResponseTimeMs24h: number | null;
  readonly openIncidentId: string | null;
}

/** One auxiliary monitor as configured on a website. */
export interface MonitorDto {
  readonly id: string;
  readonly websiteId: string;
  readonly type: MonitorType;
  readonly enabled: boolean;
  readonly intervalSeconds: number;
  readonly status: MonitorStatus;
  readonly lastRunAt: string | null;
  readonly lastSummary: string | null;
  readonly nextRunAt: string | null;
  readonly config: MonitorConfig;
  /** The most recent result, when there is one. */
  readonly latestResult: MonitorResultDto | null;
}

export interface MonitorResultDto {
  readonly id: string;
  readonly monitorId: string;
  readonly websiteId: string;
  readonly type: MonitorType;
  readonly status: MonitorStatus;
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly summary: string;
  readonly data: MonitorCheckData;
  readonly findings: readonly MonitorFinding[];
  readonly errorMessage: string | null;
}

/** Enabled monitors grouped by type and status, for the overview cards. */
export interface MonitorSummaryDto {
  readonly type: MonitorType;
  readonly passing: number;
  readonly warning: number;
  readonly failing: number;
  readonly error: number;
  readonly unknown: number;
}

/** An agency client, with the counts its list row shows. */
export interface ClientDto {
  readonly id: string;
  readonly name: string;
  readonly companyName: string | null;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly status: ClientStatus;
  /** Internal notes. Never returned to a client-role caller. */
  readonly notes: string | null;
  readonly websiteCount: number;
  readonly contactCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Somebody with portal access to a client, or invited to it.
 *
 * `id` is a membership id for an accepted contact and an invitation id for a
 * pending one. The client never sees this list; it is the agency's view of who
 * it has let in.
 */
export interface ClientContactDto {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly status: 'active' | 'invited';
  readonly joinedAt: string;
}

export interface WebsiteCheckDto {
  readonly id: string;
  readonly websiteId: string;
  readonly status: CheckStatus;
  readonly statusCode: number | null;
  readonly responseTimeMs: number | null;
  readonly checkedAt: string;
  readonly errorType: CheckErrorType | null;
  readonly errorMessage: string | null;
  readonly redirectCount: number;
}

export interface UptimeStatsDto {
  readonly range: StatsRange;
  readonly totalChecks: number;
  readonly successfulChecks: number;
  readonly failedChecks: number;
  readonly uptimePercentage: number | null;
  readonly downtimeSeconds: number;
  readonly averageResponseTimeMs: number | null;
  readonly fastestResponseTimeMs: number | null;
  readonly slowestResponseTimeMs: number | null;
}

/** One point on the response-time or uptime chart. */
export interface UptimeBucketDto {
  readonly bucketStart: string;
  readonly totalChecks: number;
  readonly successfulChecks: number;
  readonly uptimePercentage: number | null;
  readonly averageResponseTimeMs: number | null;
}

export interface IncidentDto {
  readonly id: string;
  readonly organizationId: string;
  readonly websiteId: string;
  readonly websiteName: string;
  readonly websiteUrl: string;
  readonly status: IncidentStatus;
  readonly type: IncidentType;
  readonly category: IncidentCategory;
  readonly severity: IncidentSeverity;
  /** Set by a monitor that raised this incident; null for uptime failures. */
  readonly detail: string | null;
  readonly startedAt: string;
  readonly resolvedAt: string | null;
  readonly durationSeconds: number | null;
  readonly failedCheckCount: number;
  readonly lastStatusCode: number | null;
  readonly lastErrorType: CheckErrorType | null;
  readonly lastErrorMessage: string | null;
}

export interface NotificationDto {
  readonly id: string;
  readonly event: NotificationEvent;
  readonly channel: NotificationChannel;
  readonly status: NotificationStatus;
  readonly websiteId: string | null;
  readonly websiteName: string | null;
  readonly incidentId: string | null;
  readonly title: string;
  readonly body: string;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface NotificationSettingsDto {
  readonly preferences: NotificationPreferences;
}

export interface AuditLogDto {
  readonly id: string;
  readonly action: AuditAction;
  readonly area: AuditArea;
  readonly actorId: string | null;
  readonly actorName: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  readonly createdAt: string;
}

/**
 * The distinct actors that appear in an organization's audit log.
 *
 * Sent alongside the first page so the actor filter can be populated without a
 * second round trip, and without the client having to derive it from whichever
 * page happens to be loaded.
 */
export interface AuditActorDto {
  readonly id: string | null;
  readonly name: string;
}

/**
 * A report as it appears in a list or a detail view.
 *
 * `summary` carries the handful of numbers a list row shows. The full
 * `ReportData` is deliberately absent: it can be hundreds of kilobytes, and a
 * page of fifty rows would be the heaviest response in the product.
 */
export interface ReportDto {
  readonly id: string;
  readonly type: ReportType;
  readonly title: string;
  readonly status: ReportStatus;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly websiteIds: readonly string[];
  readonly generatedAt: string | null;
  readonly errorMessage: string | null;
  /** True when a schedule produced this rather than a person. */
  readonly scheduled: boolean;
  readonly createdAt: string;
  readonly summary: ReportSummaryDto | null;
}

export interface ReportSummaryDto {
  readonly websiteCount: number;
  readonly overallUptimePercentage: number | null;
  readonly averageResponseTimeMs: number | null;
  readonly totalIncidents: number;
  readonly totalDowntimeSeconds: number;
}

export interface ReportScheduleDto {
  readonly id: string;
  readonly name: string;
  readonly frequency: ScheduleFrequency;
  readonly dayOfWeek: number;
  readonly hourUtc: number;
  readonly type: ReportType;
  readonly websiteIds: readonly string[];
  readonly format: ReportFormat;
  readonly recipients: readonly string[];
  readonly enabled: boolean;
  /** Null while disabled: a stored date would promise a run that will not happen. */
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastReportId: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
}

/** An organization's white-label settings, as stored. */
export interface BrandingDto {
  readonly brandName: string | null;
  readonly logoUrl: string | null;
  readonly primaryColor: string | null;
  readonly footerText: string | null;
  readonly hidePoweredBy: boolean;
  readonly supportEmail: string | null;
}

export interface DashboardStatsDto {
  readonly totalWebsites: number;
  readonly operational: number;
  readonly degraded: number;
  readonly down: number;
  readonly paused: number;
  readonly unknown: number;
  readonly averageUptimePercentage24h: number | null;
  readonly averageResponseTimeMs24h: number | null;
  readonly openIncidents: number;
}

/**
 * Everything the browser needs to render the shell on first paint: who is
 * signed in, which organizations they belong to, and what they may do in each.
 *
 * Permissions are resolved server-side and sent down so the UI can hide actions
 * it would not be allowed to perform. They are a presentation aid only — the
 * API re-checks every one of them on the request itself.
 */
export interface SessionDto {
  readonly user: UserDto;
  readonly memberships: readonly OrganizationMembershipDto[];
}
