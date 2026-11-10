import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { waitForRuntimeDaemonShutdown } from './shutdown-verifier.js';
import {
  resolveRuntimeDaemonPathsFromConfigHome,
  writeRuntimeDaemonShutdownOutcome,
} from './state.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('runtime daemon shutdown verifier', () => {
  it('accepts only the exact durable successful outcome after the process fence is gone', async () => {
    const configHome = temporaryConfigHome();
    const owner = {
      runtimeId: 'rt_stopped',
      pid: deadPid(),
      kind: 'daemon' as const,
      ...(process.platform === 'win32'
        ? {
            processContainment: 'windows-job' as const,
            supervisorPid: deadPid(),
          }
        : {}),
    };
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome);
    writeRuntimeDaemonShutdownOutcome(paths, {
      version: 1,
      runtimeId: owner.runtimeId,
      pid: owner.pid,
      status: 'succeeded',
      completedAt: '2026-08-06T00:00:00.000Z',
    });

    await expect(waitForRuntimeDaemonShutdown({
      configHome,
      owner,
      timeoutMs: 100,
    })).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('reports a durable cleanup failure without inferring success from process exit', async () => {
    const configHome = temporaryConfigHome();
    const owner = { runtimeId: 'rt_failed', pid: deadPid(), kind: 'daemon' as const };
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome);
    writeRuntimeDaemonShutdownOutcome(paths, {
      version: 1,
      runtimeId: owner.runtimeId,
      pid: owner.pid,
      status: 'failed',
      completedAt: '2026-08-06T00:00:00.000Z',
      error: 'managed child cleanup failed',
    });

    await expect(waitForRuntimeDaemonShutdown({
      configHome,
      owner,
      timeoutMs: 100,
    })).resolves.toMatchObject({
      status: 'failed',
      outcome: { error: 'managed child cleanup failed' },
    });
  });

  it('does not accept an outcome while the containment supervisor is still active', async () => {
    const configHome = temporaryConfigHome();
    const owner = {
      runtimeId: 'rt_contained',
      pid: deadPid(),
      kind: 'daemon' as const,
      processContainment: 'windows-job' as const,
      supervisorPid: process.pid,
    };
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome);
    writeRuntimeDaemonShutdownOutcome(paths, {
      version: 1,
      runtimeId: owner.runtimeId,
      pid: owner.pid,
      status: 'succeeded',
      completedAt: '2026-08-06T00:00:00.000Z',
    });

    await expect(waitForRuntimeDaemonShutdown({
      configHome,
      owner,
      timeoutMs: 25,
      pollIntervalMs: 5,
    })).resolves.toEqual({ status: 'unverified', reason: 'containment_active' });
  });

  it('accepts the exact successful outcome when the supervisor PID was reused', async () => {
    const configHome = temporaryConfigHome();
    const owner = {
      runtimeId: 'rt_reused_supervisor',
      pid: deadPid(),
      kind: 'daemon' as const,
      processContainment: 'windows-job' as const,
      supervisorPid: process.pid,
      supervisorProcessStartIdentity: 'not-the-current-process-generation',
    };
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome);
    writeRuntimeDaemonShutdownOutcome(paths, {
      version: 1,
      runtimeId: owner.runtimeId,
      pid: owner.pid,
      status: 'succeeded',
      completedAt: '2026-08-06T00:00:00.000Z',
    });

    await expect(waitForRuntimeDaemonShutdown({
      configHome,
      owner,
      timeoutMs: 100,
    })).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('accepts the exact successful outcome when the daemon PID was reused', async () => {
    const configHome = temporaryConfigHome();
    const owner = {
      runtimeId: 'rt_reused_daemon',
      pid: process.pid,
      kind: 'daemon' as const,
      processStartIdentity: 'not-the-current-daemon-generation',
      processContainment: 'windows-job' as const,
      supervisorPid: deadPid(),
      supervisorProcessStartIdentity: 'gone-supervisor-generation',
    };
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome);
    writeRuntimeDaemonShutdownOutcome(paths, {
      version: 1,
      runtimeId: owner.runtimeId,
      pid: owner.pid,
      status: 'succeeded',
      completedAt: '2026-08-06T00:00:00.000Z',
    });

    await expect(waitForRuntimeDaemonShutdown({
      configHome,
      owner,
      timeoutMs: 100,
    })).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('keeps a legacy PID-only daemon active until that numeric PID exits', async () => {
    const configHome = temporaryConfigHome();
    const owner = {
      runtimeId: 'rt_legacy_daemon_generation',
      pid: process.pid,
      kind: 'daemon' as const,
      processContainment: 'windows-job' as const,
      supervisorPid: deadPid(),
    };
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome);
    writeRuntimeDaemonShutdownOutcome(paths, {
      version: 1,
      runtimeId: owner.runtimeId,
      pid: owner.pid,
      status: 'succeeded',
      completedAt: '2026-08-06T00:00:00.000Z',
    });

    await expect(waitForRuntimeDaemonShutdown({
      configHome,
      owner,
      timeoutMs: 25,
      pollIntervalMs: 5,
    })).resolves.toEqual({ status: 'unverified', reason: 'daemon_active' });
  });

  it('rejects an empty supervisor generation instead of treating it as PID reuse', async () => {
    await expect(waitForRuntimeDaemonShutdown({
      configHome: temporaryConfigHome(),
      owner: {
        runtimeId: 'rt_invalid_supervisor_identity',
        pid: deadPid(),
        kind: 'daemon',
        processContainment: 'windows-job',
        supervisorPid: process.pid,
        supervisorProcessStartIdentity: '',
      },
      timeoutMs: 100,
    })).rejects.toThrow('A supervisor process identity requires Windows Job containment');
  });

  it('does not let a replacement owner hide the exact old cleanup failure', async () => {
    const configHome = temporaryConfigHome();
    const owner = deadContainedOwner('rt_failed_before_replacement');
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome);
    writeRuntimeDaemonShutdownOutcome(paths, {
      version: 1,
      runtimeId: owner.runtimeId,
      pid: owner.pid,
      status: 'failed',
      completedAt: '2026-08-06T00:00:00.000Z',
      error: 'final cleanup failed',
    });
    writeReplacementLock(paths.lockFile);

    await expect(waitForRuntimeDaemonShutdown({
      configHome,
      owner,
      timeoutMs: 100,
    })).resolves.toMatchObject({ status: 'failed' });
  });

  it('does not accept a replacement while the old containment fence remains active', async () => {
    const configHome = temporaryConfigHome();
    const owner = {
      ...deadContainedOwner('rt_containment_before_replacement'),
      processContainment: 'windows-job' as const,
      supervisorPid: process.pid,
    };
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome);
    writeRuntimeDaemonShutdownOutcome(paths, {
      version: 1,
      runtimeId: owner.runtimeId,
      pid: owner.pid,
      status: 'succeeded',
      completedAt: '2026-08-06T00:00:00.000Z',
    });
    writeReplacementLock(paths.lockFile);

    await expect(waitForRuntimeDaemonShutdown({
      configHome,
      owner,
      timeoutMs: 25,
      pollIntervalMs: 5,
    })).resolves.toEqual({ status: 'unverified', reason: 'containment_active' });
  });

  it('reports a replacement only after the exact old successful shutdown is fenced', async () => {
    const configHome = temporaryConfigHome();
    const owner = deadContainedOwner('rt_succeeded_before_replacement');
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome);
    writeRuntimeDaemonShutdownOutcome(paths, {
      version: 1,
      runtimeId: owner.runtimeId,
      pid: owner.pid,
      status: 'succeeded',
      completedAt: '2026-08-06T00:00:00.000Z',
    });
    writeReplacementLock(paths.lockFile);

    await expect(waitForRuntimeDaemonShutdown({
      configHome,
      owner,
      timeoutMs: 100,
    })).resolves.toMatchObject({
      status: 'replacement_running',
      runtimeId: 'rt_replacement',
      pid: process.pid,
    });
  });

  it.skipIf(process.platform !== 'win32')(
    'does not promote an uncontained legacy daemon outcome to verified success',
    async () => {
      const configHome = temporaryConfigHome();
      const owner = { runtimeId: 'rt_legacy', pid: deadPid(), kind: 'daemon' as const };
      const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome);
      writeRuntimeDaemonShutdownOutcome(paths, {
        version: 1,
        runtimeId: owner.runtimeId,
        pid: owner.pid,
        status: 'succeeded',
        completedAt: '2026-08-06T00:00:00.000Z',
      });

      await expect(waitForRuntimeDaemonShutdown({
        configHome,
        owner,
        timeoutMs: 100,
      })).resolves.toEqual({ status: 'unverified', reason: 'containment_unavailable' });
    },
  );
});

function temporaryConfigHome(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-shutdown-verifier-'));
  temporaryDirectories.push(directory);
  return directory;
}

function deadPid(): number {
  for (let pid = 2_000_000_000; pid > 1_999_999_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  throw new Error('Could not find an unused PID for the shutdown verifier test.');
}

function deadContainedOwner(runtimeId: string): {
  readonly runtimeId: string;
  readonly pid: number;
  readonly kind: 'daemon';
  readonly processContainment?: 'windows-job';
  readonly supervisorPid?: number;
} {
  return {
    runtimeId,
    pid: deadPid(),
    kind: 'daemon',
    ...(process.platform === 'win32'
      ? { processContainment: 'windows-job' as const, supervisorPid: deadPid() }
      : {}),
  };
}

function writeReplacementLock(lockFile: string): void {
  writeFileSync(lockFile, JSON.stringify({
    runtimeId: 'rt_replacement',
    pid: process.pid,
    createdAt: '2026-08-06T00:00:01.000Z',
    kind: 'daemon',
  }), 'utf8');
}
