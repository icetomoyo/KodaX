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
  withSharedWindowsProcessSnapshot,
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
  it('verifies a drained tree using the fresh snapshot from the termination process', async () => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n4343,4242,112\n'))
      .mockReturnValueOnce(snapshot('KODAX_TERMINATION_COMPLETED\n0,0,0\n1,0,100\nKODAX_SNAPSHOT_COMPLETED\n'))
      .mockReturnValue(snapshot('1,0,100\n'));

    await expect(killPidTree(4_242, {
      expectedProcessStartIdentity: '111', forceMs: 0,
    })).resolves.toEqual({ status: 'terminated' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    const script = String(spawnSyncMock.mock.calls[1]?.[1]?.at(-1));
    expect(script.indexOf('::TerminateExact(4343')).toBeLessThan(script.indexOf('::TerminateExact(4242'));
    expect(script.indexOf('::TerminateExact(4242')).toBeLessThan(script.indexOf('::ReadRows()'));
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
      .mockReturnValueOnce(snapshot(output))
      .mockReturnValue(snapshot('1,0,100\n'));

    await expect(killPidTree(4_242, {
      expectedProcessStartIdentity: '111', forceMs: 0,
    })).resolves.toEqual({ status: 'terminated' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  });

  it('preserves the unknown result when the termination process fails without stdout', async () => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce({ ...snapshot(''), stdout: undefined, error: new Error('ENOENT'), status: null })
      .mockReturnValue(snapshot('4242,1,111\n'));
    await expect(killPidTree(4_242, {
      expectedProcessStartIdentity: '111', forceMs: 0,
    })).resolves.toEqual({ status: 'unknown' });
  });

  it.each([false, true])('preserves retry after snapshot timeout only with completed termination (%s)', async (completed) => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce({
        ...snapshot(completed ? 'KODAX_TERMINATION_COMPLETED\n' : ''),
        error: new Error('ETIMEDOUT'), status: null,
      })
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot(''))
      .mockReturnValue(snapshot('1,0,100\n'));
    const result = await killPidTree(4_242, {
      expectedProcessStartIdentity: '111', forceMs: 0,
    });
    expect(result).toEqual({ status: completed ? 'terminated' : 'unknown' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(completed ? 5 : 3);
    const script = String(spawnSyncMock.mock.calls[1]?.[1]?.at(-1));
    expect(script.indexOf("Out.WriteLine('KODAX_TERMINATION_COMPLETED')"))
      .toBeLessThan(script.indexOf('Out.Flush()'));
    expect(script.indexOf('Out.Flush()')).toBeLessThan(script.indexOf('::ReadRows()'));
  });

  it('does not certify a tree while a retained uncertain descendant is still present', async () => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n4343,4242,0\n'))
      .mockReturnValueOnce(snapshot('KODAX_TERMINATION_COMPLETED\n1,0,100\n4343,9,222\nKODAX_SNAPSHOT_COMPLETED\n'))
      .mockReturnValue(snapshot('4343,9,222\n'));
    const result = await killPidTree(4_242, {
      expectedProcessStartIdentity: '111', forceMs: 0,
    });
    expect(result).toEqual({ status: 'unknown' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(5);
    const script = String(spawnSyncMock.mock.calls[1]?.[1]?.at(-1));
    expect(script).not.toContain('::TerminateExact(4343');
  });

  it.each([
    ['already gone', 'KODAX_TERMINATION_COMPLETED\n1,0,100\nKODAX_SNAPSHOT_COMPLETED\n', 3],
    ['still alive', 'KODAX_TERMINATION_COMPLETED\n4242,1,111\nKODAX_SNAPSHOT_COMPLETED\n', 4],
    ['unavailable', '', 4],
  ] as const)('preserves synchronous verification when the immediate snapshot is %s', (_scenario, output, calls) => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot('4242,1,111\n'))
      .mockReturnValueOnce(snapshot(output))
      .mockReturnValue(snapshot('1,0,100\n'));
    const child = fakeChild(4_242);
    rememberChildProcessTree(child as never);

    expect(killChildProcessTreeSync(child as never)).toEqual({ status: 'terminated' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(calls);
  });

  it('does not add a post-termination snapshot to an incomplete retained tree', async () => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValueOnce(snapshot('1,0,100\n')).mockReturnValue(snapshot(''));

    await expect(killPidTree(4_242, {
      expectedProcessStartIdentity: '111',
      expectedProcessTreeIdentities: [{ pid: 4_242, creationTime: '111' }, { pid: 4_343, creationTime: '112' }],
      expectedProcessTreeComplete: false, forceMs: 0,
    })).resolves.toEqual({ status: 'unknown' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    const script = String(spawnSyncMock.mock.calls[1]?.[1]?.at(-1));
    expect(script).toContain('::TerminateExact(4343');
    expect(script).not.toContain('::ReadRows()');
  });

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
      if (/::TerminateExact\(\d/.test(script)) {
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
        if (/::TerminateExact\(\d/.test(script)) {
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
      if (/::TerminateExact\(\d/.test(script)) { scripts.push(script); rootAlive = false; return snapshot(''); }
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
      if (/::TerminateExact\(\d/.test(script)) { scripts.push(script); rootAlive = false; return snapshot(''); }
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
      if (/::TerminateExact\(\d/.test(script)) {
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
      if (/::TerminateExact\(\d/.test(script)) return snapshot('');
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
      if (/::TerminateExact\(\d/.test(script)) {
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

describe('shared cleanup snapshot scope', () => {
  it('serves every read in the scope from one snapshot and re-reads after a termination', async () => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce(snapshot('4242,1,111\n4343,4242,112\n'))
      .mockReturnValueOnce(snapshot('KODAX_TERMINATION_COMPLETED\n0,0,0\n1,0,100\nKODAX_SNAPSHOT_COMPLETED\n'))
      .mockReturnValue(snapshot('1,0,100\n'));
    await withSharedWindowsProcessSnapshot(async () => {
      expect(readProcessStartIdentity(4242)).toBe('111');
      // served from the shared snapshot: no second spawn for the tree read
      expect(readProcessStartIdentity(4343)).toBe('112');
      await expect(killPidTree(4242, { expectedProcessStartIdentity: '111', forceMs: 0 }))
        .resolves.toEqual({ status: 'terminated' });
      // the termination invalidated the shared snapshot: the next read is fresh
      expect(readProcessStartIdentity(4242)).toBeUndefined();
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  });

  it('does not cache snapshot reads outside the shared scope', async () => {
    setWindows();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue(snapshot('4242,1,111\n'));
    await withSharedWindowsProcessSnapshot(async () => {
      expect(readProcessStartIdentity(4242)).toBe('111');
      expect(readProcessStartIdentity(4242)).toBe('111');
    });
    expect(readProcessStartIdentity(4242)).toBe('111');
    expect(readProcessStartIdentity(4242)).toBe('111');
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  });
});
