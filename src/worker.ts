import { createServer, type Server } from 'node:http';

import { env } from './config/env.js';
import { connectToDatabase, disconnectFromDatabase, pingDatabase } from './database/connection.js';
import { MonitoringRuntime } from './jobs/monitoring-runtime.js';
import { createLogger, logger } from './utils/logger.js';

const log = createLogger('worker');

/**
 * Monitoring worker entry point.
 *
 * Owns process lifecycle only: configuration, the database connection, the
 * health surface, the monitoring runtime and an orderly shutdown. Everything
 * the worker actually *does* lives in `MonitoringRuntime`, which the API
 * process can also host — see `MONITORING_RUNTIME` in the environment schema.
 *
 * A separate process from the API by default, on purpose. Monitoring is
 * long-running I/O against hostile-by-default targets, and it must not compete
 * with request handling for the event loop, the connection pool or a restart.
 * Stopping the process always drains work in progress rather than killing a
 * check mid-flight.
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
  healthServer: Server | null;
  monitoring: MonitoringRuntime | null;
}

const state: RuntimeState = {
  shuttingDown: false,
  healthServer: null,
  monitoring: null,
};

/**
 * Minimal HTTP surface for platform probes.
 *
 * A background worker with no listening port is treated as crashed by most
 * low-cost hosts, and `/health/ready` is what stops traffic — or a deploy's
 * health gate — being pointed at an instance whose database has gone away.
 * `/health` deliberately performs no dependency I/O: a slow database must not
 * trigger a restart loop.
 */
function startHealthServer(port: number): Server {
  const server = createServer((request, response) => {
    const url = request.url ?? '/';

    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (url === '/health' || url === '/health/live') {
      send(200, { status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
      return;
    }

    if (url === '/health/ready' || url === '/ready') {
      if (state.shuttingDown) {
        send(503, { status: 'shutting_down' });
        return;
      }
      void pingDatabase().then((databaseReachable) => {
        if (!databaseReachable) {
          send(503, { status: 'not_ready', checks: { database: 'unreachable' } });
          return;
        }
        send(200, {
          status: 'ready',
          checks: { database: 'ok' },
          monitoring: state.monitoring?.snapshot() ?? null,
        });
      });
      return;
    }

    send(404, { status: 'not_found' });
  });

  /*
   * An HTTP server reports a failed bind by emitting `error`, and an
   * unhandled `error` event takes the process down with a raw stack trace.
   * A port already in use is a normal operational situation — a stale instance
   * during a rolling deploy — and it deserves a log line an operator can act
   * on, not an unhandled event.
   */
  server.on('error', (error: NodeJS.ErrnoException) => {
    log.fatal({ err: error, port }, 'health_server.listen_failed');
    void shutdown('health_server.listen_failed', 1);
  });

  server.listen(port, '0.0.0.0', () => {
    log.info({ port }, 'health_server.listening');
  });

  return server;
}

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  log.info({ signal }, 'worker.shutdown_started');

  /*
   * Nothing below calls process.exit(). Once the runtime has stopped claiming
   * new work, the health server is closed and the database pool is drained, no
   * handles remain and Node exits on its own with the code set here — which
   * guarantees pending writes finish first.
   */
  process.exitCode = exitCode;

  const watchdog = setTimeout(() => {
    log.error({ signal }, 'worker.shutdown_timed_out');
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
   * rest — and the step that must never be skipped is draining the database
   * pool, because an open pool holds the process alive with nothing left to do.
   * That is a hang rather than an exit, and the watchdog then has to kill a
   * process that was one call away from finishing cleanly.
   */
  const failures = [
    // Stop claiming new work and wait for any check already in flight to
    // finish — its own lease release still runs even if this wait times out,
    // since that lives in a `finally` block inside `monitoring.job.ts`.
    await attempt('worker.monitoring_stop_failed', async () => {
      await state.monitoring?.stop();
    }),
    await attempt('worker.health_server_close_failed', closeHealthServer),
    await attempt('worker.database_disconnect_failed', disconnectFromDatabase),
  ].filter(Boolean).length;

  if (failures > 0) {
    process.exitCode = 1;
    log.error({ signal, failures }, 'worker.shutdown_failed');
  } else {
    log.info('worker.shutdown_complete');
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
 * Closes the probe server.
 *
 * Skipped when it never bound — which is the normal case when shutdown was
 * triggered by a failed bind in the first place.
 */
async function closeHealthServer(): Promise<void> {
  const server = state.healthServer;
  if (!server?.listening) return;

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function bootstrap(): Promise<void> {
  await connectToDatabase({
    uri: env.MONGODB_URI,
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    autoIndex: env.MONGODB_AUTO_INDEX,
    appName: 'siteops-worker',
  });
  log.info('database.connected');

  const monitoring = new MonitoringRuntime('worker');
  state.monitoring = monitoring;

  state.healthServer = startHealthServer(env.WORKER_PORT);

  monitoring.start();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal, 0);
    });
  }

  // An unhandled rejection leaves the process in an unknown state. Shut down so
  // the platform restarts a clean one, rather than continuing to run a worker
  // that may be silently skipping checks.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'worker.unhandled_rejection');
    void shutdown('unhandledRejection', 1);
  });

  log.info({ environment: env.NODE_ENV }, 'worker.started');
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'worker.bootstrap_failed');
  process.exitCode = 1;
});
