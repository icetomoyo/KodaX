import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveWindowsSandboxV2Executable } from '../windows-sandbox-v2.js';
import { buildWindowsCommandLine } from './windows-job-supervisor.js';

const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  // Async removal: a just-killed daemon releases its working directory only once the loop reaps it.
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

interface Launch {
  readonly child: ChildProcess;
  readonly readyFile: string;
  readonly logFile: string;
  readonly jobName: string;
  readonly exit: Promise<number | null>;
}

function launch(input: {
  readonly script?: string;
  readonly executable?: string;
  readonly jobName?: string;
  readonly directory?: string;
} = {}): Launch {
  const directory = input.directory ?? mkdtempSync(path.join(os.tmpdir(), 'kodax-native-job-'));
  if (input.directory === undefined) directories.push(directory);
  const readyFile = path.join(directory, `${randomUUID()}.ready`);
  const logFile = path.join(directory, 'daemon.log');
  const jobName = input.jobName ?? `Global\\KodaXDaemonJob-${randomUUID()}`;
  const executable = input.executable ?? process.execPath;
  const payload = Buffer.from(JSON.stringify({
    executable,
    commandLine: buildWindowsCommandLine(executable, ['-e', input.script ?? '']),
    cwd: directory,
    readyFile,
    logFile,
    jobName,
  })).toString('base64');
  const child = spawn(resolveWindowsSandboxV2Executable().path, ['__daemon-job-supervise'], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      KODAX_INTERNAL_WINDOWS_JOB_LAUNCH: payload,
      KODAX_INTERNAL_WINDOWS_JOB_READY_FILE: readyFile,
    },
  });
  children.push(child);
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, readyFile, logFile, jobName, exit };
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const readReady = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, 'utf8') : undefined;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform !== 'win32')('native Windows Job supervisor', () => {
  it('runs the daemon contained, passes its identity through the environment and propagates the exit code', async () => {
    const run = launch({
      script: [
        "const keys = ['KODAX_DAEMON_JOB_CONTAINED','KODAX_DAEMON_JOB_SUPERVISOR_PID','KODAX_DAEMON_JOB_NAME',",
        "'KODAX_INTERNAL_WINDOWS_JOB_LAUNCH','KODAX_INTERNAL_WINDOWS_JOB_READY_FILE'];",
        "console.log(JSON.stringify({ pid: process.pid, env: Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null])) }));",
        'console.error(\'stderr-line\');',
        'process.exit(7);',
      ].join(' '),
    });

    expect(await run.exit).toBe(7);
    const ready = JSON.parse(readFileSync(run.readyFile, 'utf8')) as {
      processPid: number;
      containmentSupervisorPid: number;
    };
    expect(ready.containmentSupervisorPid).toBe(run.child.pid);
    const log = readFileSync(run.logFile, 'utf8');
    expect(log).toContain('stderr-line');
    const reported = JSON.parse(log.split(/\r?\n/u).find((line) => line.startsWith('{'))!) as {
      pid: number;
      env: Record<string, string | null>;
    };
    expect(reported.pid).toBe(ready.processPid);
    expect(reported.env).toEqual({
      KODAX_DAEMON_JOB_CONTAINED: '1',
      KODAX_DAEMON_JOB_SUPERVISOR_PID: String(run.child.pid),
      KODAX_DAEMON_JOB_NAME: run.jobName,
      // The launch payload and ready file path must not leak into the daemon.
      KODAX_INTERNAL_WINDOWS_JOB_LAUNCH: null,
      KODAX_INTERNAL_WINDOWS_JOB_READY_FILE: null,
    });
  });

  it('kills the daemon when the supervisor dies and refuses a Job name that already exists', async () => {
    const first = launch({ script: 'setInterval(() => {}, 1000);' });
    const ready = await waitFor(() => readReady(first.readyFile), 'the first supervisor');
    const { processPid } = JSON.parse(ready) as { processPid: number };
    expect(isAlive(processPid)).toBe(true);

    const second = launch({ jobName: first.jobName, script: 'process.exit(0);' });
    expect(await second.exit).not.toBe(0);
    expect(readFileSync(second.readyFile, 'utf8')).toMatch(/^ERROR:.*already exists/u);
    expect(isAlive(processPid)).toBe(true);

    first.child.kill();
    await first.exit;
    await waitFor(() => (isAlive(processPid) ? undefined : true), 'the daemon to be killed with its Job');
  });

  it('reports a startup failure in the ready file instead of publishing readiness', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-native-job-'));
    directories.push(directory);
    const missing = launch({ directory, executable: path.join(directory, 'missing-daemon.exe') });
    expect(await missing.exit).not.toBe(0);
    expect(readFileSync(missing.readyFile, 'utf8')).toMatch(/^ERROR:.*CreateProcessW/u);

    const foreign = launch({ directory, jobName: 'Global\\NotKodaXDaemonJob' });
    expect(await foreign.exit).not.toBe(0);
    expect(readFileSync(foreign.readyFile, 'utf8')).toMatch(/^ERROR:.*Invalid daemon Job name/u);
  });
});
