import type { Types } from 'mongoose';

import type {
  CreateReportInput,
  CursorPaginatedResult,
  ListReportsQuery,
  ReportDto,
  ReportFormat,
  ReportScheduleDto,
  ReportScheduleInput,
  UpdateReportScheduleInput,
} from '../contracts/index.js';
import { REPORT_PERIOD_LABELS, nextScheduleRun, resolveReportPeriod } from '../contracts/index.js';
import { ApiError } from '../errors/ApiError.js';
import type {
  ReportRecord,
  ReportRepository,
  ReportScheduleRecord,
} from '../repositories/report.repository.js';
import { renderReport, type RenderedReport } from '../reporting/renderers/index.js';
import type { Actor } from '../types/auth.types.js';
import type { OrganizationContext } from '../types/common.types.js';
import { toObjectId } from '../utils/object-id.js';
import { decodeOptionalCursor, encodeCursor } from '../utils/pagination.js';
import type { AuditService } from './audit.service.js';
import type { BrandingService } from './branding.service.js';
import type { EntitlementService } from './entitlement.service.js';

/**
 * Requesting reports and managing schedules.
 *
 * Two things happen here and nowhere else:
 *
 *  1. **Requesting is not generating.** A report is created `pending` and the
 *     worker builds it. A month of checks across fifty websites is a set of
 *     aggregations, not something to run while an HTTP connection waits, and
 *     doing it in the request handler would put the API's event loop under load
 *     meant for a background process.
 *  2. **Rendering is not storing.** The download route renders the stored facts
 *     into PDF, CSV or JSON on demand. See `contracts/domain/report.ts`.
 */
export class ReportGenerationService {
  constructor(
    private readonly repository: ReportRepository,
    private readonly entitlements: EntitlementService,
    private readonly branding: BrandingService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Queues a report.
   *
   * The period is resolved here rather than at render time so the report covers
   * what was asked for when it was asked for — a "last 7 days" report generated
   * after a retry an hour later must still cover the same seven days.
   */
  async request(
    organization: OrganizationContext,
    input: CreateReportInput,
    actor: Actor,
  ): Promise<ReportDto> {
    this.entitlements.assertFeature(organization, 'reports');

    const { from, to } = this.resolvePeriod(input);
    const websiteIds = (input.websiteIds ?? [])
      .map((id) => toObjectId(id))
      .filter((id): id is Types.ObjectId => id !== null);

    const title = input.title ?? this.defaultTitle(input, organization.name);

    const report = await this.repository.create({
      organizationId: organization.objectId,
      type: input.type,
      title,
      periodStart: from,
      periodEnd: to,
      websiteIds,
      requestedByUserId: toObjectId(actor.id),
      scheduleId: null,
    });

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'report.generated',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'report',
      targetId: report._id,
      targetLabel: title,
    });

