import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupRegisteredManagedChildren } from '@kodax-ai/agent';
import { toolBash } from './bash.js';
import { clearShellExecutionEnvironmentCache, resolveShellExecution } from '../shell-execution/resolver.js';

const jobReceipt = vi.hoisted(() => ({
  held: undefined as {
    readonly actualDrained: () => void;
    readonly failure: Promise<void>;
    readonly verified: Promise<void>;
  } | undefined,
}));

vi.mock('../../../agent/src/runtime/windows-effect-job.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../agent/src/runtime/windows-effect-job.js')>();
  return {
    ...actual,
    async containWindowsEffectProcess(...args: Parameters<typeof actual.containWindowsEffectProcess>) {
      const job = await actual.containWindowsEffectProcess(...args);
      const held = jobReceipt.held;
      if (!held) return job;
      return { ...job, drained: job.drained.then(async () => {
        held.actualDrained();
        await held.verified;
      }) };
    },
    async terminateWindowsEffectJob(...args: Parameters<typeof actual.terminateWindowsEffectJob>) {
      if (jobReceipt.held) {
        await jobReceipt.held.failure;
        throw new Error('Job drain receipt is unavailable.');
      }
      return actual.terminateWindowsEffectJob(...args);
    },
  };
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe.runIf(process.platform === 'win32')('standalone Windows Shell cleanup acceptance', () => {
  let directory = '';
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kodax-shell-cleanup-'));
    vi.stubEnv('KODAX_HOME', join(directory, 'agent-home'));
    clearShellExecutionEnvironmentCache();
    await writeFile(join(directory, 'spawn.cjs'), `
      const {spawn} = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true, stdio: 'ignore'
      });
      child.unref();
      fs.writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
      process.stdout.write('cleanup-output\\n');
      process.stderr.write('cleanup-stderr\\n');
      if (process.argv[2] === 'exit') process.exit(7);
      setInterval(() => {}, 1000);
    `);
  });
  afterEach(async () => {
    try {
      const cleanup = await cleanupRegisteredManagedChildren({
        includeCurrentOwner: true, requireCurrentOwnerCleanup: true,
      });
      expect(cleanup.skipped).toBe(0);
      expect(await registryFiles(join(directory, 'agent-home/runtime/processes/children'))).toEqual([]);
      expect(directory.startsWith(join(tmpdir(), 'kodax-shell-cleanup-'))).toBe(true);
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } finally {
      vi.unstubAllEnvs();
      clearShellExecutionEnvironmentCache();
    }
  });

  it.each(['exit', 'cancel', 'timeout'] as const)(
    'drains detached descendants and recovery records on %s', async (mode) => {
      const abort = new AbortController();
      const result = toolBash({ command: `node spawn.cjs ${mode}`, timeout: mode === 'timeout' ? 5 : 20 }, {
        backups: new Map(), executionCwd: directory, abortSignal: abort.signal,
      });
      let pids: number[] = [];
      await vi.waitFor(async () => {
        pids = JSON.parse(await readFile(join(directory, 'pids.json'), 'utf8')) as number[];
        expect(pids).toHaveLength(2);
      }, { timeout: 15_000, interval: 20 });
      if (mode === 'cancel') abort.abort();
      const output = await result;
      expect(output).toContain('cleanup-output');
      expect(output).toContain('cleanup-stderr');
      expect(output).toContain(mode === 'exit' ? 'Exit: 7' : mode === 'cancel' ? '[Cancelled]' : '[Timeout]');
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      }
    },
  );

  it('does not run environment setup when durable probe registration fails', async () => {
    const blocked = join(directory, 'blocked-home');
    await writeFile(blocked, 'not a directory');
    vi.stubEnv('KODAX_HOME', blocked);
    try {
      const result = await toolBash({ command: 'echo must-not-run' }, {
        backups: new Map(), executionCwd: directory,
        shellExecution: { version: 1, shell: { kind: 'cmd', profile: 'none' },
          environment: { setup: 'echo escaped>setup-ran' } },
      });
      expect(result).toContain('[Error] Command was not started');
      expect(result).toContain('ENOTDIR');
      await expect(readFile(join(directory, 'setup-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.stubEnv('KODAX_HOME', join(directory, 'agent-home'));
    }
  });

  it('retains a naturally exited command cleanup fence until its exact Job drain is verified', async () => {
    const shellExecution = { version: 1, shell: { kind: 'cmd', profile: 'none' } } as const;
    await resolveShellExecution(shellExecution, directory);
    const actualDrained = gate();
    const failure = gate();
    const verified = gate();
    jobReceipt.held = { actualDrained: actualDrained.resolve, failure: failure.promise, verified: verified.promise };
    const releases: Array<'deferred' | undefined> = [];
    let retry: (() => Promise<void>) | undefined;
    const result = toolBash({ command: 'node spawn.cjs exit', timeout: 30 }, {
      backups: new Map(), executionCwd: directory, runtimeRunId: 'natural-exit-drain',
      shellExecution,
      registerShellCleanup: (reference, exactRetry) => {
        expect(reference.runtimeRunId).toBe('natural-exit-drain');
        expect(Number.isSafeInteger(reference.pid)).toBe(true);
        expect(reference.pid).toBeGreaterThan(0);
        expect(reference.registrationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        retry = exactRetry;
        return outcome => { releases.push(outcome); };
      },
    });
    try {
      // The command, detached descendant and native Job are real. Only the
      // supervisor's final receipt is unavailable at the Shell lifecycle seam.
      await actualDrained.promise;
      const pids = JSON.parse(await readFile(join(directory, 'pids.json'), 'utf8')) as number[];
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      failure.resolve();
      await vi.runAllTimersAsync();
      expect(releases).toEqual(['deferred']);
      expect(await result).toContain('[Unknown] Shell cleanup could not be verified');
      expect(await registryFiles(join(directory, 'agent-home/runtime/processes/children'))).not.toEqual([]);
      expect(retry).toBeDefined();
      await retry!();
      await vi.runAllTimersAsync();
      expect(releases).not.toContain(undefined);

      verified.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      await retry!();
      expect(releases.at(-1)).toBeUndefined();
      expect(await registryFiles(join(directory, 'agent-home/runtime/processes/children'))).toEqual([]);
    } finally {
      failure.resolve(); verified.resolve();
      jobReceipt.held = undefined;
      vi.useRealTimers();
      await result;
    }
  });
});

async function registryFiles(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...await registryFiles(join(directory, entry.name)));
    else files.push(join(directory, entry.name));
  }
  return files;
}
