import { env } from '../src/config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../src/database/connection.js';
import { verifyAllIndexes } from '../src/database/verify-indexes.js';

/**
 * Reports which declared indexes are missing, without creating anything.
 *
 * The read-only counterpart to `indexes:sync`, and the check worth running
 * straight after a deploy. Exits non-zero when anything is missing, so it can
 * be a deployment gate.
 *
 * Extra indexes are reported as information rather than as a failure: an index
 * added by hand while diagnosing a slow query is a normal thing to find, and
 * this should not order anyone to delete it.
 */
async function main(): Promise<void> {
  await connectToDatabase({ uri: env.MONGODB_URI, appName: 'siteops-indexes' });

  const report = await verifyAllIndexes();

  for (const entry of report.collections) {
    if (entry.missing.length === 0 && entry.unexpected.length === 0) {
      process.stdout.write(`ok        ${entry.collection}\n`);
      continue;
    }
    if (entry.missing.length > 0) {
      process.stdout.write(`MISSING   ${entry.collection}: ${entry.missing.join(', ')}\n`);
    }
    if (entry.unexpected.length > 0) {
      process.stdout.write(`extra     ${entry.collection}: ${entry.unexpected.join(', ')}\n`);
    }
  }

  await disconnectFromDatabase();

  if (report.missingCount > 0) {
    process.stdout.write(
      `\n${String(report.missingCount)} index(es) missing. Run \`pnpm indexes:sync\`.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\nEvery declared index is present.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Index verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
