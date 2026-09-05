import { type AuditAction } from '../domain/audit.js';
import { type CheckErrorType, type CheckStatus, type StatsRange } from '../domain/check.js';
import { type IncidentStatus, type IncidentType } from '../domain/incident.js';
import {
  type NotificationChannel,
  type NotificationEvent,
  type NotificationPreferences,
  type NotificationStatus,
} from '../domain/notification.js';
import { type Plan } from '../domain/plan.js';
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
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A website row enriched with the rolled-up numbers the dashboard table shows. */
export interface WebsiteSummaryDto extends WebsiteDto {
  readonly uptimePercentage24h: number | null;
  readonly averageResponseTimeMs24h: number | null;
  readonly openIncidentId: string | null;
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
  readonly actorId: string | null;
  readonly actorName: string;
  readonly targetLabel: string | null;
  readonly createdAt: string;
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
