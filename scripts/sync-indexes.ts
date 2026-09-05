import { env } from '../src/config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../src/database/connection.js';
import { syncAllIndexes } from '../src/database/indexes.js';

/**
 * Creates or updates every declared index on the connected database.
 *
 * This is a deployment step, not something a starting process does: an index
 * build issued by a booting API can stall a live cluster, so `MONGODB_AUTO_INDEX`
 * is false in production and this runs explicitly instead.
 *
 * Skipping it does not look like a failure. Every query still returns rows and
 * every page still renders — the only symptom is that guarantees the product
 * depends on quietly stop holding: a website monitored twice, two incidents for
 * one outage, the same alert email sent again. Run `indexes:verify` after a
 * deploy to prove it happened.
 */
async function main(): Promise<void> {
  await connectToDatabase({ uri: env.MONGODB_URI, appName: 'siteops-indexes' });

  const results = await syncAllIndexes();

  for (const result of results) {
    process.stdout.write(`${result.collection.padEnd(28)} ${String(result.indexes)} indexes\n`);
  }
  process.stdout.write(`\nSynced ${String(results.length)} collections.\n`);

  await disconnectFromDatabase();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Index sync failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
