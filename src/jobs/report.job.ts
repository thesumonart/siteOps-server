import type { Types } from 'mongoose';

import { env } from '../config/env.js';
import { nextScheduleRun, type ReportData } from '../contracts/index.js';
import type { EmailService } from '../email/email.service.js';
import { reportReadyTemplate } from '../email/templates/index.js';
import { OrganizationModel } from '../models/index.js';
import type { ReportRepository, ReportScheduleRecord } from '../repositories/report.repository.js';
import { buildReport } from '../reporting/report-builder.js';
import { renderReport } from '../reporting/renderers/index.js';
import type { BrandingService } from '../services/branding.service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('report-job');

/**
 * Building reports and delivering the scheduled ones.
 *
 * Runs on the worker because generation is a set of aggregations over the
 * largest collections in the product. A month across fifty websites is not
 * something to run while an HTTP connection waits, and putting it in the API
 * would make one person's report everybody else's latency.
 */

/** Attempts before a report settles on `failed` with the reason visible. */
const MAX_GENERATION_ATTEMPTS = 3;

/**
 * Cap on the rendered attachment.
 *
 * Most mail providers reject anything much past this, and a bounced report is
 * worse than one that arrives with a link instead. A report that renders larger
 * is delivered as a notification pointing at the dashboard.
 */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export interface ReportJobDependencies {
  readonly reports: ReportRepository;
  readonly branding: BrandingService;
  readonly emailService: EmailService;
}

/**
 * Builds one claimed report.
 *
 * A failure is recorded on the document with a readable reason and retried with
 * backoff. After the cap it settles as `failed` — the usual cause is a query
 * that will fail identically next time, and retrying forever only hides it.
 */
export async function runReportGeneration(
  report: {
    readonly _id: Types.ObjectId;
    readonly organizationId: Types.ObjectId;
    readonly websiteIds: readonly Types.ObjectId[];
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly attemptCount: number;
    readonly scheduleId: Types.ObjectId | null;
  },
  dependencies: ReportJobDependencies,
): Promise<ReportData | null> {
  const startedAt = Date.now();

  try {
    const organization = await OrganizationModel.findById(report.organizationId)
      .select({ name: 1 })
      .lean<{ name: string }>()
      .exec();

    if (!organization) {
      // The organization was deleted between the request and the run. Not
      // retryable, and not an error worth alerting on.
      await dependencies.reports.markAttemptFailed(
        report._id,
        MAX_GENERATION_ATTEMPTS,
        MAX_GENERATION_ATTEMPTS,
        'The organization no longer exists.',
      );
      return null;
    }

    const data = await buildReport({
      organizationId: report.organizationId,
      organizationName: organization.name,
      websiteIds: report.websiteIds,
      from: report.periodStart,
      to: report.periodEnd,
    });

    await dependencies.reports.markReady(report._id, data);

    logger.info(
      {
        reportId: report._id.toHexString(),
        websiteCount: data.websiteCount,
        durationMs: Date.now() - startedAt,
      },
      'report.generated',
    );

    return data;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Report generation failed.';

    await dependencies.reports.markAttemptFailed(
      report._id,
      report.attemptCount,
      MAX_GENERATION_ATTEMPTS,
      reason,
    );

    logger.error(
      { err: error, reportId: report._id.toHexString(), attempt: report.attemptCount },
      'report.generation_failed',
    );

    return null;
  }
}

/**
 * Runs one claimed schedule: create the report, build it, mail it.
 *
 * The schedule's next occurrence is set in a `finally` regardless of outcome.
 * A schedule left at a past `nextRunAt` because delivery failed would be
 * re-claimed on the very next tick and would mail the same report repeatedly —
 * the failure mode that matters most in a feature whose output goes to a
 * customer's client.
 */