    return toReportDto(report);
  }

  async list(
    organization: OrganizationContext,
    query: ListReportsQuery,
  ): Promise<CursorPaginatedResult<ReportDto>> {
    this.entitlements.assertFeature(organization, 'reports');

    const rows = await this.repository.list({
      organizationId: organization.objectId,
      pageSize: query.pageSize,
      status: query.status,
      type: query.type,
      cursor: decodeOptionalCursor(query.cursor),
    });

    const hasNextPage = rows.length > query.pageSize;
    const items = hasNextPage ? rows.slice(0, query.pageSize) : rows;
    const last = items.at(-1);

    return {
      items: items.map(toReportDto),
      pagination: {
        nextCursor: hasNextPage && last ? encodeCursor(last.createdAt, last._id) : null,
        hasNextPage,
        pageSize: query.pageSize,
      },
    };
  }

  async findById(organization: OrganizationContext, reportId: string): Promise<ReportDto> {
    this.entitlements.assertFeature(organization, 'reports');
    return toReportDto(await this.requireReport(organization, reportId));
  }

  /**
   * Renders a finished report into a downloadable file.
   *
   * Refuses anything not `ready`: a partially built report would render as a
   * document full of zeroes, which is exactly the kind of plausible-looking
   * wrong number that must never leave this product.
   */
  async download(
    organization: OrganizationContext,
    reportId: string,
    format: ReportFormat,
  ): Promise<RenderedReport> {
    this.entitlements.assertFeature(organization, 'reports');
    const report = await this.requireReport(organization, reportId);

    if (report.status !== 'ready' || report.data === null) {
      throw ApiError.conflict(
        'REPORT_NOT_READY',
        report.status === 'failed'
          ? 'This report could not be generated.'
          : 'This report is still being generated.',
      );
    }

    return renderReport({
      title: report.title,
      data: report.data,
      format,
      branding: await this.branding.forOrganization(organization),
    });
  }

  async delete(organization: OrganizationContext, reportId: string, actor: Actor): Promise<void> {
    this.entitlements.assertFeature(organization, 'reports');

    const deleted = await this.repository.delete(organization.objectId, reportId);
    if (!deleted) throw ApiError.notFound('REPORT_NOT_FOUND', 'Report not found.');

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'report.deleted',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'report',
      targetId: deleted._id,
      targetLabel: deleted.title,
    });
  }

  /* -------------------------------------------------------------- schedules */

  async listSchedules(organization: OrganizationContext): Promise<readonly ReportScheduleDto[]> {
    this.entitlements.assertFeature(organization, 'scheduled_reports');
    const rows = await this.repository.listSchedules(organization.objectId);
    return rows.map(toScheduleDto);
  }

  async createSchedule(
    organization: OrganizationContext,
    input: ReportScheduleInput,
    actor: Actor,
  ): Promise<ReportScheduleDto> {
    this.entitlements.assertFeature(organization, 'scheduled_reports');
    await this.entitlements.assertWithinLimit(organization, 'maxReportSchedules');

    const actorObjectId = toObjectId(actor.id);
    if (!actorObjectId) throw ApiError.unauthenticated();

    const schedule = await this.repository.createSchedule({
      organizationId: organization.objectId,
      name: input.name,
      frequency: input.frequency,
      dayOfWeek: input.dayOfWeek,
      hourUtc: input.hourUtc,
      type: input.type,
      websiteIds: (input.websiteIds ?? [])
        .map((id) => toObjectId(id))
        .filter((id): id is Types.ObjectId => id !== null),
      format: input.format,
      recipients: input.recipients,
      enabled: input.enabled,
      nextRunAt: nextScheduleRun(input.frequency, input.hourUtc, input.dayOfWeek, new Date()),
      createdByUserId: actorObjectId,
    });

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'report_schedule.created',
      actorUserId: actorObjectId,
      actorName: actor.name,
      targetType: 'report_schedule',
      targetId: schedule._id,
      targetLabel: schedule.name,
    });

    return toScheduleDto(schedule);
  }

  async updateSchedule(
    organization: OrganizationContext,
    scheduleId: string,
    input: UpdateReportScheduleInput,
    actor: Actor,
  ): Promise<ReportScheduleDto> {
    this.entitlements.assertFeature(organization, 'scheduled_reports');

    const existing = await this.repository.findScheduleById(organization.objectId, scheduleId);
    if (!existing) throw ApiError.notFound('REPORT_SCHEDULE_NOT_FOUND', 'Schedule not found.');

    const changes: Parameters<ReportRepository['updateSchedule']>[2] = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.frequency !== undefined) changes.frequency = input.frequency;
    if (input.dayOfWeek !== undefined) changes.dayOfWeek = input.dayOfWeek;
    if (input.hourUtc !== undefined) changes.hourUtc = input.hourUtc;
    if (input.format !== undefined) changes.format = input.format;
    if (input.enabled !== undefined) changes.enabled = input.enabled;
    if (input.recipients !== undefined) changes.recipients = [...input.recipients];
    if (input.websiteIds !== undefined) {
      changes.websiteIds = input.websiteIds
        .map((id) => toObjectId(id))
        .filter((id): id is Types.ObjectId => id !== null);
    }

    /*
     * Changing when a schedule runs recomputes the next occurrence. Without
     * this, moving a Monday-09:00 report to Friday-17:00 would still fire at
     * the already-scheduled Monday time once before taking effect.
     */
    const timingChanged =
      input.frequency !== undefined || input.dayOfWeek !== undefined || input.hourUtc !== undefined;
    if (timingChanged) {
      changes.nextRunAt = nextScheduleRun(
        input.frequency ?? existing.frequency,
        input.hourUtc ?? existing.hourUtc,
        input.dayOfWeek ?? existing.dayOfWeek,
        new Date(),
      );
    }

    const updated = await this.repository.updateSchedule(
      organization.objectId,
      scheduleId,
      changes,
    );
    if (!updated) throw ApiError.notFound('REPORT_SCHEDULE_NOT_FOUND', 'Schedule not found.');

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'report_schedule.updated',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'report_schedule',
      targetId: updated._id,
      targetLabel: updated.name,
    });

    return toScheduleDto(updated);
  }

  async deleteSchedule(
    organization: OrganizationContext,
    scheduleId: string,
    actor: Actor,
  ): Promise<void> {
    this.entitlements.assertFeature(organization, 'scheduled_reports');

    const deleted = await this.repository.deleteSchedule(organization.objectId, scheduleId);
    if (!deleted) throw ApiError.notFound('REPORT_SCHEDULE_NOT_FOUND', 'Schedule not found.');

    await this.audit.record({
      organizationId: organization.objectId,
      action: 'report_schedule.deleted',
      actorUserId: toObjectId(actor.id),
      actorName: actor.name,
      targetType: 'report_schedule',
      targetId: deleted._id,
      targetLabel: deleted.name,
    });
  }

  private async requireReport(
    organization: OrganizationContext,
    reportId: string,
  ): Promise<ReportRecord> {
    const report = await this.repository.findById(organization.objectId, reportId);
    if (!report) throw ApiError.notFound('REPORT_NOT_FOUND', 'Report not found.');
    return report;
  }

  private resolvePeriod(input: CreateReportInput): { from: Date; to: Date } {
    if (input.period === 'custom') {
      // The schema guarantees both are present for a custom period.
      return { from: new Date(input.from ?? ''), to: new Date(input.to ?? '') };
    }
    return resolveReportPeriod(input.period, new Date());
  }

  private defaultTitle(input: CreateReportInput, organizationName: string): string {
    const period = REPORT_PERIOD_LABELS[input.period];
    return input.type === 'website'
      ? `Website report · ${period}`
      : `${organizationName} · ${period}`;
  }
}

