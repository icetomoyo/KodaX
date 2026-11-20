import { createServer, type Server } from 'node:http';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterEach, expect, it } from 'vitest';
import { requestExtensionFetch } from './request-extensions.js';

// Node 20/22 (undici 6) link a fetch to its caller's signal only through a
// WeakRef to the internal Request. With `redirect: 'error'` nothing else keeps
// that Request alive, so after a GC the abort never reached the body.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

it('a caller abort ends a held response body after the internal Request is collected', async () => {
  let socketClosed = (): void => undefined;
  const closed = new Promise<'closed'>(resolve => { socketClosed = () => resolve('closed'); });
  server = createServer((request, response) => {
    request.resume();
    request.socket.once('close', () => socketClosed());
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: begin\n\n');
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Server has no port.');

  const controller = new AbortController();
  const response = await requestExtensionFetch(globalThis.fetch)(`http://127.0.0.1:${address.port}/v1`,
    { method: 'POST', body: '{}', signal: controller.signal, redirect: 'error' });
  const reader = response.body!.getReader();
  await reader.read();
  const next = reader.read().then(() => 'chunk', (error: unknown) => (error instanceof Error ? error.name : String(error)));
  for (let round = 0; round < 3; round += 1) {
    gc();
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  controller.abort();

  expect(await within(next, 1_000)).toBe('AbortError');
  expect(await within(closed, 1_000)).toBe('closed');
  expect(response.url).toBe(`http://127.0.0.1:${address.port}/v1`);
});
