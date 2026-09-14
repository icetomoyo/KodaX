import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}));

const {
  killChildProcessTree,
  rememberChildProcessTree,
} = await import('./process-tree.js');

const originalPlatform = process.platform;

function setWindows(): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  });
}

function fakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

function snapshot(stdout: string) {
  return {
    error: undefined,
    status: 0,
    signal: null,
    stdout,
    stderr: '',
    pid: 1,
    output: [],
  };
}

describe('LLM Windows process-tree identity fences', () => {
  it('verifies a drained tree using the fresh snapshot from the termination process', async () => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot('4242,1,111\n4343,4242,112\n'))
      .mockReturnValueOnce(snapshot('KODAX_TERMINATION_COMPLETED\n0,0,0\n1,0,100\nKODAX_SNAPSHOT_COMPLETED\n'))
      .mockReturnValue(snapshot('1,0,100\n'));
    const child = fakeChild(4_242);
    rememberChildProcessTree(child as never);
    child.exitCode = 0;

    await expect(killChildProcessTree(child as never)).resolves.toEqual({ status: 'terminated' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['empty', ''],
    ['truncated', 'KODAX_TERMINATION_COMPLETED\n1,0,100\n'],
    ['malformed identity', 'KODAX_TERMINATION_COMPLETED\n1,0,100\n4242,1,broken\nKODAX_SNAPSHOT_COMPLETED\n'],
    ['malformed row', 'KODAX_TERMINATION_COMPLETED\n1,0,100\nbroken\nKODAX_SNAPSHOT_COMPLETED\n'],
    ['still alive', 'KODAX_TERMINATION_COMPLETED\n4242,1,111\nKODAX_SNAPSHOT_COMPLETED\n'],
    ['identity unreadable', 'KODAX_TERMINATION_COMPLETED\n4242,1,0\nKODAX_SNAPSHOT_COMPLETED\n'],
  ])('reads a new snapshot when the termination snapshot is %s', async (_scenario, output) => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot(output))
      .mockReturnValue(snapshot('1,0,100\n'));

    const child = fakeChild(4_242);
    rememberChildProcessTree(child as never);
    child.exitCode = 0;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    await expect(killChildProcessTree(child as never)).resolves.toEqual({ status: 'terminated' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(4);
  });

  it('preserves the unknown result when the termination process fails without stdout', async () => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce({ ...snapshot(''), stdout: undefined, error: new Error('ENOENT'), status: null })
      .mockReturnValue(snapshot('4242,1,111\n'));
    const child = fakeChild(4_242);
    rememberChildProcessTree(child as never);
    child.exitCode = 0;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    await expect(killChildProcessTree(child as never)).resolves.toEqual({ status: 'unknown' });
  });

  it.each([false, true])('preserves retry after snapshot timeout only with completed termination (%s)', async (completed) => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce({
        ...snapshot(completed ? 'KODAX_TERMINATION_COMPLETED\n' : ''),
        error: new Error('ETIMEDOUT'), status: null,
      })
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot(''))
      .mockReturnValue(snapshot('1,0,100\n'));
    const child = fakeChild(4_242);
    rememberChildProcessTree(child as never);
    child.exitCode = 0;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const result = await killChildProcessTree(child as never);
    expect(result).toEqual({ status: completed ? 'terminated' : 'unknown' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(completed ? 6 : 4);
    const script = String(spawnSyncMock.mock.calls[2]?.[1]?.at(-1));
    expect(script.indexOf("Out.WriteLine('KODAX_TERMINATION_COMPLETED')"))
      .toBeLessThan(script.indexOf('Out.Flush()'));
    expect(script.indexOf('Out.Flush()')).toBeLessThan(script.indexOf('::ReadRows()'));
  });

  it('does not certify a tree while a retained uncertain descendant is still present', async () => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot('4242,1,111\n4343,4242,0\n'))
      .mockReturnValueOnce(snapshot('KODAX_TERMINATION_COMPLETED\n1,0,100\n4343,9,222\nKODAX_SNAPSHOT_COMPLETED\n'))
      .mockReturnValue(snapshot('4343,9,222\n'));
    const child = fakeChild(4_242);
    rememberChildProcessTree(child as never);
    child.exitCode = 0;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const result = await killChildProcessTree(child as never);
    expect(result).toEqual({ status: 'unknown' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(6);
    const script = String(spawnSyncMock.mock.calls[2]?.[1]?.at(-1));
    expect(script).not.toContain('::TerminateExact(4343');
  });

  it('does not add a post-termination snapshot to an incomplete retained tree', async () => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot('4343,4242,112\n'))
      .mockReturnValueOnce(snapshot('4343,4242,112\n'))
      .mockReturnValue(snapshot(''));
    const child = fakeChild(4_242);
    rememberChildProcessTree(child as never);
    child.exitCode = 0;
    rememberChildProcessTree(child as never);

    await expect(killChildProcessTree(child as never)).resolves.toEqual({ status: 'unknown' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(4);
    const script = String(spawnSyncMock.mock.calls[3]?.[1]?.at(-1));
    expect(script).toContain('::TerminateExact(4343');
    expect(script).not.toContain('::ReadRows()');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('does not terminate a reused root PID after the tracked child exits', async () => {
    setWindows();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot('4242,1,222\n'));
    const child = fakeChild(4_242);
    expect(rememberChildProcessTree(child as never)).toBe('111');
    child.exitCode = 0;

    await expect(killChildProcessTree(child as never))
      .resolves.toEqual({ status: 'unknown' });
    expect(spawnSyncMock.mock.calls.some(([, args]) =>
      Array.isArray(args) && /TerminateExact\(\d/.test(String(args.at(-1)))))
      .toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('retries one complete snapshot when a newly spawned root is initially absent', () => {
    setWindows();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('1,0,100\n'))
      .mockReturnValueOnce(snapshot('4242,1,111\n'));

    expect(rememberChildProcessTree(fakeChild(4_242) as never)).toBe('111');
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('attempts the retained exact root identity when a fresh snapshot fails', async () => {
    setWindows();
    const child = fakeChild(4_242);
    const failedSnapshot = {
      ...snapshot(''),
      error: new Error('snapshot unavailable'),
      status: null,
    };
    const terminationScripts: string[] = [];
    spawnSyncMock.mockImplementation((_command, args) => {
      const script = Array.isArray(args) ? String(args.at(-1)) : '';
      if (/TerminateExact\(\d/.test(script)) {
        terminationScripts.push(script);
        child.exitCode = 0;
        return snapshot('');
      }
      if (spawnSyncMock.mock.calls.length === 1) return snapshot('4242,1,111\n');
      return failedSnapshot;
    });
    expect(rememberChildProcessTree(child as never)).toBe('111');

    await expect(killChildProcessTree(child as never))
      .resolves.toEqual({ status: 'unknown' });
    expect(terminationScripts.join('\n')).toContain('TerminateExact(4242');
    expect(spawnSyncMock.mock.calls.some(([command]) => command === 'taskkill.exe'))
      .toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses lightweight liveness checks before one final identity snapshot', async () => {
    setWindows();
    const child = fakeChild(4_242);
    const snapshots = [
      '4242,1,111\n',
      '4242,1,111\n4343,4242,222\n',
      '9999,1,999\n',
    ];
    const terminationScripts: string[] = [];
    spawnSyncMock.mockImplementation((_command, args) => {
      const script = Array.isArray(args) ? String(args.at(-1)) : '';
      if (/TerminateExact\(\d/.test(script)) {
        terminationScripts.push(script);
        child.exitCode = 0;
        return snapshot('');
      }
      return snapshot(snapshots.shift() ?? '');
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    expect(rememberChildProcessTree(child as never)).toBe('111');

    await expect(killChildProcessTree(child as never))
      .resolves.toEqual({ status: 'terminated' });
    expect(terminationScripts.join('\n')).toContain('TerminateExact(4242');
    expect(terminationScripts.join('\n')).toContain('TerminateExact(4343');
    expect(kill).toHaveBeenCalledTimes(2);
    expect(snapshots).toHaveLength(0);
  });
});
