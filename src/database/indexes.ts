import { syncAuthIndexes } from './auth-indexes.js';
import {
  AuditLogModel,
  BillingEventModel,
  ClientModel,
  IncidentModel,
  InvitationModel,
  MonitorResultModel,
  NotificationModel,
  NotificationSettingsModel,
  OrganizationMemberModel,
  OrganizationModel,
  ReportModel,
  ReportScheduleModel,
  WebsiteCheckModel,
  WebsiteModel,
  WebsiteMonitorModel,
  WorkerHeartbeatModel,
} from '../models/index.js';

/**
 * Applies every declared index to the connected database.
 *
 * This is the only thing that creates indexes in SiteOps. Mongoose's own
 * `autoIndex` does not work here: models are compiled when their module is
 * imported, which happens before `connectToDatabase` runs, and `bufferCommands`
 * is off — so the automatic build that would normally fire on connect never
 * completes, silently. That mattered more than it sounds: without these
 * indexes the database enforces none of the uniqueness the product relies on,
 * and duplicate incidents and repeated alert emails become possible.
 *
 * Returns a per-collection index count, which the operator script prints.
 */
export interface IndexSyncResult {
  readonly collection: string;
  readonly indexes: number;
}

/**
 * Every model whose indexes are managed here.
 *
 * Exported so `verify-indexes.ts` checks exactly the set that `syncAllIndexes`
 * creates — a model added to one list and not the other would give a clean
 * verification of a database missing an index.
 */
export const MANAGED_MODELS = [
  OrganizationModel,
  OrganizationMemberModel,
  WebsiteModel,
  WebsiteCheckModel,
  WebsiteMonitorModel,
  MonitorResultModel,
  IncidentModel,
  InvitationModel,
  ClientModel,
  ReportModel,
  ReportScheduleModel,
  NotificationModel,
  NotificationSettingsModel,
  AuditLogModel,
  /*
   * Billing events carry the unique index on `eventId` that makes webhook
   * delivery idempotent. It was declared on the schema and never applied here,
   * and because `MONGODB_AUTO_INDEX` is false in production it was therefore
   * never created there — so a provider retry, which is routine and expected,
   * would have been processed a second time.
   */
  BillingEventModel,
  /*
   * Heartbeats carry a unique key and a TTL. Without the unique index one
   * process can become two documents and a dead worker looks like a healthy
   * pair; without the TTL every deploy's instance accumulates forever.
   */
  WorkerHeartbeatModel,
] as const;

export async function syncAllIndexes(): Promise<readonly IndexSyncResult[]> {
  const results: IndexSyncResult[] = [];

  for (const model of MANAGED_MODELS) {
    await model.syncIndexes();
    const indexes = await model.listIndexes();
    results.push({ collection: model.collection.collectionName, indexes: indexes.length });
  }

  // The auth collections are created by Better Auth but indexed here; see
  // auth-indexes.ts for why uniqueness cannot be left to the library.
  const authIndexes = await syncAuthIndexes();
  results.push({ collection: 'auth collections', indexes: authIndexes });

  return results;
}
