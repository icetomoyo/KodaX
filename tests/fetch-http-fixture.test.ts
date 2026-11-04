import { Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createFetchHttpFixture } from './fetch-http-fixture.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('rebinds only a fetch bad-port refusal and keeps health requests outside the business handler', async () => {
  const originalFetch = globalThis.fetch;
  const badPort = new TypeError('fetch failed', { cause: new Error('bad port') });
  const close = vi.spyOn(Server.prototype, 'close');
  let rejectedUrl = '';
  const probe = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async input => {
    rejectedUrl = String(input); throw badPort;
  }).mockImplementation(async (input, init) => {
    expect(close).not.toHaveBeenCalled(); // Keep rejected ports occupied until a usable listener exists.
    expect(String(input)).not.toBe(rejectedUrl);
    return originalFetch(input, init);
  });
  const requests: string[] = [];
  const fixture = await createFetchHttpFixture((request, response) => {
    requests.push(request.url ?? ''); response.end('business evidence');
  });
  servers.push(fixture.server);
  expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(close.mock.calls.length).toBe(probe.mock.calls.length - 1);
  expect(requests).toEqual([]);
  expect(await (await originalFetch(`${fixture.url}/page`)).text()).toBe('business evidence');
  expect(requests).toEqual(['/page']);
  expect(fixture.server.listenerCount('listening')).toBe(new Server().listenerCount('listening'));
  expect(fixture.server.listenerCount('error')).toBe(0);
});

it.each([
  new TypeError('fetch failed', { cause: new Error('ECONNRESET') }),
  new Error('bad port'),
])('preserves a non-matching probe failure without retrying (%s)', async failure => {
  const probe = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
  const close = vi.spyOn(Server.prototype, 'close');
  const handler = vi.fn();
  await expect(createFetchHttpFixture(handler)).rejects.toBe(failure);
  expect(probe).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(close.mock.instances[0]?.listening).toBe(false);
  expect(handler).not.toHaveBeenCalled();
});

it('bounds consecutive bad-port retries and closes the final listener', async () => {
  const failure = new TypeError('fetch failed', { cause: new Error('bad port') });
  const probe = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
  const close = vi.spyOn(Server.prototype, 'close');
  await expect(createFetchHttpFixture(vi.fn())).rejects.toBe(failure);
  expect(probe).toHaveBeenCalledTimes(8);
  expect(close).toHaveBeenCalledTimes(8);
  expect(close.mock.instances.every(server => !server.listening)).toBe(true);
  expect(close.mock.instances[0]?.listenerCount('error')).toBe(0);
  expect(close.mock.instances[0]?.listenerCount('listening')).toBe(new Server().listenerCount('listening'));
});

it('does not retry a non-success health response', async () => {
  const probe = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
  const close = vi.spyOn(Server.prototype, 'close');
  await expect(createFetchHttpFixture(vi.fn())).rejects.toThrow('HTTP fixture health check failed (503)');
  expect(probe).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(close.mock.instances[0]?.listening).toBe(false);
});

it('closes a selected listener if rejected-listener cleanup prevents returning the fixture', async () => {
  const originalFetch = globalThis.fetch;
  const originalClose = Server.prototype.close;
  const failure = new Error('fixture close failed');
  vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('bad port') }))
    .mockImplementation(originalFetch);
  const listening = vi.spyOn(Server.prototype, 'listen');
  vi.spyOn(Server.prototype, 'close').mockImplementationOnce(function (this: Server, callback) {
    return originalClose.call(this, error => callback?.(error ?? failure));
  });
  await expect(createFetchHttpFixture(vi.fn())).rejects.toMatchObject({ errors: [failure] });
  servers.push(...listening.mock.instances.filter(server => server.listening));
  expect(listening.mock.instances.every(server => !server.listening)).toBe(true);
});
