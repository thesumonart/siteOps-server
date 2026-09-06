import { env } from '../src/config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrations.js';

/**
 * Applies data migrations to the connected database.
 *
 * Runs **before** `pnpm indexes:sync` in a deployment. Some index changes only
 * succeed once existing documents have been brought up to date, and an index
 * build that fails halfway through on a live cluster is a far worse position
 * than one that was never started.
 *
 * Every migration is idempotent, so running this twice — or on a database that
 * is already current — reports zero changes and does nothing.
 */
async function main(): Promise<void> {
  await connectToDatabase({ uri: env.MONGODB_URI, appName: 'siteops-migrate' });

  const results = await runMigrations();

  for (const result of results) {
    process.stdout.write(
      `${result.name.padEnd(28)} ${String(result.documentsChanged).padStart(6)} changed  ${result.description}\n`,
    );
  }

  const total = results.reduce((sum, result) => sum + result.documentsChanged, 0);
  process.stdout.write(
    `\nRan ${String(results.length)} migrations; ${String(total)} documents changed.\n`,
  );

  await disconnectFromDatabase();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
