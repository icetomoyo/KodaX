import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';
import { afterEach, expect, it } from 'vitest';

import { createHostA2AMount, type HostA2AMount } from './host-mount.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>(resolve => (server === undefined ? resolve() : server.close(() => resolve())));
  server = undefined;
});

/** Serves the mount the way the Host does, with the subject it admitted read from a test header. */
async function listen(mounted: HostA2AMount): Promise<string> {
  server = createServer((request, response) => {
    const subject = request.headers['x-test-subject'];
    mounted.serve(request, response, typeof subject === 'string' ? subject : undefined);
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a`;
}

it('lets A2A see the caller the Host admitted, and nobody where the Host admitted nobody', async () => {
  const host = createHostA2AMount();
  const seen: unknown[] = [];
  const url = await listen(host.mount({
    async handle(request) {
      seen.push(await host.authentication.authenticate(request));
      const echo = `${request.method} ${new URL(request.url).pathname} ${await request.text()}`;
      return new Response(echo, { status: 201, headers: { 'x-a2a': 'yes' } });
    },
  }));

  const admitted = await fetch(url, { method: 'POST', headers: { 'x-test-subject': 'backend-1' }, body: 'hello' });
  expect(admitted.status).toBe(201);
  expect(admitted.headers.get('x-a2a')).toBe('yes');
  expect(await admitted.text()).toBe('POST /a2a hello');
  await (await fetch(url, { method: 'POST', body: 'x' })).text();
  expect(seen).toEqual([{ subject: 'backend-1', scopes: ['a2a:invoke'] }, null]);
  // A request that did not come through the Host carries nobody, whatever it says.
  await expect(host.authentication.authenticate(new Request(url, { headers: { authorization: 'Bearer x' } })))
    .resolves.toBeNull();

  expect(host.authentication.securityRealm).toBe('kodax-host');
  expect(host.authentication.securitySchemes).toEqual({
    bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'JWT' } },
  });
});

it('answers 500 and logs why when A2A fails a request', async () => {
  const diagnostics: KodaXDiagnostic[] = [];
  const restore = setKodaXDiagnosticSink(diagnostic => { diagnostics.push(diagnostic); });
  try {
    const url = await listen(createHostA2AMount().mount({
      handle: async () => { throw new Error('store is gone'); },
    }));
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(500);
  } finally {
    restore();
  }
  expect(diagnostics).toEqual([expect.objectContaining({
    source: 'host.network', level: 'warn', detail: expect.objectContaining({ error: 'store is gone' }),
  })]);
});
