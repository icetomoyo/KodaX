import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted(() => ({
  mode: 'idle',
  lockPath: '',
  staleOwner: '',
  successorOwner: '',
  replaced: false,
  removedSuccessor: false,
  lockRemovals: 0,
  lockReads: 0,
  secondRemovalReached: undefined as (() => void) | undefined,
  waitForSecondRemoval: undefined as Promise<void> | undefined,
  operationStarted: undefined as Promise<void> | undefined,
  openFailureCode: '',
  repeatOpenFailure: false,
  injectedOpenFailure: false,
  removedTicketAfterOwnerCreate: false,
  markerWriteFailureCount: 0,
  rmFailureCounts: {} as Record<string, number>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(async (
      target: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1],
      mode?: Parameters<typeof actual.open>[2],
    ) => {
      if (String(target) === fsMockState.lockPath
        && flags === 'wx'
        && fsMockState.openFailureCode !== ''
        && (fsMockState.repeatOpenFailure || !fsMockState.injectedOpenFailure)) {
        fsMockState.injectedOpenFailure = true;
        throw Object.assign(new Error('simulated Windows open failure'), {
          code: fsMockState.openFailureCode,
        });
      }
      return actual.open(target, flags, mode);
    }),
    writeFile: vi.fn(async (
      target: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ): Promise<void> => {
      const targetPath = String(target);
      if (targetPath.startsWith(`${fsMockState.lockPath}.`)
        && targetPath.endsWith('.released')) {
        if (fsMockState.markerWriteFailureCount > 0) {
          fsMockState.markerWriteFailureCount -= 1;
          throw Object.assign(new Error('simulated marker write contention'), { code: 'EPERM' });
        }
        await actual.writeFile(target, data, options);
        if (fsMockState.mode === 'successor-after-marker' && !fsMockState.replaced) {
          fsMockState.replaced = true;
          await actual.rm(fsMockState.lockPath, { force: true });
          await actual.writeFile(fsMockState.lockPath, fsMockState.successorOwner, 'utf8');
        }
        return;
      }
      await actual.writeFile(target, data, options);
    }),
    readFile: vi.fn(async (
      target: Parameters<typeof actual.readFile>[0],
      encoding: BufferEncoding,
    ): Promise<string> => {
      const targetPath = String(target);
      if (fsMockState.mode === 'remove-ticket-after-owner-create'
        && !fsMockState.removedTicketAfterOwnerCreate
        && targetPath.includes(`${path.sep}ticket-`)) {
        const ownerExists = await actual.readFile(fsMockState.lockPath, 'utf8')
          .then(() => true, () => false);
        if (ownerExists) {
          fsMockState.removedTicketAfterOwnerCreate = true;
          await actual.rm(targetPath, { force: true });
        }
      }
      const value = await actual.readFile(target, encoding);
      if (fsMockState.mode === 'unknown-successor-after-observation' && !fsMockState.replaced
        && targetPath === fsMockState.lockPath) {
        fsMockState.replaced = true;
        await actual.writeFile(target, fsMockState.successorOwner, 'utf8');
        await actual.utimes(target, new Date(0), new Date(0));
      }
      if (fsMockState.mode === 'replace-on-final-read-without-ticket'
        && !fsMockState.replaced
        && String(target) === fsMockState.lockPath) {
        fsMockState.lockReads += 1;
        if (fsMockState.lockReads === 2) {
          const queueNames = await actual.readdir(`${fsMockState.lockPath}.queue`)
            .catch(() => []);
          const queued = queueNames.some((name) => (
            name.startsWith('choosing-') || name.startsWith('ticket-')
          ));
          if (!queued) {
            fsMockState.replaced = true;
            await actual.writeFile(
              fsMockState.lockPath,
              fsMockState.successorOwner,
              'utf8',
            );
          }
        }
      }
      if (fsMockState.mode === 'replace-on-read'
        && !fsMockState.replaced
        && String(target) === fsMockState.lockPath) {
        fsMockState.replaced = true;
        await actual.writeFile(fsMockState.lockPath, fsMockState.successorOwner, 'utf8');
        setTimeout(() => {
          void actual.rm(fsMockState.lockPath, { force: true });
        }, 100);
        return fsMockState.staleOwner;
      }
      return value;
    }),
    rm: vi.fn(async (
      target: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ): Promise<void> => {
      const targetPath = String(target);
      const cleanupKind = targetPath === fsMockState.lockPath
        ? 'owner'
        : targetPath.startsWith(`${fsMockState.lockPath}.`)
          && targetPath.endsWith('.released')
          ? 'marker'
        : targetPath.includes(`${path.sep}choosing-`)
          ? 'choosing'
          : targetPath.includes(`${path.sep}ticket-`)
            ? 'ticket'
            : undefined;
      if (cleanupKind === 'owner'
        && fsMockState.mode === 'successor-after-marker'
        && !fsMockState.replaced) {
        throw Object.assign(new Error('simulated owner cleanup contention'), { code: 'EPERM' });
      }
      if (cleanupKind !== undefined && (fsMockState.rmFailureCounts[cleanupKind] ?? 0) > 0) {
        fsMockState.rmFailureCounts[cleanupKind] -= 1;
        throw Object.assign(new Error(`simulated ${cleanupKind} cleanup contention`), {
          code: 'EPERM',
        });
      }
      if (String(target) === fsMockState.lockPath) {
        if (fsMockState.mode === 'coordinate-reclaimers') {
          fsMockState.lockRemovals += 1;
          if (fsMockState.lockRemovals === 1) {
            await Promise.race([
              fsMockState.waitForSecondRemoval ?? Promise.resolve(),
              new Promise<void>((resolve) => setTimeout(resolve, 100)),
            ]);
          } else if (fsMockState.lockRemovals === 2) {
            fsMockState.secondRemovalReached?.();
            await fsMockState.operationStarted;
          }
        }
        try {
          fsMockState.removedSuccessor ||= await actual.readFile(target, 'utf8')
            === fsMockState.successorOwner;
        } catch {
          // A concurrently released lock is already absent.
        }
      }
      await actual.rm(target, options);
    }),
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  fsMockState.rmFailureCounts = {};
  fsMockState.openFailureCode = '';
  fsMockState.repeatOpenFailure = false;
  fsMockState.injectedOpenFailure = false;
  fsMockState.removedTicketAfterOwnerCreate = false;
  fsMockState.markerWriteFailureCount = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('learning file lock stale recovery', () => {
  it('reclaims a fresh reused-PID owner and all of its identity-matched queue entries with one owner lookup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-fresh-identity-')); tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const queuePath = `${lockPath}.queue`;
    const identity = Buffer.from('old-process-start').toString('base64url');
    const raw = `${process.pid} aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa identity=${identity}\n`;
    await writeFile(lockPath, raw);
    await mkdir(queuePath);
    for (let index = 1; index <= 4; index++) {
      const token = `${index}bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
      await writeFile(path.join(queuePath, `ticket-${String(index).padStart(16, '0')}-${token}.lock`),
        `${process.pid} ${token} identity=${identity}\n`);
    }
    await writeFile(path.join(queuePath, 'choosing-cccccccc-cccc-4ccc-8ccc-cccccccccccc.lock'), raw);
    const processTree = await import('../runtime/process-tree.js');
    const readIdentity = vi.spyOn(processTree, 'readProcessStartIdentity').mockReturnValue('current-process-start');
    const { reclaimStaleLearningFileLock } = await import('./store-lock.js');
    expect(await reclaimStaleLearningFileLock(lockPath, { requireKnownOwner: true })).toBe(true);
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(queuePath)).toEqual([]);
    // One observation of the old PID, plus the existing cached identity for our own ticket.
    expect(readIdentity).toHaveBeenCalledTimes(2);
  });

  it.each(['matching', 'unknown', 'legacy', 'empty'] as const)('retains a fresh %s owner during explicit known-owner recovery', async state => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-fresh-retain-')); tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const identity = Buffer.from('original-process-start').toString('base64url');
    const raw = `${process.pid} dddddddd-dddd-4ddd-8ddd-dddddddddddd${state === 'legacy' ? '' : state === 'empty' ? ' identity=A' : ` identity=${identity}`}\n`;
    await writeFile(lockPath, raw);
    const processTree = await import('../runtime/process-tree.js');
    const readIdentity = vi.spyOn(processTree, 'readProcessStartIdentity')
      .mockReturnValue(state === 'unknown' ? undefined : 'original-process-start');
    const { reclaimStaleLearningFileLock } = await import('./store-lock.js');
    expect(await reclaimStaleLearningFileLock(lockPath, { requireKnownOwner: true })).toBe(false);
    expect(await readFile(lockPath, 'utf8')).toBe(raw);
    expect(readIdentity).toHaveBeenCalledTimes(state === 'legacy' || state === 'empty' ? 0 : 1);
  });

  it('retains a fresh legacy ticket even after proving the coordinator PID was reused', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-fresh-legacy-ticket-')); tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const queuePath = `${lockPath}.queue`;
    const token = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const identity = Buffer.from('old-process-start').toString('base64url');
    const owner = `${process.pid} ${token} identity=${identity}\n`;
    const ticket = path.join(queuePath, `ticket-0000000000000001-${token}.lock`);
    const legacy = `${process.pid} ${token}\n`;
    await writeFile(lockPath, owner); await mkdir(queuePath); await writeFile(ticket, legacy);
    const processTree = await import('../runtime/process-tree.js');
    const readIdentity = vi.spyOn(processTree, 'readProcessStartIdentity').mockReturnValue('current-process-start');
    const { reclaimStaleLearningFileLock } = await import('./store-lock.js');
    expect(await reclaimStaleLearningFileLock(lockPath, { requireKnownOwner: true })).toBe(false);
    expect(await readFile(lockPath, 'utf8')).toBe(owner);
    expect(await readFile(ticket, 'utf8')).toBe(legacy);
    expect(readIdentity).toHaveBeenCalledTimes(2);
  });

  it('retains an aged empty identity as unknown for strict recovery while ordinary writers retain legacy recovery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-aged-empty-')); tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const raw = `${process.pid} dddddddd-dddd-4ddd-8ddd-dddddddddddd identity=A\n`;
    await writeFile(lockPath, raw);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const processTree = await import('../runtime/process-tree.js');
    const readIdentity = vi.spyOn(processTree, 'readProcessStartIdentity').mockReturnValue('current-process-start');
    const { reclaimStaleLearningFileLock, withLearningFileLock } = await import('./store-lock.js');
    expect(await reclaimStaleLearningFileLock(lockPath, { requireKnownOwner: true })).toBe(false);
    expect(await readFile(lockPath, 'utf8')).toBe(raw);
    expect(readIdentity).not.toHaveBeenCalled();
    await expect(withLearningFileLock(lockPath, async () => 'recovered', 500)).resolves.toBe('recovered');
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adds no fresh owner identity query to ordinary writers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-fresh-writer-')); tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const identity = Buffer.from('old-process-start').toString('base64url');
    const raw = `${process.pid} ffffffff-ffff-4fff-8fff-ffffffffffff identity=${identity}\n`;
    await writeFile(lockPath, raw);
    const processTree = await import('../runtime/process-tree.js');
    const readIdentity = vi.spyOn(processTree, 'readProcessStartIdentity').mockReturnValue('current-process-start');
    const { acquireLearningFileLock } = await import('./store-lock.js');
    await expect(acquireLearningFileLock(lockPath, 0)).rejects.toMatchObject({ code: 'kodax_file_lock_timeout' });
    expect(await readFile(lockPath, 'utf8')).toBe(raw);
    // Only the original one-time self-identity capture for the writer's ticket.
    expect(readIdentity).toHaveBeenCalledTimes(1);
  });

  it('does not reap its own choosing entry when the logical clock jumps forward', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-own-choosing-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 60_000));

    const { acquireLearningFileLock } = await import('./store-lock.js');
    const release = await acquireLearningFileLock(lockPath, 500);
    await release();
  });

  it('does not create queue artifacts when no stale lock exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-no-reclaim-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const { reclaimStaleLearningFileLock } = await import('./store-lock.js');

    await expect(reclaimStaleLearningFileLock(lockPath)).resolves.toBe(false);
    await expect(readdir(`${lockPath}.queue`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains an unknown successor installed between known-owner stale observations, while ordinary writers retain legacy recovery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-known-reclaim-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const unknown = 'unknown-owner\n';
    await writeFile(lockPath, '2147483647 11111111-1111-4111-8111-111111111111\n');
    await utimes(lockPath, new Date(0), new Date(0));
    Object.assign(fsMockState, { mode: 'unknown-successor-after-observation', lockPath,
      successorOwner: unknown, replaced: false, removedSuccessor: false });
    const { reclaimStaleLearningFileLock, acquireLearningFileLock } = await import('./store-lock.js');
    try {
      expect(await reclaimStaleLearningFileLock(lockPath, { requireKnownOwner: true })).toBe(false);
      expect(fsMockState.replaced).toBe(true);
      expect(fsMockState.removedSuccessor).toBe(false);
      expect(await readFile(lockPath, 'utf8')).toBe(unknown);
      const release = await acquireLearningFileLock(lockPath, 500);
      await release();
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { fsMockState.mode = 'idle'; }
  });

  it('does not remove a successor while reclaiming a stale lock outside an operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-direct-reclaim-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const staleOwner = '2147483647 11111111-1111-4111-8111-111111111111\n';
    const successorOwner = `${process.pid} 22222222-2222-4222-8222-222222222222\n`;
    await writeFile(lockPath, staleOwner, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    Object.assign(fsMockState, {
      mode: 'replace-on-final-read-without-ticket',
      lockPath,
      staleOwner,
      successorOwner,
      replaced: false,
      removedSuccessor: false,
      lockReads: 0,
    });

    const { reclaimStaleLearningFileLock } = await import('./store-lock.js');
    await reclaimStaleLearningFileLock(lockPath);

    expect(fsMockState.removedSuccessor).toBe(false);
  });

  it('does not let a second stale reclaimer remove the successor lock acquired by the first', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-reclaim-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const staleOwner = '2147483647 11111111-1111-4111-8111-111111111111\n';
    const successorOwner = `${process.pid} 22222222-2222-4222-8222-222222222222\n`;
    await writeFile(lockPath, staleOwner, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    Object.assign(fsMockState, {
      mode: 'replace-on-read',
      lockPath,
      staleOwner,
      successorOwner,
      replaced: false,
      removedSuccessor: false,
    });

    const { withLearningFileLock } = await import('./store-lock.js');
    await withLearningFileLock(lockPath, async () => undefined);

    expect(fsMockState.replaced).toBe(true);
    expect(fsMockState.removedSuccessor).toBe(false);
  });

  it('reclaims a stale zero-byte lock left before its owner record was written', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-empty-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    await writeFile(lockPath, '', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'recovered', 250))
      .resolves.toBe('recovered');
  });

  it.each([
    'not-an-owner\n',
    '2147483647 11111111-1111-4111-8111-111111111111 identity=***truncated***\n',
  ])('reclaims a stale malformed lock owner without manual cleanup', async (malformedOwner) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-malformed-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    await writeFile(lockPath, malformedOwner, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'recovered', 250))
      .resolves.toBe('recovered');
  });

  it('serializes two reclaimers that both observed the same stale owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-two-reclaimers-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const staleOwner = '2147483647 33333333-3333-4333-8333-333333333333\n';
    await writeFile(lockPath, staleOwner, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    let signalSecondRemoval!: () => void;
    const waitForSecondRemoval = new Promise<void>((resolve) => {
      signalSecondRemoval = resolve;
    });
    let signalOperationStarted!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      signalOperationStarted = resolve;
    });
    Object.assign(fsMockState, {
      mode: 'coordinate-reclaimers',
      lockPath,
      staleOwner,
      successorOwner: '',
      replaced: false,
      removedSuccessor: false,
      lockRemovals: 0,
      secondRemovalReached: signalSecondRemoval,
      waitForSecondRemoval,
      operationStarted,
    });

    const { withLearningFileLock } = await import('./store-lock.js');
    let active = 0;
    let maxActive = 0;
    const operation = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      signalOperationStarted();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      active -= 1;
    };

    await Promise.all([
      withLearningFileLock(lockPath, operation),
      withLearningFileLock(lockPath, operation),
    ]);

    expect(maxActive).toBe(1);
  });

  it('recovers abandoned ticket and choosing entries after their owners die', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-dead-ticket-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const queuePath = `${lockPath}.queue`;
    const deadOwner = '2147483647 44444444-4444-4444-8444-444444444444\n';
    const abandoned = [
      path.join(queuePath, 'choosing-44444444-4444-4444-8444-444444444444.lock'),
      path.join(queuePath, 'ticket-0000000000000001-44444444-4444-4444-8444-444444444444.lock'),
    ];
    await mkdir(queuePath, { recursive: true });
    await Promise.all(abandoned.map((filePath) => writeFile(filePath, deadOwner, 'utf8')));
    const old = new Date(Date.now() - 60_000);
    await Promise.all(abandoned.map((filePath) => utimes(filePath, old, old)));
    Object.assign(fsMockState, {
      mode: 'idle',
      lockPath,
      staleOwner: '',
      successorOwner: '',
      replaced: false,
      removedSuccessor: false,
      lockRemovals: 0,
    });

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'acquired')).resolves.toBe('acquired');
  });

  it('recovers a stale live-process ticket that no longer owns the coordinator lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-orphan-operation-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const queuePath = `${lockPath}.queue`;
    const token = '45454545-4545-4454-8454-454545454545';
    const ticketPath = path.join(
      queuePath,
      `ticket-0000000000000001-${token}.lock`,
    );
    await mkdir(queuePath, { recursive: true });
    await writeFile(ticketPath, `${process.pid} ${token}\n`, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(ticketPath, old, old);

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'recovered', 250))
      .resolves.toBe('recovered');
  });

  it('recovers a stale live-process choosing entry from an abandoned operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-orphan-choosing-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const queuePath = `${lockPath}.queue`;
    const token = '47474747-4747-4474-8474-474747474747';
    const choosingPath = path.join(queuePath, `choosing-${token}.lock`);
    await mkdir(queuePath, { recursive: true });
    await writeFile(choosingPath, `${process.pid} ${token}\n`, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(choosingPath, old, old);

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'recovered', 250))
      .resolves.toBe('recovered');
  });

  it('keeps a stale live-process ticket while its exact coordinator lock is active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-active-operation-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const queuePath = `${lockPath}.queue`;
    const token = '46464646-4646-4464-8464-464646464646';
    const owner = `${process.pid} ${token}\n`;
    const ticketPath = path.join(
      queuePath,
      `ticket-0000000000000001-${token}.lock`,
    );
    await mkdir(queuePath, { recursive: true });
    await writeFile(ticketPath, owner, 'utf8');
    await writeFile(lockPath, owner, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await Promise.all([
      utimes(ticketPath, old, old),
      utimes(lockPath, old, old),
    ]);

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => undefined, 100))
      .rejects.toMatchObject({
        name: 'KodaXFileLockTimeoutError',
        code: 'kodax_file_lock_timeout',
        lockPath,
      });
  });

  it('releases the coordinator lock when its queue ticket is lost after lock creation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-ticket-loss-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    fsMockState.mode = 'remove-ticket-after-owner-create';
    fsMockState.lockPath = lockPath;

    const { acquireLearningFileLock } = await import('./store-lock.js');
    await expect(acquireLearningFileLock(lockPath, 500)).rejects.toThrow(
      /ticket lost/i,
    );

    fsMockState.mode = 'idle';
    const release = await acquireLearningFileLock(lockPath, 500);
    await release();
  });

  it('reclaims a stale lock when its PID was reused by a different process identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-reused-pid-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const staleIdentity = Buffer.from('different-process-start', 'utf8').toString('base64url');
    await writeFile(
      lockPath,
      `${process.pid} 55555555-5555-4555-8555-555555555555 identity=${staleIdentity}\n`,
      'utf8',
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'acquired', 250))
      .resolves.toBe('acquired');
  });

  it('treats a Windows access-shaped open failure as contention when the lock exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-windows-contention-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    await writeFile(
      lockPath,
      `${process.pid} 55555555-5555-4555-8555-555555555555\n`,
      'utf8',
    );
    Object.assign(fsMockState, {
      mode: 'idle',
      lockPath,
      openFailureCode: 'EPERM',
      injectedOpenFailure: false,
    });
    setTimeout(() => {
      void rm(lockPath, { force: true });
    }, 50);

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'acquired')).resolves.toBe('acquired');
    expect(fsMockState.injectedOpenFailure).toBe(true);
  });

  it('preserves a Windows access error when no competing lock exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-windows-permission-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    Object.assign(fsMockState, {
      mode: 'idle',
      lockPath,
      openFailureCode: 'EACCES',
      repeatOpenFailure: true,
      injectedOpenFailure: false,
    });

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => undefined))
      .rejects.toThrow('simulated Windows open failure');
  });

  it('retries once when a Windows access-shaped contention disappears before stat', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-windows-race-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    Object.assign(fsMockState, {
      mode: 'idle',
      lockPath,
      openFailureCode: 'EPERM',
      repeatOpenFailure: false,
      injectedOpenFailure: false,
    });

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'acquired'))
      .resolves.toBe('acquired');
    expect(fsMockState.injectedOpenFailure).toBe(true);
  });

  it('retries transient Windows cleanup failures for queue entries and the owner lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-windows-cleanup-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    Object.assign(fsMockState, {
      mode: 'idle',
      lockPath,
      rmFailureCounts: { choosing: 1, ticket: 1, owner: 1 },
    });

    const { withLearningFileLock } = await import('./store-lock.js');
    await expect(withLearningFileLock(lockPath, async () => 'first')).resolves.toBe('first');
    await expect(withLearningFileLock(lockPath, async () => 'second')).resolves.toBe('second');
    expect(fsMockState.rmFailureCounts).toEqual({ choosing: 0, ticket: 0, owner: 0 });
  });

  it('does not remove a successor after publishing a release marker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-release-handoff-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    const successorOwner = `${process.pid} 22222222-2222-4222-8222-222222222222\n`;
    Object.assign(fsMockState, {
      mode: 'successor-after-marker',
      lockPath,
      successorOwner,
      replaced: false,
      removedSuccessor: false,
    });

    const { acquireLearningFileLock } = await import('./store-lock.js');
    const release = await acquireLearningFileLock(lockPath);
    await release();

    expect(await readFile(lockPath, 'utf8')).toBe(successorOwner);
    expect(fsMockState.removedSuccessor).toBe(false);
  });

  it('can retry release after owner cleanup and release-marker writes both fail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-store-lock-release-retry-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'owner.lock');
    Object.assign(fsMockState, {
      mode: 'idle',
      lockPath,
      markerWriteFailureCount: 8,
      rmFailureCounts: { owner: 8 },
    });

    const { acquireLearningFileLock } = await import('./store-lock.js');
    const release = await acquireLearningFileLock(lockPath);
    await expect(release()).rejects.toThrow('release marker and owner cleanup both failed');

    fsMockState.rmFailureCounts.owner = 0;
    await expect(release()).resolves.toBeUndefined();
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  for (const cleanupKind of ['choosing', 'ticket', 'owner'] as const) {
    it(`recovers a ${cleanupKind} entry after every immediate Windows cleanup retry is exhausted`, async () => {
      const root = await mkdtemp(path.join(
        os.tmpdir(),
        `kodax-store-lock-exhausted-${cleanupKind}-`,
      ));
      tempDirs.push(root);
      const lockPath = path.join(root, 'owner.lock');
      Object.assign(fsMockState, {
        mode: 'idle',
        lockPath,
        rmFailureCounts: { [cleanupKind]: 8 },
      });

      const { withLearningFileLock } = await import('./store-lock.js');
      await expect(withLearningFileLock(lockPath, async () => 'first'))
        .resolves.toBe('first');
      await expect(withLearningFileLock(lockPath, async () => 'second'))
        .resolves.toBe('second');
      expect(fsMockState.rmFailureCounts[cleanupKind]).toBe(0);
    });
  }
});
