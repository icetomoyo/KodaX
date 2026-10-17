import * as net from 'node:net';
import { expect, it, vi } from 'vitest';

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('node:net', async (original) => ({ ...await original<typeof import('node:net')>(), createConnection: connect }));
import { createRuntimeDaemonSocketClientTransport } from './transport.js';

it('cancels a pending socket attachment and destroys it without waiting for the connect timeout', async () => {
  vi.useFakeTimers();
  const socket = new net.Socket();
  connect.mockReturnValue(socket);
  const controller = new AbortController();
  const reason = new Error('cancel pending socket attachment');
  let outcome: unknown;
  const result = createRuntimeDaemonSocketClientTransport({ kind: 'pipe', path: 'fixture' }, {
    connectTimeoutMs: 1_000, signal: controller.signal,
  }).then(value => { outcome = value; }, error => { outcome = error; });
  try {
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe(reason);
    expect(socket.destroyed).toBe(true);
  } finally {
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    socket.destroy();
    vi.useRealTimers();
  }
});