export async function runScheduledReport(
  schedule: ReportScheduleRecord,
  dependencies: ReportJobDependencies,
): Promise<void> {
  let reportId: Types.ObjectId | null = null;
  let error: string | null = null;

  try {
    const { from, to } = periodFor(schedule);

    const report = await dependencies.reports.create({
      organizationId: schedule.organizationId,
      type: schedule.type,
      title: schedule.name,
      periodStart: from,
      periodEnd: to,
      websiteIds: schedule.websiteIds,
      // Nobody pressed a button, so there is no actor to record.
      requestedByUserId: null,
      scheduleId: schedule._id,
    });
    reportId = report._id;

    const data = await runReportGeneration(
      {
        _id: report._id,
        organizationId: report.organizationId,
        websiteIds: report.websiteIds,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        attemptCount: 1,
        scheduleId: schedule._id,
      },
      dependencies,
    );

    if (data === null) {
      error = 'The report could not be generated.';
      return;
    }

    await deliver(schedule, report._id, report.title, data, dependencies);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'The scheduled report failed.';
    logger.error({ err: caught, scheduleId: schedule._id.toHexString() }, 'report.schedule_failed');
  } finally {
    await dependencies.reports
      .completeScheduleRun(
        schedule._id,
        nextScheduleRun(schedule.frequency, schedule.hourUtc, schedule.dayOfWeek, new Date()),
        { reportId, error },
      )
      .catch((releaseError: unknown) => {
        // The lease expiring is the backstop, but a schedule stuck here would
        // re-send, so this is logged loudly rather than swallowed.
        logger.error(
          { err: releaseError, scheduleId: schedule._id.toHexString() },
          'report.schedule_release_failed',
        );
      });
  }
}

/**
 * The period a scheduled run covers.
 *
 * A monthly schedule runs on the 1st and covers the calendar month that just
 * ended; a weekly one covers the seven days before it ran. Both are what the
 * recipient expects from the words on the schedule.
 */
function periodFor(schedule: ReportScheduleRecord): { from: Date; to: Date } {
  const now = new Date();

  if (schedule.frequency === 'monthly') {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      from: new Date(Date.UTC(year, month - 1, 1)),
      to: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
    };
  }

  return { from: new Date(now.getTime() - 7 * 86_400_000), to: now };
}

/**
 * Renders and emails the report to each recipient.
 *
 * Sent individually rather than to a shared To line: a client contact should
 * not learn the addresses of an agency's other clients, and one rejected
 * address must not stop the rest being delivered.
 */
async function deliver(
  schedule: ReportScheduleRecord,
  reportId: Types.ObjectId,
  title: string,
  data: ReportData,
  dependencies: ReportJobDependencies,
): Promise<void> {
  const branding = await dependencies.branding.forOrganizationId(schedule.organizationId);

  const rendered = await renderReport({
    title,
    data,
    format: schedule.format,
    branding,
  });

  const attachable = rendered.body.byteLength <= MAX_ATTACHMENT_BYTES;
  if (!attachable) {
    logger.warn(
      { reportId: reportId.toHexString(), bytes: rendered.body.byteLength },
      'report.attachment_too_large',
    );
  }

  const content = reportReadyTemplate({
    title,
    brandName: branding.brandName,
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
    websiteCount: data.websiteCount,
    uptimePercentage: data.overallUptimePercentage,
    incidentCount: data.totalIncidents,
    dashboardUrl: `${env.APP_URL}/dashboard/reports/${reportId.toHexString()}`,
    attached: attachable,
  });

  for (const recipient of schedule.recipients) {
    const result = await dependencies.emailService.send({
      to: recipient,
      ...content,
      ...(attachable
        ? {
            attachments: [
              {
                filename: rendered.filename,
                content: rendered.body,
                contentType: rendered.contentType,
              },
            ],
          }
        : {}),
    });

    if (!result.delivered) {
      logger.error(
        { scheduleId: schedule._id.toHexString(), reason: result.reason },
        'report.delivery_failed',
      );
    }
  }
}
