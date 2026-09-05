import { AUTH_INDEXES } from './auth-indexes.js';
import { getMongoDb } from './connection.js';
import { MANAGED_MODELS } from './indexes.js';

/**
 * Reports which declared indexes are missing from the connected database,
 * without creating anything.
 *
 * The read-only counterpart to `syncAllIndexes`, and the check worth running
 * straight after a deploy. Missing indexes do not announce themselves: every
 * query still returns rows, every page still renders, and the only symptom is
 * that guarantees the product depends on quietly stop holding — a website
 * monitored twice, two incidents for one outage, the same alert email sent
 * again. A deployment that skipped the sync looks completely healthy.
 *
 * Extra indexes are reported too, but as information rather than a failure:
 * an index added by hand while diagnosing a slow query is a normal thing to
 * find, and this should not order anyone to delete it.
 */

export interface IndexVerification {
  readonly collection: string;
  /** Declared in the schema but absent from the database. */
  readonly missing: readonly string[];
  /** Present in the database but not declared here. */
  readonly unexpected: readonly string[];
}

export interface IndexVerificationReport {
  readonly collections: readonly IndexVerification[];
  readonly missingCount: number;
}

export async function verifyAllIndexes(): Promise<IndexVerificationReport> {
  const collections: IndexVerification[] = [];

  for (const model of MANAGED_MODELS) {
    const declared = new Set(
      model.schema
        .indexes()
        .map(([, options]) => (options as { name?: string }).name)
        .filter((name): name is string => typeof name === 'string'),
    );

    collections.push(
      await compare(model.collection.collectionName, declared, () =>
        model
          .listIndexes()
          .then((indexes: { name?: string }[]) => indexes.map((index) => index.name)),
      ),
    );
  }

  // Better Auth creates these collections; the indexes on them are ours. See
  // auth-indexes.ts for why uniqueness cannot be left to the library.
  const db = getMongoDb();
  const authCollections = [...new Set(AUTH_INDEXES.map((index) => index.collection))];

  for (const collection of authCollections) {
    const declared = new Set(
      AUTH_INDEXES.filter((index) => index.collection === collection).map((index) => index.name),
    );

    collections.push(
      await compare(collection, declared, async () => {
        const indexes = await db.collection(collection).indexes();
        return indexes.map((index) => index.name);
      }),
    );
  }

  return {
    collections,
    missingCount: collections.reduce((total, entry) => total + entry.missing.length, 0),
  };
}

async function compare(
  collection: string,
  declared: ReadonlySet<string>,
  listNames: () => Promise<(string | undefined)[]>,
): Promise<IndexVerification> {
  let existing: Set<string>;

  try {
    existing = new Set(
      (await listNames()).filter((name): name is string => typeof name === 'string'),
    );
  } catch {
    // A collection with no documents yet does not exist, so it has no indexes.
    // That is the same situation as an unsynced one from this check's point of
    // view: nothing is enforcing anything.
    existing = new Set();
  }

  return {
    collection,
    missing: [...declared].filter((name) => !existing.has(name)).sort(),
    // `_id_` is created by MongoDB itself and is never declared here.
    unexpected: [...existing].filter((name) => name !== '_id_' && !declared.has(name)).sort(),
  };
}
