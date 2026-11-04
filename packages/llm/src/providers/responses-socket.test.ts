import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer, globalAgent as httpAgent, type IncomingMessage, type Server } from 'node:http';
import { globalAgent as httpsAgent } from 'node:https';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { resolveEnvProxy, webSocketProxyOptions } from './responses-socket.js';

const PROXY = 'http://proxy.example:3128';

it('picks the proxy variable for the WebSocket scheme, lowercase first', () => {
  expect(resolveEnvProxy(new URL('wss://api.example/v1'), { HTTPS_PROXY: PROXY })).toBe(PROXY);
  expect(resolveEnvProxy(new URL('wss://api.example/v1'), { https_proxy: 'http://lower:1', HTTPS_PROXY: PROXY })).toBe('http://lower:1');
  expect(resolveEnvProxy(new URL('ws://api.example/v1'), { HTTP_PROXY: PROXY })).toBe(PROXY);
  expect(resolveEnvProxy(new URL('ws://api.example/v1'), { HTTPS_PROXY: PROXY })).toBeUndefined();
  expect(resolveEnvProxy(new URL('wss://api.example/v1'), {})).toBeUndefined();
});

it.each([
  ['*', 'api.example'],
  ['api.example', 'api.example'],
  ['example', 'api.example'],
  ['.example', 'api.example'],
  ['*.example', 'api.example'],
  ['other.test, api.example', 'api.example'],
  ['api.example:443', 'api.example'],
  ['127.0.0.1', '127.0.0.1'],
  ['[::1]', '[::1]'],
])('NO_PROXY entry %s bypasses the proxy for %s', (noProxy, host) => {
  expect(resolveEnvProxy(new URL(`wss://${host}/v1`), { HTTPS_PROXY: PROXY, NO_PROXY: noProxy })).toBeUndefined();
});

it.each([
  ['badexample', 'api.example'],
  ['api.example:8443', 'api.example'],
  ['other.test', 'api.example'],
])('NO_PROXY entry %s keeps the proxy for %s', (noProxy, host) => {
  expect(resolveEnvProxy(new URL(`wss://${host}/v1`), { HTTPS_PROXY: PROXY, no_proxy: noProxy })).toBe(PROXY);
});

it('leaves the connection unchanged when no proxy applies', () => {
  expect(webSocketProxyOptions('wss://api.example/v1', {}, false)).toEqual({});
  expect(webSocketProxyOptions('wss://api.example/v1', { HTTPS_PROXY: PROXY, NO_PROXY: 'api.example' }, false)).toEqual({});
  expect(webSocketProxyOptions('wss://api.example/v1', {}, true)).toEqual({});
});

it('hands Node the global agent, which follows the proxy under NODE_USE_ENV_PROXY', () => {
  expect(webSocketProxyOptions('wss://api.example/v1', { HTTPS_PROXY: PROXY }, false)).toEqual({ agent: httpsAgent });
  expect(webSocketProxyOptions('ws://api.example/v1', { HTTP_PROXY: PROXY }, false)).toEqual({ agent: httpAgent });
});

it('hands Bun the proxy URL, because its built-in ws ignores agents', () => {
  expect(webSocketProxyOptions('wss://api.example/v1', { HTTPS_PROXY: PROXY }, true)).toEqual({ proxy: PROXY });
});

function nodeHasEnvProxy(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

// The target host cannot resolve, so only a proxied handshake can open.
it.runIf(nodeHasEnvProxy())('opens the Responses WebSocket through an environment proxy on Node', async () => {
  const { WebSocketServer } = createRequire(import.meta.url)('ws') as { WebSocketServer: new (options: { server: Server }) => {
    clients: Set<{ terminate(): void }>; close(callback: () => void): void;
  } };
  const proxy = createServer();
  const server = new WebSocketServer({ server: proxy });
  const proxied: string[] = [];
  proxy.on('upgrade', (request: IncomingMessage) => { proxied.push(request.url ?? ''); });
  proxy.on('connect', (request: IncomingMessage, client) => {
    proxied.push(`CONNECT ${request.url ?? ''}`);
    const address = proxy.address();
    if (!address || typeof address === 'string') return;
    const upstream = connect(address.port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.pipe(client); client.pipe(upstream); });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('Expected local port');
    const script = [
      `import { createResponsesSocket } from ${JSON.stringify(new URL('./responses-socket.ts', import.meta.url).href)};`,
      "const socket = await createResponsesSocket({ url: 'ws://kodax-proxy-fixture.invalid/v1/responses', headers: {}, timeoutMs: 5000 });",
      "socket.close(); process.stdout.write('opened');",
    ].join('\n');
    const env = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${address.port}`,
      http_proxy: undefined, NO_PROXY: undefined, no_proxy: undefined, NODE_OPTIONS: undefined };
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: fileURLToPath(new URL('../../../../', import.meta.url)), env, windowsHide: true, timeout: 20_000 });
    expect(stdout).toBe('opened');
    expect(proxied.join(' ')).toContain('kodax-proxy-fixture.invalid');
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(resolve));
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  }
}, 30_000);
