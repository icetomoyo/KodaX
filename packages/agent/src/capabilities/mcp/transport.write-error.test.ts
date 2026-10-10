import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
}));

import { createStdioTransport } from './transport.js';
import { McpServerRuntime } from './runtime.js';

describe('MCP stdio write failures', () => {
  afterEach(() => spawnMock.mockReset());

  it('rejects the send and reports a closed input pipe', async () => {
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null,
      stdin: new Writable({ write: (_chunk, _encoding, callback) => callback(error) }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    child.kill.mockImplementation(() => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      return true;
    });
    spawnMock.mockReturnValue(child);
    const errors: Error[] = [];
    const transport = createStdioTransport({ command: 'mcp-test-helper' });

    try {
      await transport.open({
        onMessage: () => {},
        onError: (failure) => errors.push(failure),
        onClose: () => {},
      });
      await expect(transport.send('{"jsonrpc":"2.0","id":1}')).rejects.toThrow('write EPIPE');
      expect(errors).toContain(error);
    } finally {
      await transport.close();
    }
  });

  it('rejects initialization when the required initialized notification cannot be sent', async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-initialized-write-'));
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    spawnMock.mockImplementation(() => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: undefined, exitCode: null as number | null, signalCode: null,
        stdout, stderr: new PassThrough(), kill: vi.fn(() => true),
        stdin: new Writable({ write: (chunk: Buffer, _encoding, callback) => {
          const frame = chunk.toString();
          const contentLength = frame.startsWith('Content-Length:');
          const packet = JSON.parse(contentLength ? frame.slice(frame.indexOf('\r\n\r\n') + 4) : frame) as {
            id?: number; method?: string;
          };
          if (packet.method === 'notifications/initialized') { callback(error); return; }
          callback();
          if (packet.method === 'initialize') {
            const json = JSON.stringify({ jsonrpc: '2.0', id: packet.id,
              result: { protocolVersion: '2025-11-25', capabilities: {} } });
            queueMicrotask(() => stdout.write(contentLength
              ? `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}` : `${json}\n`));
          }
        } }),
      });
      child.kill.mockImplementation(() => { child.exitCode = 0; child.emit('exit', 0, null); return true; });
      return child;
    });
    const runtime = new McpServerRuntime('write-fixture', { command: 'mcp-test-helper' }, cacheDir);
    try {
      await expect(runtime.refreshCatalog(true)).rejects.toThrow('write EPIPE');
      expect(runtime.getDiagnostics()).toMatchObject({ status: 'error', lastError: 'write EPIPE', dirty: true });
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.dispose();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
