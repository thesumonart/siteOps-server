import type { Db } from 'mongodb';
import mongoose, { type Connection, type Mongoose } from 'mongoose';

/**
 * The process-wide MongoDB connection.
 *
 * Better Auth needs a raw driver `Db` handle rather than a Mongoose connection,
 * so it is handed the driver underneath this one instead of opening a second
 * pool. One pool keeps us inside the MongoDB Atlas free-tier connection limit,
 * which is the tightest constraint in the initial deployment.
 */

export interface DatabaseConnectionOptions {
  readonly uri: string;
  /**
   * Upper bound on pooled sockets. The API and the worker each hold their own
   * pool, so the sum must stay under the cluster limit.
   */
  readonly maxPoolSize?: number;
  readonly minPoolSize?: number;
  readonly serverSelectionTimeoutMs?: number;
  /**
   * Applies every declared index after connecting. Convenient in development
   * and dangerous in production, where an index build issued by a starting
   * process can stall a live cluster — production runs `pnpm indexes:sync` as
   * an explicit deployment step instead.
   *
   * This performs an explicit sync rather than setting Mongoose's own
   * `autoIndex`, which does nothing here: models are compiled at import time,
   * before this function runs, and `bufferCommands` is off, so the automatic
   * build never happens. Left to Mongoose, a development database ends up with
   * no unique indexes at all — and therefore none of the guarantees the product
   * depends on, duplicate incidents and repeated alert emails included.
   */
  readonly autoIndex?: boolean;
  readonly appName?: string;
}

let connectionPromise: Promise<Mongoose> | null = null;

mongoose.set('strictQuery', true);
// Surfaces a clear error instead of buffering a query forever when the driver
// is not connected. A silent hang is the worst failure mode for a worker.
mongoose.set('bufferCommands', false);

export async function connectToDatabase(options: DatabaseConnectionOptions): Promise<Mongoose> {
  connectionPromise ??= mongoose.connect(options.uri, {
    maxPoolSize: options.maxPoolSize ?? 10,
    minPoolSize: options.minPoolSize ?? 0,
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMs ?? 10_000,
    autoIndex: false,
    appName: options.appName ?? 'siteops',
    retryWrites: true,
  });

  let connection: Mongoose;
  try {
    connection = await connectionPromise;
  } catch (error) {
    // Reset so a later attempt can retry rather than await a rejected promise.
    connectionPromise = null;
    throw error;
  }

  if (options.autoIndex) {
    // Imported lazily: the sync module pulls in every model, and a process that
    // never asks for indexes should not pay to load them.
    const { syncAllIndexes } = await import('./indexes.js');
    await syncAllIndexes();
  }

  return connection;
}

export function getConnection(): Connection {
  return mongoose.connection;
}

/** Raw driver handle, used by Better Auth's MongoDB adapter. */
export function getMongoDb(): Db {
  const { db } = mongoose.connection;
  if (!db) {
    throw new Error('Database is not connected. Call connectToDatabase() during startup.');
  }
  return db;
}

export function isConnected(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

export async function disconnectFromDatabase(): Promise<void> {
  connectionPromise = null;
  await mongoose.disconnect();
}

/**
 * Readiness probe. Uses `ping` rather than `readyState` so it reports the state
 * of an actual server round trip, not just the local socket.
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    await getMongoDb().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export { mongoose };
