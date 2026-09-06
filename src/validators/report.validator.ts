import { z } from 'zod';

import {
  createReportSchema,
  downloadReportQuerySchema,
  listReportsQuerySchema,
  listWebsiteChecksQuerySchema,
  objectIdSchema,
  reportScheduleSchema,
  updateReportScheduleSchema,
  websiteStatsQuerySchema,
} from '../contracts/index.js';
import type { ValidationSchemas } from '../middlewares/validate.middleware.js';
import { websiteParamsSchema } from './common.validator.js';

const reportParamsSchema = z.object({ reportId: objectIdSchema });
const scheduleParamsSchema = z.object({ scheduleId: objectIdSchema });

export const reportValidators = {
  websiteStats: {
    params: websiteParamsSchema,
    query: websiteStatsQuerySchema,
  } satisfies ValidationSchemas,
  websiteUptime: {
    params: websiteParamsSchema,
    query: websiteStatsQuerySchema,
  } satisfies ValidationSchemas,
  websiteChecks: {
    params: websiteParamsSchema,
    query: listWebsiteChecksQuerySchema,
  } satisfies ValidationSchemas,
} as const;

export const generatedReportValidators = {
  list: { query: listReportsQuerySchema } satisfies ValidationSchemas,
  create: { body: createReportSchema } satisfies ValidationSchemas,
  getById: { params: reportParamsSchema } satisfies ValidationSchemas,
  download: {
    params: reportParamsSchema,
    query: downloadReportQuerySchema,
  } satisfies ValidationSchemas,
  remove: { params: reportParamsSchema } satisfies ValidationSchemas,
  createSchedule: { body: reportScheduleSchema } satisfies ValidationSchemas,
  updateSchedule: {
    params: scheduleParamsSchema,
    body: updateReportScheduleSchema,
  } satisfies ValidationSchemas,
  removeSchedule: { params: scheduleParamsSchema } satisfies ValidationSchemas,
} as const;