export function toReportDto(report: ReportRecord): ReportDto {
  return {
    id: report._id.toHexString(),
    type: report.type,
    title: report.title,
    status: report.status,
    periodStart: report.periodStart.toISOString(),
    periodEnd: report.periodEnd.toISOString(),
    websiteIds: report.websiteIds.map((id) => id.toHexString()),
    generatedAt: report.generatedAt?.toISOString() ?? null,
    errorMessage: report.errorMessage,
    scheduled: report.scheduleId !== null,
    createdAt: report.createdAt.toISOString(),
    /*
     * A summary rather than the whole payload: the list must not carry
     * hundreds of kilobytes per row, and the detail view fetches the report
     * itself when it needs more.
     *
     * The nullish check covers `undefined` as well as `null` on purpose. The
     * list query projects `data` away entirely, so a generated report arrives
     * here with the field *absent* rather than null — a strict `=== null`
     * check then fell through and dereferenced it, crashing the whole list.
     */
    summary:
      report.data == null
        ? null
        : {
            websiteCount: report.data.websiteCount,
            overallUptimePercentage: report.data.overallUptimePercentage,
            averageResponseTimeMs: report.data.averageResponseTimeMs,
            totalIncidents: report.data.totalIncidents,
            totalDowntimeSeconds: report.data.totalDowntimeSeconds,
          },
  };
}

export function toScheduleDto(schedule: ReportScheduleRecord): ReportScheduleDto {
  return {
    id: schedule._id.toHexString(),
    name: schedule.name,
    frequency: schedule.frequency,
    dayOfWeek: schedule.dayOfWeek,
    hourUtc: schedule.hourUtc,
    type: schedule.type,
    websiteIds: schedule.websiteIds.map((id) => id.toHexString()),
    format: schedule.format,
    recipients: schedule.recipients,
    enabled: schedule.enabled,
    nextRunAt: schedule.enabled ? schedule.nextRunAt.toISOString() : null,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    lastReportId: schedule.lastReportId?.toHexString() ?? null,
    lastError: schedule.lastError,
    createdAt: schedule.createdAt.toISOString(),
  };
}
