import { IncidentModel } from '../models/index.js';

/**
 * Data migrations that must run before `syncAllIndexes` on an existing database.
 *
 * SiteOps deliberately has no migration framework. Mongo collections are
 * schemaless, so almost every schema change here is additive and needs nothing:
 * a new optional field simply reads as absent on old documents.
 *
 * The exception — and the only reason this module exists — is a change that
 * makes an existing document violate a *new* index. Backfilling has to happen
 * before the index is built, or the build fails on a live cluster and leaves
 * the deployment half-applied.
 *
 * Every migration below must be idempotent: deployments are re-run, rolled
 * back and re-applied, and a migration that only works once is a migration that
 * breaks the second deploy.
 */

export interface MigrationResult {
  readonly name: string;
  readonly documentsChanged: number;
  readonly description: string;
}

/**
 * Gives every incident written before categories existed the `availability`
 * category.
 *
 * The unique index that deduplicates open incidents moved from `websiteId` to
 * `(websiteId, category)`. Without this backfill, an old open incident carries
 * no category and indexes as null, so the worker's next failure would insert a
 * *second* open incident for the same outage — the exact duplicate the index is
 * there to prevent — and both would then alert.
 *
 * Idempotent: the filter matches only documents that still lack the field.
 */
async function backfillIncidentCategories(): Promise<MigrationResult> {
  const result = await IncidentModel.collection.updateMany(
    { category: { $exists: false } },
    { $set: { category: 'availability', severity: 'critical', detail: null } },
  );

  return {
    name: 'incident-categories',
    documentsChanged: result.modifiedCount,
    description: 'Backfilled category, severity and detail on pre-category incidents.',
  };
}

const MIGRATIONS: readonly (() => Promise<MigrationResult>)[] = [backfillIncidentCategories];

/**
 * Runs every migration in order.
 *
 * Sequential rather than concurrent: a later migration may depend on an earlier
 * one having completed, and the total volume is small enough that the
 * parallelism would buy nothing.
 */
export async function runMigrations(): Promise<readonly MigrationResult[]> {
  const results: MigrationResult[] = [];
  for (const migration of MIGRATIONS) {
    results.push(await migration());
  }
  return results;
}
