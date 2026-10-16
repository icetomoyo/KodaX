import * as net from 'node:net';
import { expect, it, vi } from 'vitest';
import { createRuntimeDaemonSocketClientTransport } from './transport.js';

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return { ...actual, createConnection: vi.fn(() => new actual.Socket()) };
});

it('reports a retryable connection timeout and closes the pending socket', async () => {
  await expect(createRuntimeDaemonSocketClientTransport(
    { kind: 'pipe', path: 'isolated-pending-connection' },
    { connectTimeoutMs: 5 },
  )).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  expect(vi.mocked(net.createConnection).mock.results[0]?.value.destroyed).toBe(true);
});
