import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A controlled HTTP server for monitoring tests.
 *
 * The checker must never depend on a real public website — that would make the
 * suite flaky on someone else's uptime and untestable for scenarios like "the
 * origin times out" or "the origin redirects into private address space".
 */

export type MockHandler = (request: IncomingMessage, response: ServerResponse) => void;

export interface MockServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const server: Server = createServer(handler);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        /*
         * `server.close()` waits for open connections to end, and the `hang`
         * handler never ends one — so without this the promise never settles
         * and the test process keeps a live handle, which surfaces as a worker
         * that "exited unexpectedly" rather than as an obvious hang.
         */
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

/** Common response shapes used across monitoring tests. */
export const handlers = {
  ok: (): MockHandler => (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  },
  status:
    (code: number): MockHandler =>
    (_req, res) => {
      res.writeHead(code);
      res.end();
    },
  redirectTo:
    (location: string, code = 302): MockHandler =>
    (_req, res) => {
      res.writeHead(code, { location });
      res.end();
    },
  slow:
    (delayMs: number): MockHandler =>
    (_req, res) => {
      // Unref'd so a pending response cannot outlive the test that asked for
      // it and hold the process open.
      setTimeout(() => {
        res.writeHead(200);
        res.end('slow');
      }, delayMs).unref();
    },
  hang: (): MockHandler => () => {
    // Never responds and never closes the connection, forcing a timeout.
  },
};
