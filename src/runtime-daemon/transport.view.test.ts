import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createRuntimeDaemonFrameParser, createRuntimeDaemonSocketClientTransport, createRuntimeDaemonSocketServer } from './transport.js';
import { createRuntimeDaemonNotification, createRuntimeDaemonRequest, createRuntimeDaemonSuccessResponse } from './protocol.js';
import type { RuntimeDaemonNotification } from './protocol.js';

it('coalesces a paused real socket to its latest current view while another client can issue commands', async () => {
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-slow-view-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(os.tmpdir(), `kodax-slow-${randomUUID()}.sock`) };
  let notifySlow: ((notification: RuntimeDaemonNotification) => void) | undefined;
  const server = await createRuntimeDaemonSocketServer({ endpoint, createDispatcher: (notify) => ({
    async handle(request) {
      if (request.method === 'session.view.observe') notifySlow = notify;
      return createRuntimeDaemonSuccessResponse(request.id, { ok: true });
    }, close() {},
  }) });
  const slow = net.createConnection(endpoint.path);
  const normal = await createRuntimeDaemonSocketClientTransport(endpoint);
  let initialized = false;
  const received: number[] = [];
  const parser = createRuntimeDaemonFrameParser((frame) => {
    if (frame.kind === 'response') initialized = true;
    if (frame.kind === 'notification' && frame.method === 'session.view') {
      const payload = frame.params as { view: { index: number } };
      received.push(payload.view.index);
    }
  });
  slow.on('data', (chunk) => parser.push(chunk));
  try {
    slow.write(`${JSON.stringify(createRuntimeDaemonRequest('observe', 'session.view.observe', { sessionId: 'session', subscriptionId: 'slow' }))}\n`);
    await expect.poll(() => initialized).toBe(true);
    slow.pause();
    const text = 'x'.repeat(128 * 1024);
    for (let index = 0; index < 500; index += 1) {
      notifySlow!(createRuntimeDaemonNotification('session.view', { subscriptionId: 'slow', view: { index, text } }));
    }
    const commandStart = performance.now();
    expect(await normal.request('ping')).toEqual({ ok: true });
    expect(performance.now() - commandStart).toBeLessThan(2000);
    slow.resume();
    await expect.poll(() => received.at(-1), { timeout: 5000 }).toBe(499);
    expect(received.length).toBeLessThan(20);
  } finally {
    slow.destroy();
    await normal.close?.();
    await server.close();
  }
}, 15000);
