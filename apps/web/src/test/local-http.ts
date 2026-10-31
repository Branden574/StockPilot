import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A loopback HTTP server for one test file, so a test can show what the real
 * fetch does (which requests it makes, which redirects it follows) with no
 * network: it listens on 127.0.0.1 on a free port.
 */
export interface LocalServer {
  /** For example http://127.0.0.1:54123 */
  origin: string;
  /** The path and query of every request it answered, in order. */
  requests: string[];
  close: () => Promise<void>;
}

export async function startLocalServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<LocalServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        // fetch keeps its connections alive; close them so close() returns.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
