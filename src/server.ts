import type { Server } from 'node:http';

import { createApp } from './app.js';
import { env, trustedOrigins } from './config/env.js';
import { connectToDatabase, disconnectFromDatabase } from './database/connection.js';
import { createLogger, logger } from './utils/logger.js';

const log = createLogger('server');

/**
 * API process entry point.
 *
 * Owns lifecycle only: connect, listen, shut down cleanly. Everything the
 * application does lives behind `createApp`.
 */

/**
 * How long a graceful shutdown may take before the process is killed outright.
 * Comfortably under the 30s most platforms allow between SIGTERM and SIGKILL,
 * so it is this watchdog — not the platform — that ends a stuck shutdown, and
 * the reason is recorded in our own logs.
 */
const SHUTDOWN_WATCHDOG_MS = 25_000;

interface RuntimeState {
  shuttingDown: boolean;
  server: Server | null;
}

const state: RuntimeState = { shuttingDown: false, server: null };

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  log.info({ signal }, 'api.shutdown_started');

  /*
   * Nothing below calls process.exit(). Once the server has stopped accepting
   * connections and the database pool is drained, no handles remain and Node
   * exits on its own with the code set here — which guarantees in-flight
   * requests finish first.
   */
  process.exitCode = exitCode;

  const watchdog = setTimeout(() => {
    log.error({ signal }, 'api.shutdown_timed_out');
    // The one place an abrupt exit is correct: a handle has failed to release,
    // and waiting longer would let the platform SIGKILL us with no log line.
    // eslint-disable-next-line n/no-process-exit -- forced exit is this watchdog's purpose
    process.exit(exitCode === 0 ? 1 : exitCode);
  }, SHUTDOWN_WATCHDOG_MS);
  // Never let the watchdog itself keep the process alive.
  watchdog.unref();

  /*
   * Each step is attempted independently.
   *
   * A single try/catch around all of them means the first failure skips the
   * rest — and the step most likely to fail is closing a server that never
   * successfully bound, while the step that must never be skipped is draining
   * the database pool. Getting that order wrong leaves an open pool holding the
   * process alive with nothing left to do, which is a hang rather than an exit.
   */
  const failures = [
    await attempt('api.server_close_failed', closeServer),
    await attempt('api.database_disconnect_failed', disconnectFromDatabase),
  ].filter(Boolean).length;

  if (failures > 0) {
    process.exitCode = 1;
    log.error({ signal, failures }, 'api.shutdown_failed');
  } else {
    log.info('api.shutdown_complete');
  }

  clearTimeout(watchdog);
}

/** Runs one shutdown step, logging rather than propagating a failure. */
async function attempt(event: string, step: () => Promise<void>): Promise<boolean> {
  try {
    await step();
    return false;
  } catch (error) {
    log.error({ err: error }, event);
    return true;
  }
}

/**
 * Stops accepting connections and waits for in-flight requests.
 *
 * `close()` reports "server was not running" as an error, which is the normal
 * outcome when shutdown was triggered by a failed bind. That is not a failure
 * worth reporting, so it resolves.
 */
async function closeServer(): Promise<void> {
  const server = state.server;
  if (!server?.listening) return;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function bootstrap(): Promise<void> {
  // Fail before the HTTP server binds if the database is unreachable, so the
  // platform never routes traffic to an API that cannot serve it.
  await connectToDatabase({
    uri: env.MONGODB_URI,
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    autoIndex: env.MONGODB_AUTO_INDEX,
    appName: 'siteops-api',
  });
  log.info('database.connected');

  const app = createApp();

  const server = app.listen(env.PORT, '0.0.0.0', () => {
    log.info({ port: env.PORT, environment: env.NODE_ENV, trustedOrigins }, 'api.started');
  });

  /*
   * A failed bind arrives as an `error` event, and an unhandled one takes the
   * process down with a raw stack trace. A port already in use is a normal
   * operational situation — a stale instance during a rolling deploy — and it
   * deserves a log line an operator can act on.
   */
  server.on('error', (error: NodeJS.ErrnoException) => {
    log.fatal({ err: error, port: env.PORT }, 'api.listen_failed');
    void shutdown('api.listen_failed', 1);
  });

  // A client that opens a connection and sends nothing must not hold a socket
  // indefinitely; neither must a request that trickles in a byte at a time.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  state.server = server;

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal, 0);
    });
  }

  // An unhandled rejection leaves the process in an unknown state. Shut down so
  // the platform restarts a clean one, rather than continuing to serve requests
  // from a process that may be holding a half-applied change.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'api.unhandled_rejection');
    void shutdown('unhandledRejection', 1);
  });
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'api.bootstrap_failed');
  process.exitCode = 1;
});
