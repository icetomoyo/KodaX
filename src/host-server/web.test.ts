import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openHostDeviceRegistry, type HostDeviceRegistry } from './devices.js';
import { createHostWebHandler, deviceCookie, readDeviceCookie } from './web.js';

const ORIGIN = 'https://laptop.tailnet.ts.net';

describe('createHostWebHandler', () => {
  let dir: string;
  let webRoot: string;
  let devices: HostDeviceRegistry;
  let pairing: boolean;
  let server: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kodax-web-'));
    webRoot = path.join(dir, 'web');
    mkdirSync(path.join(webRoot, 'assets'), { recursive: true });
    writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>KodaX</title>');
    writeFileSync(path.join(webRoot, 'assets', 'app.js'), 'export {};');
    writeFileSync(path.join(dir, 'secret.txt'), 'not for the web');
    devices = openHostDeviceRegistry({ file: path.join(dir, 'runtime', 'devices.json') });
    pairing = true;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => (server === undefined ? resolve() : server.close(() => resolve())));
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function serve(options: { readonly webRoot?: string } = { webRoot }): Promise<string> {
    const handler = createHostWebHandler({ ...options, devices: () => (pairing ? devices : undefined) });
    server = createServer(handler);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function pair(base: string, body: string, headers: Record<string, string> = { origin: ORIGIN }): Promise<Response> {
    return fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  }

  it('trades a pairing code for a device cookie bound to the origin that sent it', async () => {
    const base = await serve();
    const { code } = devices.pair({ requestId: 'r1', name: 'Phone' });
    const response = await pair(base, JSON.stringify({ code }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ device: { id: expect.stringMatching(/^dev_/u), name: 'Phone' } });
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/u);
    expect(cookie).toMatch(/SameSite=Strict/u);
    expect(cookie).toMatch(/Path=\//u);
    expect(cookie).toMatch(/Secure/u);
    expect(devices.admit(readDeviceCookie(cookie)!, ORIGIN)).toMatchObject({ name: 'Phone', origin: ORIGIN });
  });

  it('leaves Secure off the cookie for a device that paired over plain http, such as on the same Wi-Fi', async () => {
    const base = await serve();
    const { code } = devices.pair({ requestId: 'r1', name: 'Phone' });
    const response = await pair(base, JSON.stringify({ code }), { origin: 'http://192.168.1.5:8787' });
    expect(response.headers.get('set-cookie')).not.toMatch(/Secure/u);
  });

  it.each([
    ['a code it did not issue', JSON.stringify({ code: 'guess' }), { origin: ORIGIN }, 403],
    ['no browser origin', null, {}, 403],
    ['an opaque origin', null, { origin: 'null' }, 403],
    ['a page on another site', null, { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, 403],
    ['a body that is not JSON', '{ code', { origin: ORIGIN }, 400],
    ['a body larger than a code needs', JSON.stringify({ code: 'x'.repeat(4096) }), { origin: ORIGIN }, 413],
  ])('refuses to pair %s', async (_name, body, headers, status) => {
    const base = await serve();
    const { code } = devices.pair({ requestId: 'r1', name: 'Phone' });
    const response = await pair(base, body ?? JSON.stringify({ code }), headers);
    expect(response.status).toBe(status);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(devices.list()).toEqual([]);
  });

  it('answers /pair with 404 while pairing is off', async () => {
    pairing = false;
    const base = await serve();
    expect((await pair(base, JSON.stringify({ code: 'any' }))).status).toBe(404);
  });

  it('serves the web pages, index.html at the root, with their content types', async () => {
    const base = await serve();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/u);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await page.text()).toContain('<title>KodaX</title>');

    const script = await fetch(`${base}/assets/app.js`);
    expect(script.headers.get('content-type')).toMatch(/^text\/javascript/u);
    expect((await fetch(`${base}/assets/app.js`, { method: 'HEAD' })).headers.get('content-length')).toBe('10');
  });

  // Sent as written: a browser would resolve the dots before asking.
  it.each(['/missing.html', '/assets', '/../secret.txt', '/%2e%2e/secret.txt', '/..%5Csecret.txt', '/%00', '/%E0%A4%A'])(
    'answers %s, which is not a page inside the web root, without its content',
    async (requested) => {
      const base = await serve();
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        get(`${base}${requested}`, (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        }).on('error', reject);
      });
      expect([400, 404]).toContain(status);
      expect(body).not.toContain('not for the web');
    },
  );

  it('serves no pages without a web root', async () => {
    const base = await serve({});
    expect((await fetch(`${base}/`)).status).toBe(404);
  });
});

describe('device cookies', () => {
  it('reads the device token back from a Cookie header among others', () => {
    const cookie = deviceCookie('tok_123', ORIGIN).split(';')[0]!;
    expect(readDeviceCookie(`theme=dark; ${cookie}; other=1`)).toBe('tok_123');
    expect(readDeviceCookie('theme=dark')).toBeUndefined();
  });
});
