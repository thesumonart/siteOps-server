import { env, isProduction } from '../src/config/env.js';
import {
  DEFAULT_MONITORING_INTERVAL_SECONDS,
  normalizeWebsiteUrl,
} from '../src/contracts/index.js';
import { connectToDatabase, disconnectFromDatabase } from '../src/database/connection.js';
import { syncAllIndexes } from '../src/database/indexes.js';
import { OrganizationMemberModel, OrganizationModel, WebsiteModel } from '../src/models/index.js';
import { UserModel } from '../src/models/user.model.js';

/**
 * Seeds an organization and a few websites for an existing account.
 *
 * It deliberately does **not** create the account. Passwords and sessions
 * belong to the authentication layer, and a seed script that wrote a password
 * hash by hand would be a second implementation of the one thing that must have
 * exactly one. Register through the dashboard (or the API) first, verify the
 * address, then run this with that address.
 *
 * Usage:  pnpm seed you@example.com
 */

const SEED_WEBSITES: readonly { name: string; url: string }[] = [
  { name: 'Example', url: 'https://example.com' },
  { name: 'Mozilla', url: 'https://developer.mozilla.org' },
  { name: 'Wikipedia', url: 'https://www.wikipedia.org' },
];

async function main(): Promise<void> {
  if (isProduction) {
    throw new Error('Refusing to seed a production database.');
  }

  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    throw new Error('Usage: pnpm seed <email of an existing, verified account>');
  }

  await connectToDatabase({ uri: env.MONGODB_URI, appName: 'siteops-seed' });
  await syncAllIndexes();

  const user = await UserModel.findOne({ email }).select({ _id: 1, name: 1 }).lean().exec();
  if (!user) {
    throw new Error(
      `No account found for ${email}. Register and verify it in the dashboard first.`,
    );
  }

  const slug = `seed-${Date.now().toString(36)}`;
  const organization = await OrganizationModel.create({
    name: 'Seed Agency',
    slug,
    timezone: 'UTC',
    createdByUserId: user._id,
  });

  await OrganizationMemberModel.create({
    organizationId: organization._id,
    userId: user._id,
    role: 'owner',
    invitedByUserId: null,
    joinedAt: new Date(),
  });

  for (const site of SEED_WEBSITES) {
    const normalized = normalizeWebsiteUrl(site.url);
    // Every seeded URL goes through the same validation a user's would, so the
    // seed cannot introduce a target the product would have refused.
    if (!normalized.ok) throw new Error(`Seed URL rejected: ${site.url} — ${normalized.detail}`);

    await WebsiteModel.create({
      organizationId: organization._id,
      name: site.name,
      url: normalized.value.href,
      canonicalKey: normalized.value.canonicalKey,
      status: 'unknown',
      monitoringEnabled: true,
      monitoringIntervalSeconds: DEFAULT_MONITORING_INTERVAL_SECONDS,
      nextCheckAt: new Date(),
    });
  }

  process.stdout.write(
    `Seeded organization "${organization.name}" (${slug}) with ${String(SEED_WEBSITES.length)} websites for ${email}.\n` +
      'Start the worker to see the first checks land.\n',
  );

  await disconnectFromDatabase();
}

main().catch((error: unknown) => {
  process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
