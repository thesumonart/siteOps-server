import { env } from '../../src/config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../../src/database/connection.js';
import {
  AuditLogModel,
  IncidentModel,
  InvitationModel,
  NotificationModel,
  NotificationSettingsModel,
  OrganizationMemberModel,
  OrganizationModel,
  UserModel,
  WebsiteCheckModel,
  WebsiteModel,
} from '../../src/models/index.js';

/**
 * Real-database test harness.
 *
 * The guarantees these integration tests exist to prove — the unique partial
 * index that allows at most one open incident per website, the unique
 * `dedupeKey` index that makes a duplicate notification impossible — are
 * enforced by MongoDB itself, not by application code. A mocked model can
 * never actually prove a unique index rejects a duplicate insert; only a real
 * database can. See the "Test" step in `.github/workflows/ci.yml`.
 */

/**
 * Thunks rather than a bare array of models: TypeScript's overload resolution
 * for a method call on a *union* of `Model<T>` types (`Model<A> | Model<B>`)
 * does not behave like calling each variant separately — it can silently pick
 * a mismatched overload. Closing over each concretely-typed model inside its
 * own function sidesteps the union entirely.
 */
const SYNC_INDEXES: readonly (() => Promise<unknown>)[] = [
  () => OrganizationModel.syncIndexes(),
  () => OrganizationMemberModel.syncIndexes(),
  () => UserModel.syncIndexes(),
  () => WebsiteModel.syncIndexes(),
  () => WebsiteCheckModel.syncIndexes(),
  () => IncidentModel.syncIndexes(),
  () => NotificationModel.syncIndexes(),
  () => NotificationSettingsModel.syncIndexes(),
  () => InvitationModel.syncIndexes(),
  () => AuditLogModel.syncIndexes(),
];

const CLEAR_COLLECTIONS: readonly (() => Promise<unknown>)[] = [
  () => OrganizationModel.deleteMany({}).exec(),
  () => OrganizationMemberModel.deleteMany({}).exec(),
  () => UserModel.deleteMany({}).exec(),
  () => WebsiteModel.deleteMany({}).exec(),
  () => WebsiteCheckModel.deleteMany({}).exec(),
  () => IncidentModel.deleteMany({}).exec(),
  () => NotificationModel.deleteMany({}).exec(),
  () => NotificationSettingsModel.deleteMany({}).exec(),
  () => InvitationModel.deleteMany({}).exec(),
  () => AuditLogModel.deleteMany({}).exec(),
];

let connected = false;
let available: boolean | null = null;

/**
 * Whether a MongoDB is reachable for integration tests.
 *
 * Checked once and cached. Tests that need a database skip themselves when
 * there is none, rather than failing: `pnpm test` has to be runnable on a
 * machine with nothing else started, and a suite that always fails is a suite
 * people stop reading. CI and `pnpm docker:up` both provide one, so the tests
 * that matter still run where it counts.
 */
export async function databaseAvailable(): Promise<boolean> {
  if (available !== null) return available;
  try {
    await connectTestDatabase();
    available = true;
  } catch {
    available = false;
  }
  if (!available) {
    process.stderr.write(
      'No MongoDB at MONGODB_URI; skipping integration tests. Run `pnpm docker:up`.\n',
    );
  }
  return available;
}

export async function connectTestDatabase(): Promise<void> {
  if (connected) return;

  await connectToDatabase({
    uri: env.MONGODB_URI,
    appName: 'siteops-test',
    // Fail fast rather than spending ten seconds discovering there is no
    // database, on every file that asks.
    serverSelectionTimeoutMs: 3_000,
  });

  // Indexes are not built automatically outside development (see
  // `connection.ts`), so the unique indexes under test have to be created
  // explicitly here — without this, a "duplicate insert" test would pass for
  // the wrong reason: nothing would actually reject the duplicate.
  await Promise.all(SYNC_INDEXES.map((sync) => sync()));

  connected = true;
}

export async function disconnectTestDatabase(): Promise<void> {
  if (!connected) return;
  await disconnectFromDatabase();
  connected = false;
}

/** Clears every collection touched by these tests, run between test cases. */
export async function clearTestDatabase(): Promise<void> {
  await Promise.all(CLEAR_COLLECTIONS.map((clear) => clear()));
}
