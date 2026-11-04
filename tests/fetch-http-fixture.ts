import { once } from 'node:events';
import { createServer, type RequestListener, type Server } from 'node:http';

/** Test-only listener whose reserved health route never reaches business counters. */
export async function createFetchHttpFixture(handler: RequestListener) {
  const route: RequestListener = (request, response) => {
    if (request.method === 'GET' && request.url === '/__kodax_fetch_fixture_health') {
      response.writeHead(204); response.end();
    } else handler(request, response);
  };
  const rejected: Server[] = [];
  let selected: Server | undefined;
  let failure: unknown;
  try {
    for (let attempt = 1; ; attempt++) {
      const server = createServer(route);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing local HTTP fixture address');
        const url = `http://127.0.0.1:${address.port}`;
        const response = await fetch(`${url}/__kodax_fetch_fixture_health`, { signal: AbortSignal.timeout(5000) });
        if (response.status !== 204) throw new Error(`HTTP fixture health check failed (${response.status}).`);
        selected = server;
        return { server, url };
      } catch (error) {
        // Hold rejected ports until another listener is usable, so Windows cannot immediately reuse them.
        rejected.push(server);
        if (attempt >= 8 || !(error instanceof Error && error.cause instanceof Error && error.cause.message === 'bad port')) throw error;
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled(rejected.map(server => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }));
    const errors = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length && selected) {
      selected.closeAllConnections();
      await new Promise<void>(resolve => selected!.close(error => { if (error) errors.push(error); resolve(); }));
    }
    if (errors.length) throw new AggregateError(failure === undefined ? errors : [failure, ...errors], 'HTTP fixture cleanup failed.');
  }
}
