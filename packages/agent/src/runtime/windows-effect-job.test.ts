import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '../diagnostics.js';
import { installWindowsProcessHelper } from './process-tree.js';
import {
  containWindowsEffectProcess,
  terminateWindowsEffectJob,
  windowsSandboxSidHasActiveProcesses,
} from './windows-effect-job.js';

const DETACHED_CHILD_GATE = String.raw`
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin, terminal: false });
input.once('line', () => {
  input.close();
  const script = "setTimeout(()=>require('node:fs').writeFileSync(process.env.KODAX_JOB_SENTINEL,'escaped'),1000)";
  spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', env: process.env }).unref();
  process.exit(0);
});
`;

const execFileAsync = promisify(execFile);
// Captured before native mode hides SystemRoot from the code under test.
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows';
const POWERSHELL = path.join(
  SYSTEM_ROOT,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const MISSING_WINDOWS_ROOT = path.join(os.tmpdir(), 'missing-windows-root');
const NATIVE_HELPER = path.resolve(
  import.meta.dirname,
  '../../../../dist/native',
  `win32-${process.arch}`,
  'kodax-windows-sandbox.exe',
);
const MISSING_NATIVE_HELPER = path.join(os.tmpdir(), 'missing-kodax-helper', 'kodax-windows-sandbox.exe');
const MISSING_GLOBAL_JOB = 'Global\\KodaXEffect-00000000-0000-4000-8000-000000000001';

/**
 * Test processes keep a real SystemRoot; Node and PowerShell cannot start
 * without one. Windows environments can carry the name in several casings.
 */
function withRealSystemRoot(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const entries = Object.entries(env).filter(([name]) => name.toLowerCase() !== 'systemroot');
  return { ...Object.fromEntries(entries), SystemRoot: SYSTEM_ROOT };
}

function spawnNode(args: readonly string[], options: SpawnOptions): ChildProcess {
  return spawn(process.execPath, args, { ...options, env: withRealSystemRoot(options.env) });
}

async function currentWindowsSid(): Promise<string> {
  const identity = await execFileAsync(
    POWERSHELL,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8', windowsHide: true, env: withRealSystemRoot() },
  );
  return identity.stdout.trim();
}

async function currentWindowsTokenIsElevatedAdministrator(): Promise<boolean> {
  const result = await execFileAsync(
    POWERSHELL,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ],
    { encoding: 'utf8', windowsHide: true, env: withRealSystemRoot() },
  );
  return result.stdout.trim().toLowerCase() === 'true';
}

