import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildWindowsCommandLine,
  quoteWindowsCommandLineArg,
  spawnWindowsJobContainedProcess,
} from './windows-job-supervisor.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

describe('Windows Job daemon supervisor', () => {
  it.skipIf(process.platform !== 'win32')(
    'reclaims an opt-in wrapper and launch files when PowerShell cannot spawn',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-shell-spawn-error-'));
      temporaryDirectories.push(directory);
      const traceFile = path.join(directory, 'wrapper.json');
      const preloadFile = path.join(directory, 'trace.cjs');
      writeFileSync(preloadFile, [
        'const env = process.env;',
        'if (env.KODAX_INTERNAL_WINDOWS_JOB_SCRIPT_FILE) {',
        `require('node:fs').writeFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ pid: process.pid, script: env.KODAX_INTERNAL_WINDOWS_JOB_SCRIPT_FILE, ready: env.KODAX_INTERNAL_WINDOWS_JOB_READY_FILE, marker: env.KODAX_INTERNAL_WINDOWS_JOB_HANDOFF })); }`,
      ].join(' '));
      const environment = Object.fromEntries(Object.entries(process.env)
        .filter(([name]) => name.toUpperCase() !== 'PATH'));
      environment.PATH = directory;
      environment.NODE_OPTIONS = `--require ${JSON.stringify(preloadFile)}`;
      await expect(spawnWindowsJobContainedProcess({
        executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: directory,
        env: environment, logFile: path.join(directory, 'supervisor.log'), startupHandoff: true,
      })).rejects.toThrow('Windows Job supervisor');
      await waitForFile(traceFile);
      const trace = JSON.parse(readFileSync(traceFile, 'utf8')) as {
        pid: number; script: string; ready: string; marker: string;
      };
      try {
        await waitForPidExit(trace.pid);
        expect(existsSync(trace.script)).toBe(false);
        expect(existsSync(trace.ready)).toBe(false);
        expect(existsSync(trace.marker)).toBe(false);
      } finally {
        for (const file of [trace.script, trace.ready, trace.marker]) rmSync(file, { force: true });
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'removes private launch files when its launcher dies before PowerShell starts',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-early-launcher-death-'));
      temporaryDirectories.push(directory);
      const traceFile = path.join(directory, 'wrapper.json');
      const preloadFile = path.join(directory, 'pause.cjs');
      writeFileSync(preloadFile, [
        'const env = process.env;',
        'if (env.KODAX_INTERNAL_WINDOWS_JOB_SCRIPT_FILE) {',
        `require('node:fs').writeFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ pid: process.pid, script: env.KODAX_INTERNAL_WINDOWS_JOB_SCRIPT_FILE, ready: env.KODAX_INTERNAL_WINDOWS_JOB_READY_FILE, marker: env.KODAX_INTERNAL_WINDOWS_JOB_HANDOFF }));`,
        'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750); }',
      ].join(' '));
      const launcher = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', [
        `import { spawnWindowsJobContainedProcess } from ${JSON.stringify(new URL('./windows-job-supervisor.ts', import.meta.url).href)};`,
        `await spawnWindowsJobContainedProcess({ ...${JSON.stringify({
          executable: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 3000);'],
          cwd: process.cwd(), logFile: path.join(directory, 'supervisor.log'), startupHandoff: true,
        })}, env: process.env });`,
      ].join(' ')], {
        windowsHide: true, stdio: 'ignore',
        env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preloadFile)}` },
      });
      const launcherExit = once(launcher, 'exit');
      let trace: { pid: number; script: string; ready: string; marker: string } | undefined;
      try {
        await waitForFile(traceFile);
        trace = JSON.parse(readFileSync(traceFile, 'utf8')) as typeof trace;
        expect(existsSync(trace!.ready)).toBe(false);
        launcher.kill();
        await launcherExit;
        await waitForPidExit(trace!.pid);
        expect(existsSync(trace!.script)).toBe(false);
        expect(existsSync(trace!.ready)).toBe(false);
        expect(existsSync(trace!.marker)).toBe(false);
      } finally {
        if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
        await launcherExit;
        if (trace) {
          await waitForPidExit(trace.pid);
          for (const file of [trace.script, trace.ready, trace.marker]) rmSync(file, { force: true });
        }
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'does not inherit another launchers handoff marker',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-handoff-env-'));
      temporaryDirectories.push(directory);
      const observedFile = path.join(directory, 'observed');
      const inheritedMarker = path.join(directory, 'other-launcher');
      const contained = await spawnWindowsJobContainedProcess({
        executable: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(observedFile)}, process.env.KODAX_INTERNAL_WINDOWS_JOB_HANDOFF || 'absent'); setInterval(() => {}, 1000);`],
        cwd: process.cwd(),
        env: { ...process.env, KODAX_INTERNAL_WINDOWS_JOB_HANDOFF: inheritedMarker },
        logFile: path.join(directory, 'supervisor.log'),
      });
      try {
        await waitForFile(observedFile);
        expect(readFileSync(observedFile, 'utf8')).toBe('absent');
        expect(existsSync(inheritedMarker)).toBe(false);
      } finally {
        await contained.terminate();
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'reports a handoff filesystem failure without killing a possibly committed target',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-handoff-failure-'));
      temporaryDirectories.push(directory);
      const preloadFile = path.join(directory, 'fault.cjs');
      const stopFile = path.join(directory, 'stop');
      const logFile = path.join(directory, 'supervisor.log');
      writeFileSync(preloadFile, [
        'const fs = require("node:fs"); const original = fs.openSync;',
        'fs.openSync = function(file, flags, ...rest) {',
        'if (file === process.env.KODAX_INTERNAL_WINDOWS_JOB_HANDOFF && flags === "wx") {',
        'const error = new Error("injected handoff access denied"); error.code = "EACCES"; throw error; }',
        'return original.call(this, file, flags, ...rest); };',
      ].join(' '));
      const contained = await spawnWindowsJobContainedProcess({
        executable: process.execPath,
        args: ['-e', `setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(stopFile)})) process.exit(0); }, 10);`],
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preloadFile)}` },
        logFile,
        startupHandoff: true,
      });
      const exited = once(contained.supervisor, 'exit');
      try {
        await expect(contained.terminate()).rejects.toThrow('control failed');
        expect(isPidAlive(contained.processPid)).toBe(true);
        expect(readFileSync(logFile, 'utf8')).toContain('injected handoff access denied');
      } finally {
        writeFileSync(stopFile, 'stop');
        await exited;
        await waitForPidExit(contained.processPid);
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32').each([0, 1, 2, 3, 4])(
    'settles concurrent commit and disconnect without revoking publication (round %s)',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-handoff-race-'));
      temporaryDirectories.push(directory);
      const gateFile = path.join(directory, 'gate');
      const admittedFile = path.join(directory, 'admitted');
      const readyFile = path.join(directory, 'target-ready');
      const stopFile = path.join(directory, 'stop');
      const contained = await spawnWindowsJobContainedProcess({
        executable: process.execPath,
        args: ['-e', [
          'const fs = require("node:fs"); const marker = process.env.KODAX_INTERNAL_WINDOWS_JOB_HANDOFF;',
          'setTimeout(() => process.exit(2), 15000).unref();',
          `fs.writeFileSync(${JSON.stringify(readyFile)}, marker);`,
          'let admitted = false;',
          `setInterval(() => { if (fs.existsSync(${JSON.stringify(stopFile)})) process.exit(0);`,
          `if (admitted || !fs.existsSync(${JSON.stringify(gateFile)})) return;`,
          'try { fs.closeSync(fs.openSync(marker, "wx")); } catch (error) { if (error.code === "EEXIST") process.exit(0); throw error; }',
          `admitted = true; fs.writeFileSync(${JSON.stringify(admittedFile)}, 'admitted'); }, 1);`,
        ].join(' ')],
        cwd: process.cwd(), env: process.env, logFile: path.join(directory, 'supervisor.log'),
        startupHandoff: true,
      });
      const exited = once(contained.supervisor, 'exit');
      try {
        await waitForFile(readyFile);
        const marker = readFileSync(readyFile, 'utf8');
        writeFileSync(gateFile, 'go');
        contained.supervisor.disconnect();
        const deadline = Date.now() + 5_000;
        while (!existsSync(admittedFile) && contained.supervisor.exitCode === null
          && contained.supervisor.signalCode === null) {
          if (Date.now() >= deadline) throw new Error('Startup arbitration did not settle.');
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        await waitForFileRemoval(marker);
        if (existsSync(admittedFile)) {
          expect(isPidAlive(contained.processPid)).toBe(true);
          expect(isPidAlive(contained.containmentSupervisorPid)).toBe(true);
        } else {
          await exited;
          expect(existsSync(admittedFile)).toBe(false);
          expect(isPidAlive(contained.processPid)).toBe(false);
        }
      } finally {
        writeFileSync(stopFile, 'stop');
        await exited;
        await waitForPidExit(contained.processPid);
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32').each([false, true])(
    'arbitrates real launcher death when target committed is %s',
    async (committed) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-launcher-death-'));
      temporaryDirectories.push(directory);
      const identitiesFile = path.join(directory, 'identities.json');
      const targetFile = path.join(directory, 'target.json');
      const stopFile = path.join(directory, 'stop');
      const targetSource = [
        'const fs = require("node:fs");',
        'const marker = process.env.KODAX_INTERNAL_WINDOWS_JOB_HANDOFF;',
        committed ? 'fs.closeSync(fs.openSync(marker, "wx"));' : '',
        `fs.writeFileSync(${JSON.stringify(targetFile)}, JSON.stringify({ marker }));`,
        `setInterval(() => { if (fs.existsSync(${JSON.stringify(stopFile)})) process.exit(0); }, 10);`,
      ].join(' ');
      const launcher = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', [
        `import { spawnWindowsJobContainedProcess } from ${JSON.stringify(new URL('./windows-job-supervisor.ts', import.meta.url).href)};`,
        'import { writeFileSync } from "node:fs";',
        `const child = await spawnWindowsJobContainedProcess(${JSON.stringify({
          executable: process.execPath, args: ['-e', targetSource], cwd: process.cwd(),
          logFile: path.join(directory, 'supervisor.log'), startupHandoff: true,
        }).replace(/}$/, ', env: process.env }')});`,
        `writeFileSync(${JSON.stringify(identitiesFile)}, JSON.stringify({ target: child.processPid, owner: child.containmentSupervisorPid, wrapper: child.supervisor.pid }));`,
      ].join(' ')], { windowsHide: true, stdio: 'ignore' });
      const launcherExit = once(launcher, 'exit');
      let identities: { target: number; owner: number; wrapper: number } | undefined;
      try {
        await waitForFile(identitiesFile);
        identities = JSON.parse(readFileSync(identitiesFile, 'utf8')) as typeof identities;
        await waitForFile(targetFile);
        const { marker } = JSON.parse(readFileSync(targetFile, 'utf8')) as { marker: string };
        launcher.kill();
        await launcherExit;
        if (committed) {
          await waitForFileRemoval(marker);
          expect(isPidAlive(identities!.target)).toBe(true);
          expect(isPidAlive(identities!.owner)).toBe(true);
          expect(isPidAlive(identities!.wrapper)).toBe(true);
        } else {
          await waitForPidExit(identities!.wrapper);
          expect(isPidAlive(identities!.target)).toBe(false);
          expect(isPidAlive(identities!.owner)).toBe(false);
          expect(existsSync(marker)).toBe(false);
        }
      } finally {
        writeFileSync(stopFile, 'stop');
        if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
        await launcherExit;
        if (identities) {
          await waitForPidExit(identities.target);
          await waitForPidExit(identities.owner);
          await waitForPidExit(identities.wrapper);
        }
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'retains a committed startup when its launcher requests termination',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-committed-'));
      temporaryDirectories.push(directory);
      const stopFile = path.join(directory, 'stop');
      const committedFile = path.join(directory, 'committed');
      const contained = await spawnWindowsJobContainedProcess({
        executable: process.execPath,
        args: ['-e', [
          'const fs = require("node:fs");',
          'const decision = process.env.KODAX_INTERNAL_WINDOWS_JOB_HANDOFF;',
          'if (decision) fs.closeSync(fs.openSync(decision, "wx"));',
          'fs.writeFileSync(process.env.KODAX_TEST_COMMITTED_FILE, decision || "missing");',
          'setInterval(() => { if (fs.existsSync(process.env.KODAX_TEST_STOP_FILE)) process.exit(0); }, 10);',
        ].join(' ')],
        cwd: process.cwd(),
        env: { ...process.env, KODAX_TEST_STOP_FILE: stopFile, KODAX_TEST_COMMITTED_FILE: committedFile },
        logFile: path.join(directory, 'supervisor.log'),
        startupHandoff: true,
      });
      const exited = once(contained.supervisor, 'exit');
      try {
        await waitForFile(committedFile);
        await expect(contained.terminate()).resolves.toBe('retained');
        expect(isPidAlive(contained.processPid)).toBe(true);
        expect(existsSync(readFileSync(committedFile, 'utf8'))).toBe(false);
        await expect(contained.terminate()).resolves.toBe('retained');
        contained.release();
        await expect(contained.terminate()).resolves.toBe('retained');
      } finally {
        writeFileSync(stopFile, 'stop');
        await exited;
        await waitForPidExit(contained.processPid);
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'does not report a released but live supervisor as reclaimed',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-live-release-'));
      temporaryDirectories.push(directory);
      const stopFile = path.join(directory, 'stop');
      const contained = await spawnWindowsJobContainedProcess({
        executable: process.execPath,
        args: ['-e', 'setInterval(() => { if (require("node:fs").existsSync(process.env.KODAX_TEST_STOP_FILE)) process.exit(0); }, 10);'],
        cwd: process.cwd(), env: { ...process.env, KODAX_TEST_STOP_FILE: stopFile },
        logFile: path.join(directory, 'supervisor.log'),
      });
      const exited = once(contained.supervisor, 'exit');
      try {
        contained.release();
        await expect(contained.terminate()).rejects.toThrow('did not exit');
        expect(contained.supervisor.exitCode).toBeNull();
        expect(isPidAlive(contained.processPid)).toBe(true);
      } finally {
        writeFileSync(stopFile, 'stop');
        await exited;
        await waitForPidExit(contained.processPid);
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32').each([
    { phase: 'disconnect-event', startupHandoff: false },
    { phase: 'before-event-delivery', startupHandoff: false },
    { phase: 'disconnect-event', startupHandoff: true },
    { phase: 'before-event-delivery', startupHandoff: true },
  ])(
    'accepts natural supervisor exit during cleanup at $phase (handoff $startupHandoff)',
    async ({ phase, startupHandoff }) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-natural-exit-'));
      temporaryDirectories.push(directory);
      const stopFile = path.join(directory, 'stop');
      const contained = await spawnWindowsJobContainedProcess({
        executable: process.execPath,
        args: ['-e', 'setInterval(() => { if (require("node:fs").existsSync(process.env.KODAX_TEST_STOP_FILE)) process.exit(0); }, 10);'],
        cwd: process.cwd(),
        env: { ...process.env, KODAX_TEST_STOP_FILE: stopFile },
        logFile: path.join(directory, 'supervisor.log'),
        startupHandoff,
      });
      const exited = once(contained.supervisor, 'exit');
      let cleanup: Promise<void | 'retained'>;
      if (phase === 'disconnect-event') {
        cleanup = new Promise<void>((resolve, reject) => {
          contained.supervisor.once('disconnect', () => {
            try {
              expect(contained.supervisor.exitCode).toBeNull();
              contained.terminate().then(() => resolve(), reject);
            } catch (error: unknown) {
              reject(error);
            }
          });
        });
        writeFileSync(stopFile, 'stop');
      } else {
        writeFileSync(stopFile, 'stop');
        // Keep this event loop paused until the exact wrapper exits in the OS,
        // so IPC still looks connected while its asynchronous write fails.
        const waiter = spawnSync(process.execPath, ['-e',
          'const deadline = Date.now() + 5000; while (true) { try { process.kill(Number(process.argv[1]), 0); } catch (error) { if (error.code === "ESRCH") break; throw error; } if (Date.now() >= deadline) process.exit(1); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }',
          String(contained.supervisor.pid),
        ], { windowsHide: true, timeout: 10_000 });
        expect(waiter.status).toBe(0);
        expect(contained.supervisor.connected).toBe(true);
        expect(contained.supervisor.exitCode).toBeNull();
        cleanup = contained.terminate();
      }
      try {
        await expect(cleanup).resolves.toBeUndefined();
        expect(contained.supervisor.exitCode).toBe(0);
        await waitForPidExit(contained.containmentSupervisorPid);
        await waitForPidExit(contained.processPid);
      } finally {
        await exited;
      }
    },
    30_000,
  );

  it('quotes Windows command-line arguments with spaces, quotes, and trailing slashes', () => {
    expect(quoteWindowsCommandLineArg('plain')).toBe('plain');
    expect(quoteWindowsCommandLineArg('two words')).toBe('"two words"');
    expect(quoteWindowsCommandLineArg('say"hello')).toBe('"say\\"hello"');
    expect(quoteWindowsCommandLineArg('C:\\Program Files\\')).toBe('"C:\\Program Files\\\\"');
    expect(buildWindowsCommandLine('node.exe', ['-e', 'hello world']))
      .toBe('node.exe -e "hello world"');
  });

  it.skipIf(process.platform !== 'win32')(
    'accepts the ready file before the matching owner IPC identity arrives',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-owner-order-'));
      temporaryDirectories.push(directory);
      const logFile = path.join(directory, 'supervisor.log');
      const contained = await spawnWindowsJobContainedProcess({
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
        env: {
          ...process.env,
          KODAX_INTERNAL_WINDOWS_JOB_TEST_OWNER_AFTER_READY: '1',
        },
        logFile,
      });

      await contained.terminate();
      await waitForPidExit(contained.containmentSupervisorPid);
      await waitForPidExit(contained.processPid);
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'contains descendants before the target can run and exits only after the Job is empty',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-job-supervisor-'));
      temporaryDirectories.push(directory);
      const descendantPidFile = path.join(directory, 'descendant.pid');
      const logFile = path.join(directory, 'supervisor.log');
      let contained;
      try {
        contained = await spawnWindowsJobContainedProcess({
            executable: process.execPath,
            args: [
              '-e',
              [
                "const { spawn } = require('node:child_process');",
                "const { writeFileSync } = require('node:fs');",
                "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
                "writeFileSync(process.env.KODAX_TEST_DESCENDANT_PID, String(child.pid));",
                'setInterval(() => {}, 1000);',
              ].join(' '),
            ],
            cwd: process.cwd(),
            env: { ...process.env, KODAX_TEST_DESCENDANT_PID: descendantPidFile },
          logFile,
        });
      } catch (error: unknown) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${
            existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
          }`,
        );
      }

      await waitForFile(descendantPidFile);
      const wrapperExit = once(contained.supervisor, 'exit');
      await contained.terminate();
      await wrapperExit;
      expect(contained.supervisor.pid).not.toBe(contained.containmentSupervisorPid);
      const descendantPid = Number(readFileSync(descendantPidFile, 'utf8'));
      expect(contained.processPid).toBeGreaterThan(0);
      expect(contained.containmentSupervisorPid).toBeGreaterThan(0);
      expect(descendantPid).toBeGreaterThan(0);
      await waitForPidExit(contained.containmentSupervisorPid);
      await waitForPidExit(contained.processPid);
      await waitForPidExit(descendantPid);
      expect(isPidAlive(contained.processPid)).toBe(false);
      expect(isPidAlive(descendantPid)).toBe(false);
    },
    30_000,
  );
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`PID ${pid} did not exit in time.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`File ${file} did not appear in time.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForFileRemoval(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`File ${file} was not removed in time.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
