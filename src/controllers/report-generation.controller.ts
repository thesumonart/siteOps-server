import type { Request, Response } from 'express';

import type {
  CreateReportInput,
  DownloadReportQuery,
  ListReportsQuery,
  ReportScheduleInput,
  UpdateReportScheduleInput,
} from '../contracts/index.js';
import { currentUser } from '../middlewares/auth.middleware.js';
import { currentOrganization } from '../middlewares/organization.middleware.js';
import {
  validatedBody,
  validatedParams,
  validatedQuery,
} from '../middlewares/validate.middleware.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import type { ReportGenerationService } from '../services/report-generation.service.js';

/**
 * Reports and their schedules.
 *
 * The download handler is the one place in the API that does not return the
 * standard envelope, and it is a deliberate exception: a browser downloading a
 * PDF needs the bytes and a `Content-Disposition`, not JSON wrapping base64.
 * Every failure path still returns the envelope, so a client's error handling
 * is unchanged.
 */
export class ReportGenerationController {
  constructor(private readonly reports: ReportGenerationService) {}

  list = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const query = validatedQuery<ListReportsQuery>(request);

    ApiResponse.ok(response, await this.reports.list(organization, query));
  };

  /** Queues a report. The worker builds it; this returns immediately. */
  create = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const input = validatedBody<CreateReportInput>(request);

    const report = await this.reports.request(organization, input, {
      id: user.id,
      name: user.name,
    });
    ApiResponse.created(response, report);
  };

  getById = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { reportId } = validatedParams<{ reportId: string }>(request);

    ApiResponse.ok(response, await this.reports.findById(organization, reportId));
  };

  download = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);
    const { reportId } = validatedParams<{ reportId: string }>(request);
    const { format } = validatedQuery<DownloadReportQuery>(request);

    const rendered = await this.reports.download(organization, reportId, format);

    response.setHeader('Content-Type', rendered.contentType);
    /*
     * The filename is derived from the title with everything outside
     * `[a-z0-9-]` replaced, so it cannot carry a quote or a newline into this
     * header — a header injection or a spoofed extension would both start
     * there. `attachment` rather than `inline` so a rendered document is never
     * executed in the site's own origin.
     */
    response.setHeader('Content-Disposition', `attachment; filename="${rendered.filename}"`);
    response.setHeader('Content-Length', String(rendered.body.byteLength));
    // A report is a snapshot of a moment; a cached copy would silently be the
    // wrong one after a regeneration.
    response.setHeader('Cache-Control', 'private, no-store');
    response.status(200).end(rendered.body);
  };

  remove = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const { reportId } = validatedParams<{ reportId: string }>(request);

    await this.reports.delete(organization, reportId, { id: user.id, name: user.name });
    ApiResponse.noContent(response);
  };

  /* -------------------------------------------------------------- schedules */

  listSchedules = async (request: Request, response: Response): Promise<void> => {
    const organization = currentOrganization(request);

    ApiResponse.ok(response, { items: await this.reports.listSchedules(organization) });
  };

  createSchedule = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const input = validatedBody<ReportScheduleInput>(request);

    const schedule = await this.reports.createSchedule(organization, input, {
      id: user.id,
      name: user.name,
    });
    ApiResponse.created(response, schedule);
  };

  updateSchedule = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const { scheduleId } = validatedParams<{ scheduleId: string }>(request);
    const input = validatedBody<UpdateReportScheduleInput>(request);

    const schedule = await this.reports.updateSchedule(organization, scheduleId, input, {
      id: user.id,
      name: user.name,
    });
    ApiResponse.ok(response, schedule);
  };

  removeSchedule = async (request: Request, response: Response): Promise<void> => {
    const user = currentUser(request);
    const organization = currentOrganization(request);
    const { scheduleId } = validatedParams<{ scheduleId: string }>(request);

    await this.reports.deleteSchedule(organization, scheduleId, { id: user.id, name: user.name });
    ApiResponse.noContent(response);
  };
}