// Native mode hides PowerShell, so every passing test there proves the
// helper handled the action without launching powershell.exe.
describe.runIf(process.platform === 'win32').each([
  { mode: 'powershell' as const },
  { mode: 'native' as const },
])('Windows effect Job ($mode)', ({ mode }) => {
  beforeAll(() => {
    if (mode === 'native' && !existsSync(NATIVE_HELPER)) {
      throw new Error(`Native helper ${NATIVE_HELPER} is missing. Run npm run build:native first.`);
    }
  });
  beforeEach(() => {
    if (mode === 'native') {
      installWindowsProcessHelper(() => NATIVE_HELPER);
      vi.stubEnv('SystemRoot', MISSING_WINDOWS_ROOT);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    installWindowsProcessHelper(undefined);
  });

  /** Neither the native helper nor PowerShell can start. */
  function hideEveryEffectJobProgram(): void {
    if (mode === 'native') installWindowsProcessHelper(() => MISSING_NATIVE_HELPER);
    vi.stubEnv('SystemRoot', MISSING_WINDOWS_ROOT);
  }

  it('rejects an asynchronous supervisor spawn failure without an unhandled error', async () => {
    hideEveryEffectJobProgram();

    await expect(containWindowsEffectProcess(process.pid))
      .rejects.toThrow('supervisor failed to start');
  });

  it('does not publish executable or readiness control files in shared temp', async () => {
    const observedControlFiles: string[] = [];
    const watcher = watch(os.tmpdir(), (_event, fileName) => {
      if (typeof fileName !== 'string') return;
      if (/^kodax-effect-job-.*\.(?:ps1|ready)$/i.test(fileName)) {
        observedControlFiles.push(fileName);
      }
    });
    const gate = spawnNode(['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(gate.pid).toBeTypeOf('number');
      const effectJob = await containWindowsEffectProcess(gate.pid!);
      expect(effectJob.jobName).toMatch(
        /^Global\\KodaXEffect-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      gate.kill();
      await effectJob.drained;
      expect(observedControlFiles).toEqual([]);
    } finally {
      watcher.close();
      gate.kill();
    }
  });

  it('reports supervisor readiness and any compile time as a diagnostic', async () => {
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    const gate = spawnNode(['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      const effectJob = await containWindowsEffectProcess(gate.pid!);
      gate.kill();
      await effectJob.drained;
    } finally {
      restore();
      gate.kill();
    }
    const ready = diagnostics.find((item) => item.message === 'Windows effect Job supervisor ready.');
    expect(ready).toMatchObject({ source: 'runtime:windows', level: 'debug' });
    const detail = ready?.detail as { readyMs: number; compileMs: number | undefined };
    if (mode === 'native') {
      expect(detail.compileMs).toBeUndefined();
    } else {
      expect(detail.compileMs).toBeGreaterThanOrEqual(0);
      expect(detail.readyMs).toBeGreaterThanOrEqual(detail.compileMs!);
    }
  });

  it('reports a supervisor startup failure with its timings as a warning', async () => {
    const exited = spawnNode(['-e', ''], { stdio: 'ignore', windowsHide: true });
    await new Promise<void>((resolve) => exited.once('exit', () => resolve()));
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    try {
      await expect(containWindowsEffectProcess(exited.pid!)).rejects.toThrow('OpenProcess');
    } finally {
      restore();
    }
    const failure = diagnostics.find((item) => item.message === 'Windows effect Job supervisor failed to start.');
    expect(failure).toMatchObject({ source: 'runtime:windows', level: 'warn' });
    expect(failure?.detail).toMatchObject({
      readyMs: expect.any(Number),
      ...(mode === 'native' ? {} : { compileMs: expect.any(Number) }),
      error: expect.stringContaining('OpenProcess'),
    });
  });

  it('keeps a delayed supervisor failure observable without an unhandled rejection', async () => {
    const gate = spawnNode(['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      expect(gate.pid).toBeTypeOf('number');
      const effectJob = await containWindowsEffectProcess(gate.pid!);
      process.kill(effectJob.supervisorPid);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await expect(effectJob.drained).rejects.toThrow('supervisor exited');
    } finally {
      gate.kill();
    }
  });

  it('detaches supervisor handles idempotently without weakening drain proof', async () => {
    const gate = spawnNode(['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      expect(gate.pid).toBeTypeOf('number');
      const effectJob = await containWindowsEffectProcess(gate.pid!);
      expect(() => {
        effectJob.unref?.();
        effectJob.unref?.();
      }).not.toThrow();
      gate.kill();
      await effectJob.drained;
    } finally {
      gate.kill();
    }
  });

  it('does not report drained until a detached descendant has been terminated', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-effect-job-'));
    const sentinel = path.join(directory, 'escaped.txt');
    const gate = spawnNode(['-e', DETACHED_CHILD_GATE], {
      env: { ...process.env, KODAX_JOB_SENTINEL: sentinel },
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    try {
      expect(gate.pid).toBeTypeOf('number');
      const effectJob = await containWindowsEffectProcess(gate.pid!);
      gate.stdin.end('go\n');
      await effectJob.drained;
      await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      gate.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lets a later runtime terminate and drain a named Job', async () => {
    const gate = spawnNode(['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      expect(gate.pid).toBeTypeOf('number');
      const effectJob = await containWindowsEffectProcess(gate.pid!);
      await expect(terminateWindowsEffectJob(effectJob.jobName)).resolves.toBe('drained');
      await effectJob.drained;
    } finally {
      gate.kill();
    }
  });

  it('keeps a missing named Job distinguishable from a drained Job', async () => {
    await expect(terminateWindowsEffectJob(MISSING_GLOBAL_JOB)).resolves.toBe('not_found');
  });

  it('accepts the exact legacy session-local name for interrupted-owner recovery', async () => {
    await expect(terminateWindowsEffectJob(
      'KodaXEffect-00000000-0000-4000-8000-000000000001',
    )).resolves.toBe('not_found');

    await expect(terminateWindowsEffectJob(
      'Local\\KodaXEffect-00000000-0000-4000-8000-000000000001',
    )).rejects.toThrow('invalid Job name');
  });

  it('does not block the event loop while recovering a named Job', async () => {
    const order: string[] = [];
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push('timer');
        resolve();
      }, 0);
    });

    const recovery = terminateWindowsEffectJob(MISSING_GLOBAL_JOB).then((result) => {
      order.push(result);
    });
    await Promise.all([timer, recovery]);

    expect(order[0]).toBe('timer');
  });

  it('detects a process machine-wide by its exact Windows account SID', async () => {
    const sid = await currentWindowsSid();
    const order: string[] = [];
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push('timer');
        resolve();
      }, 0);
    });
    const inspection = windowsSandboxSidHasActiveProcesses(sid).then((active) => {
      expect(active).toBe(true);
      order.push('inspection');
    });

    await Promise.all([timer, inspection]);
    expect(order[0]).toBe('timer');
  });

  it('never treats a foreign SID as clear without machine-wide inspection authority', async () => {
    // Ask for elevation first: the native probe can reject before a slower
    // PowerShell elevation check returns, leaving its rejection unobserved.
    const elevated = await currentWindowsTokenIsElevatedAdministrator();
    const inspection = windowsSandboxSidHasActiveProcesses(
      'S-1-5-21-111111111-222222222-333333333-4444',
    );
    if (elevated) {
      await expect(inspection).resolves.toBe(false);
    } else {
      await expect(inspection).rejects.toThrow(
        'foreign Windows SID requires an elevated administrator token',
      );
    }
  });

  it('bounds machine-wide SID inspection by the caller deadline', async () => {
    await expect(windowsSandboxSidHasActiveProcesses(await currentWindowsSid(), 1))
      .rejects.toThrow('timed out after 1 ms');
  });

  it('fails closed when machine-wide SID inspection cannot start', async () => {
    const sid = await currentWindowsSid();
    hideEveryEffectJobProgram();

    await expect(windowsSandboxSidHasActiveProcesses(sid))
      .rejects.toThrow('inspection failed to start');
  });

  it.runIf(mode === 'native')('falls back to PowerShell only when the native helper cannot launch', async () => {
    installWindowsProcessHelper(() => MISSING_NATIVE_HELPER);
    vi.unstubAllEnvs();
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    try {
      await expect(terminateWindowsEffectJob(MISSING_GLOBAL_JOB)).resolves.toBe('not_found');
    } finally {
      restore();
    }
    expect(diagnostics).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: 'Windows effect Job recovery could not use the native helper; using PowerShell.',
    }));
  });
});
