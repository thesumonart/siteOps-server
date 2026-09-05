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
      new Promise<void>((resolve) => {
        /*
         * Stop accepting first, then destroy whatever is left.
         *
         * `server.close()` alone waits for open connections to end, and the
         * `hang` handler never ends one — so the promise would never settle and
         * the process would keep a live handle. Destroying first, though, can
         * tear a socket out from under a client that is still finishing with
         * it, which surfaces later as a worker that "exited unexpectedly"
         * rather than as anything legible. This order does neither.
         *
         * The callback's error is ignored on purpose: "the server was already
         * closed" is the only thing it reports here, and a test that has
         * finished has nothing to do with that.
         */
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
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
