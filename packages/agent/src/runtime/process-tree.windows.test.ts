import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

const {
  killChildProcessTree,
  killChildProcessTreeSync,
  killPidTree,
  readProcessStartIdentity,
  rememberChildProcessTree,
  rememberedChildProcessTreeIsComplete,
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

describe('Windows process-tree identity fences', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
    vi.clearAllMocks();
  });

  it('reads the exact Windows process creation identity', () => {
    setWindows();
    spawnSyncMock.mockReturnValue(snapshot(''));
    spawnSyncMock.mockReturnValueOnce(snapshot('4242,1,111\n'));

    expect(readProcessStartIdentity(4_242)).toBe('111');
  });

  it('does not target a reused root PID after the tracked child exits', async () => {
    setWindows();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot('4242,1,222\n'));
    const child = fakeChild(4_242);
    expect(rememberChildProcessTree(child as never)).toBe('111');
    child.exitCode = 0;

    await expect(killChildProcessTree(child as never, { forceMs: 0 }))
      .resolves.toEqual({ status: 'unknown' });
    expect(spawnMock).not.toHaveBeenCalled();
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

  it('attempts retained exact identities when snapshots fail without trusting a bare pid', async () => {
    setWindows();
    const failedSnapshot = {
      ...snapshot(''),
      error: new Error('snapshot unavailable'),
      status: null,
    };
    const terminationScripts: string[] = [];
    spawnSyncMock.mockImplementation((_command, args) => {
      const script = Array.isArray(args) ? String(args.at(-1)) : '';
      if (script.includes('TerminateExact')) {
        terminationScripts.push(script);
        return snapshot('');
      }
      return failedSnapshot;
    });

    await expect(killPidTree(4_242, {
      expectedProcessStartIdentity: '111',
      expectedProcessTreeIdentities: [
        { pid: 4_242, creationTime: '111' },
        { pid: 4_343, creationTime: '222' },
      ],
      expectedProcessTreeComplete: false,
      forceMs: 0,
      taskkillMs: 100,
    })).resolves.toEqual({ status: 'unknown' });

    expect(terminationScripts.join('\n')).toContain('TerminateExact(4242');
    expect(terminationScripts.join('\n')).toContain('TerminateExact(4343');
  });

  it('retains a known orphan grandchild when a fresh root snapshot loses its intermediate parent', async () => {
    setWindows();
    const scripts: string[] = [];
    let killedRoot = false;
    spawnSyncMock.mockImplementation((_command, args) => {
      const script = Array.isArray(args) ? String(args.at(-1)) : '';
      if (script.trim().endsWith('Out-Null')) {
        scripts.push(script);
        killedRoot = true;
        return snapshot('');
      }
      return snapshot(`${killedRoot ? '' : '4242,1,100\n'}4444,4343,120\n`);
    });
    await expect(killPidTree(4242, {
      expectedProcessStartIdentity: '100', expectedProcessTreeComplete: true,
      expectedProcessTreeIdentities: [
        { pid: 4242, creationTime: '100' }, { pid: 4343, creationTime: '110' }, { pid: 4444, creationTime: '120' },
      ], forceMs: 0, taskkillMs: 100,
    })).resolves.toEqual({ status: 'unknown' });
    expect(scripts.join('\n')).toContain('TerminateExact(4444, [UInt64]120)');
  });

  it.each(['refresh', 'exit-refresh', 'async-kill', 'sync-kill'] as const)(
    'keeps previously captured orphan identities through %s', async (action) => {
      setWindows();
      const child = fakeChild(4242);
      const scripts: string[] = [];
      let tree = '4242,1,100\n4343,4242,110\n4444,4343,120\n';
      spawnSyncMock.mockImplementation((_command, args) => {
        const script = Array.isArray(args) ? String(args.at(-1)) : '';
        if (script.trim().endsWith('Out-Null')) {
          scripts.push(script);
          tree = '4444,4343,120\n';
          return snapshot('');
        }
        return snapshot(tree);
      });
      rememberChildProcessTree(child as never);
      rememberChildProcessTree(child as never);
      tree = '4242,1,100\n4444,4343,120\n';
      if (action === 'refresh') rememberChildProcessTree(child as never);
      child.exitCode = 0;
      if (action === 'exit-refresh') rememberChildProcessTree(child as never);
      const result = action === 'sync-kill' ? killChildProcessTreeSync(child as never)
        : await killChildProcessTree(child as never, { forceMs: 0, taskkillMs: 100 });
      expect(result).toEqual({ status: 'unknown' });
      expect(scripts.join('\n')).toContain('TerminateExact(4444, [UInt64]120)');
    },
  );

  it('never substitutes the creation identity of a reused orphan PID', async () => {
    setWindows();
    const scripts: string[] = [];
    let rootAlive = true;
    spawnSyncMock.mockImplementation((_command, args) => {
      const script = Array.isArray(args) ? String(args.at(-1)) : '';
      if (script.trim().endsWith('Out-Null')) { scripts.push(script); rootAlive = false; return snapshot(''); }
      return snapshot(`${rootAlive ? '4242,1,100\n' : ''}4444,1,999\n`);
    });
    await expect(killPidTree(4242, { expectedProcessStartIdentity: '100', expectedProcessTreeComplete: true,
      expectedProcessTreeIdentities: [{ pid: 4242, creationTime: '100' }, { pid: 4444, creationTime: '120' }],
      forceMs: 0, taskkillMs: 100,
    })).resolves.toEqual({ status: 'terminated' });
    expect(scripts.join('\n')).toContain('TerminateExact(4444, [UInt64]120)');
    expect(scripts.join('\n')).not.toContain('TerminateExact(4444, [UInt64]999)');
  });

  it('does not discard retained unknown descendants when a fresh root snapshot looks complete', async () => {
    setWindows();
    const scripts: string[] = [];
    let rootAlive = true;
    spawnSyncMock.mockImplementation((_command, args) => {
      const script = Array.isArray(args) ? String(args.at(-1)) : '';
      if (script.trim().endsWith('Out-Null')) { scripts.push(script); rootAlive = false; return snapshot(''); }
      return snapshot(`${rootAlive ? '4242,1,100\n' : ''}4444,4343,120\n`);
    });
    await expect(killPidTree(4242, { expectedProcessStartIdentity: '100', expectedProcessTreeComplete: false,
      expectedProcessTreeIdentities: [{ pid: 4242, creationTime: '100' }, { pid: 4444, creationTime: '0' }],
      forceMs: 0, taskkillMs: 100,
    })).resolves.toEqual({ status: 'unknown' });
    expect(scripts.join('\n')).not.toContain('TerminateExact(4444');
  });

  it('fails closed without signaling a bare pid when every snapshot backend fails', async () => {
    setWindows();
    spawnSyncMock.mockReturnValue({
      ...snapshot(''),
      error: new Error('snapshot unavailable'),
      status: null,
    });
    const child = fakeChild(4_242);

    expect(rememberChildProcessTree(child as never)).toBeUndefined();
    await expect(killChildProcessTree(child as never, { forceMs: 0 }))
      .resolves.toEqual({ status: 'unknown' });
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('attempts the tracked exact root identity when a fresh snapshot fails', async () => {
    setWindows();
    const child = fakeChild(4_242);
    const failedSnapshot = {
      ...snapshot(''),
      error: new Error('snapshot unavailable'),
      status: null,
    };
    const terminationScripts: string[] = [];
    let snapshotCalls = 0;
    spawnSyncMock.mockImplementation((_command, args) => {
      const script = Array.isArray(args) ? String(args.at(-1)) : '';
      if (script.trim().endsWith('Out-Null')) {
        terminationScripts.push(script);
        child.exitCode = 0;
        return snapshot('');
      }
      snapshotCalls += 1;
      return snapshotCalls === 1 ? snapshot('4242,1,111\n') : failedSnapshot;
    });
    expect(rememberChildProcessTree(child as never)).toBe('111');

    await expect(killChildProcessTree(child as never, { forceMs: 0 }))
      .resolves.toEqual({ status: 'unknown' });
    expect(terminationScripts.join('\n')).toContain('TerminateExact(4242');
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports unknown while a captured descendant with unreadable identity remains', async () => {
    setWindows();
    let snapshotCall = 0;
    spawnSyncMock.mockImplementation(() => {
      snapshotCall += 1;
      if (snapshotCall === 1) return snapshot('4242,1,111\n');
      if (snapshotCall <= 3) return snapshot('4242,1,111\n4343,4242,0\n');
      return snapshot('4343,4242,999\n');
    });
    spawnMock.mockImplementation(() => {
      const killer = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
      };
      killer.kill = vi.fn(() => true);
      queueMicrotask(() => killer.emit('exit', 0));
      return killer;
    });
    const child = fakeChild(4_242);
    expect(rememberChildProcessTree(child as never)).toBe('111');

    await expect(killChildProcessTree(child as never, {
      forceMs: 0,
      taskkillMs: 100,
    })).resolves.toEqual({ status: 'unknown' });
  });

  it('reports unknown when a late grandchild survives its captured parent', async () => {
    setWindows();
    const snapshots = [
      '4242,1,100\n',
      '4242,1,100\n4343,4242,110\n',
      '4444,4343,120\n',
      '4444,4343,120\n',
    ];
    spawnSyncMock.mockImplementation((_command, args) => {
      const script = Array.isArray(args) ? String(args.at(-1)) : '';
      if (script.trim().endsWith('Out-Null')) return snapshot('');
      return snapshot(snapshots.shift() ?? '4444,4343,120\n');
    });
    const child = fakeChild(4_242);
    expect(rememberChildProcessTree(child as never)).toBe('100');

    await expect(killChildProcessTree(child as never, {
      forceMs: 0,
      taskkillMs: 100,
    })).resolves.toEqual({ status: 'unknown' });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('does not promote an incomplete root-only capture after an intermediate exits', async () => {
    setWindows();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,100\n'))
      .mockReturnValue(snapshot('4444,4343,120\n'));
    const child = fakeChild(4_242);
    expect(rememberChildProcessTree(child as never)).toBe('100');
    expect(rememberedChildProcessTreeIsComplete(child as never)).toBe(false);

    child.exitCode = 0;
    expect(rememberChildProcessTree(child as never)).toBe('100');
    expect(rememberedChildProcessTreeIsComplete(child as never)).toBe(false);
    await expect(killChildProcessTree(child as never, { forceMs: 0 }))
      .resolves.toEqual({ status: 'unknown' });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('taints every descendant below an ancestor with an unreadable identity', async () => {
    setWindows();
    const terminationScripts: string[] = [];
    const snapshots = [
      '4242,1,200\n',
      '4242,1,200\n4343,4242,0\n4444,4343,300\n',
      '',
    ];
    spawnSyncMock.mockImplementation((_command, args) => {
      const script = Array.isArray(args) ? String(args.at(-1)) : '';
      if (script.trim().endsWith('Out-Null')) {
        terminationScripts.push(script);
        return snapshot('');
      }
      return snapshot(snapshots.shift() ?? '');
    });
    const child = fakeChild(4_242);
    expect(rememberChildProcessTree(child as never)).toBe('200');

    await killChildProcessTree(child as never, { forceMs: 0, taskkillMs: 100 });

    expect(terminationScripts.join('\n')).toContain('TerminateExact(4242');
    expect(terminationScripts.join('\n')).not.toContain('TerminateExact(4444');
  });
});
