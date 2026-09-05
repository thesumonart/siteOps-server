import { createServer, type Server } from 'node:http';

import { env } from './config/env.js';
import { MAX_REQUEST_TIMEOUT_MS } from './contracts/index.js';
import { connectToDatabase, disconnectFromDatabase, pingDatabase } from './database/connection.js';
import { EmailService } from './email/email.service.js';
import { SchedulerLoop } from './jobs/scheduler-loop.js';
import { NotificationRepository } from './repositories/notification.repository.js';
import { createLogger, logger } from './utils/logger.js';

const log = createLogger('worker');

/**
 * Monitoring worker entry point.
 *
 * Owns process lifecycle only: configuration, the database connection, the
 * health surface, the scheduler loop and an orderly shutdown. Stopping the
 * process always drains work in progress rather than killing a check
 * mid-flight — see `SchedulerLoop.stop()`.
 *
 * A separate process from the API on purpose. Monitoring is long-running I/O
 * against hostile-by-default targets, and it must not compete with request
 * handling for the event loop, the connection pool or a restart.
 */

/**
 * How long a graceful shutdown may take before the process is killed outright.
 * Comfortably under the 30s most platforms allow between SIGTERM and SIGKILL,
 * so it is this watchdog — not the platform — that ends a stuck shutdown, and
 * the reason is recorded in our own logs.
 */
const SHUTDOWN_WATCHDOG_MS = 25_000;

/**
 * A lease must comfortably outlast the slowest realistic single check, or a
 * worker still legitimately checking a slow site would have its own lease
 * stolen out from under it. Every attempt within one check can take up to the
 * *maximum any website is allowed to configure* (`MAX_REQUEST_TIMEOUT_MS`, not
 * just a default) times every redirect hop; the 30s on top covers the database
 * writes and email dispatch that follow.
 */
const LEASE_DURATION_MS =
  MAX_REQUEST_TIMEOUT_MS * (env.MONITOR_MAX_REDIRECTS + 1) * env.MONITOR_MAX_ATTEMPTS + 30_000;

/** Identifies our requests in a monitored site's own access log. */
const USER_AGENT = 'SiteOpsMonitor/1.0 (+https://siteops.app)';

interface RuntimeState {
  shuttingDown: boolean;
  healthServer: Server | null;
  schedulerLoop: SchedulerLoop | null;
}

const state: RuntimeState = { shuttingDown: false, healthServer: null, schedulerLoop: null };

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
          lastTickAt: state.schedulerLoop?.lastTickAt() ?? null,
        });
      });
      return;
    }

    send(404, { status: 'not_found' });
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
   * Nothing below calls process.exit(). Once the scheduler has stopped claiming
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

  try {
    // Stop claiming new work and wait for any check already in flight to
    // finish — its own lease release still runs even if this wait times out,
    // since that lives in a `finally` block inside `monitoring.job.ts`.
    await state.schedulerLoop?.stop();

    if (state.healthServer) {
      await new Promise<void>((resolve) => {
        state.healthServer?.close(() => {
          resolve();
        });
      });
    }
    await disconnectFromDatabase();
    log.info('worker.shutdown_complete');
  } catch (error) {
    log.error({ err: error }, 'worker.shutdown_failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
  }
}

async function bootstrap(): Promise<void> {
  await connectToDatabase({
    uri: env.MONGODB_URI,
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    autoIndex: env.MONGODB_AUTO_INDEX,
    appName: 'siteops-worker',
  });
  log.info('database.connected');

  const emailService = new EmailService();
  const notifications = new NotificationRepository();

  const schedulerLoop = new SchedulerLoop(
    {
      pollIntervalMs: env.MONITOR_POLL_INTERVAL_SECONDS * 1000,
      queue: {
        batchSize: env.MONITOR_CONCURRENCY,
        leaseDurationMs: LEASE_DURATION_MS,
      },
      job: {
        maxRedirects: env.MONITOR_MAX_REDIRECTS,
        maxAttempts: env.MONITOR_MAX_ATTEMPTS,
        allowLoopback: env.MONITOR_ALLOW_PRIVATE_ADDRESSES,
        userAgent: USER_AGENT,
      },
    },
    { emailService, notifications },
  );
  state.schedulerLoop = schedulerLoop;
  state.healthServer = startHealthServer(env.WORKER_PORT);

  schedulerLoop.start();

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

  log.info(
    {
      environment: env.NODE_ENV,
      pollIntervalSeconds: env.MONITOR_POLL_INTERVAL_SECONDS,
      concurrency: env.MONITOR_CONCURRENCY,
      leaseDurationMs: LEASE_DURATION_MS,
      emailConfigured: emailService.isConfigured,
    },
    'worker.started',
  );
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'worker.bootstrap_failed');
  process.exitCode = 1;
});
