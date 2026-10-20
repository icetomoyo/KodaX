import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  killChildProcessTreeMock,
  registerManagedChildProcessMock,
  rememberChildProcessTreeMock,
  spawnMock,
  unregisterMock,
} = vi.hoisted(() => ({
  killChildProcessTreeMock: vi.fn(),
  registerManagedChildProcessMock: vi.fn(),
  rememberChildProcessTreeMock: vi.fn(),
  spawnMock: vi.fn(),
  unregisterMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../../runtime/process-tree.js', () => ({
  killChildProcessTree: killChildProcessTreeMock,
  killChildProcessTreeSync: vi.fn(() => ({ status: 'unknown' as const })),
  isCurrentProcessWindowsJobContained: () => false,
  isChildProcessExited: (child: { exitCode: number | null; signalCode: NodeJS.Signals | null }) => (
    child.exitCode !== null || child.signalCode !== null
  ),
  rememberChildProcessTree: rememberChildProcessTreeMock,
}));

vi.mock('../../runtime/managed-child-processes.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../runtime/managed-child-processes.js')>(),
  registerManagedChildProcess: registerManagedChildProcessMock,
}));

const {
  McpTransportCleanupIncompleteError,
  createStdioTransport,
} = await import('./transport.js');

function fakeChild(pid: number | null = 42_424) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number | undefined;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid ?? undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe('MCP stdio cleanup evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerManagedChildProcessMock.mockReturnValue(unregisterMock);
  });

  it('keeps its managed record and retries after an unknown cleanup result', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    killChildProcessTreeMock
      .mockResolvedValueOnce({ status: 'unknown' })
      .mockResolvedValueOnce({ status: 'terminated' });
    const transport = createStdioTransport({ command: 'mcp-server' });
    await transport.open({
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
    });

    expect(registerManagedChildProcessMock).toHaveBeenCalledWith(
      child,
      expect.objectContaining({ kind: 'mcp-stdio' }),
      { manualUnregister: true },
    );
    await expect(transport.close()).rejects.toBeInstanceOf(
      McpTransportCleanupIncompleteError,
    );
    expect(unregisterMock).not.toHaveBeenCalled();

    await expect(transport.close()).resolves.toBeUndefined();
    expect(killChildProcessTreeMock).toHaveBeenCalledTimes(2);
    expect(unregisterMock).toHaveBeenCalledTimes(1);
  });

  it('reports incomplete cleanup and blocks reopen after the MCP root exits naturally', async () => {
    const baselineExitListeners = process.listenerCount('exit');
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    killChildProcessTreeMock.mockResolvedValue({ status: 'unknown' });
    const transport = createStdioTransport({ command: 'mcp-server' });
    await transport.open({
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
    });
    child.emit('spawn');
    child.exitCode = 0;
    child.emit('exit', 0, null);

    expect(rememberChildProcessTreeMock).toHaveBeenCalledWith(child);
    expect(process.listenerCount('exit')).toBe(baselineExitListeners + 1);
    await expect(transport.close()).rejects.toBeInstanceOf(
      McpTransportCleanupIncompleteError,
    );
    await expect(transport.open({
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
    })).rejects.toBeInstanceOf(McpTransportCleanupIncompleteError);
    expect(unregisterMock).not.toHaveBeenCalled();
    expect(process.listenerCount('exit')).toBe(baselineExitListeners + 1);
  });

  it('cleans up a spawn error that never created an OS process', async () => {
    const baselineExitListeners = process.listenerCount('exit');
    const child = fakeChild(null);
    spawnMock.mockReturnValue(child);
    const transport = createStdioTransport({ command: 'missing-mcp-server' });
    await transport.open({
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
    });
    child.emit('error', new Error('spawn ENOENT'));

    await expect(transport.close()).resolves.toBeUndefined();
    expect(killChildProcessTreeMock).not.toHaveBeenCalled();
    expect(unregisterMock).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('exit')).toBe(baselineExitListeners);
  });
});
