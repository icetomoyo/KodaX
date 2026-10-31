import { spawn, type ChildProcess } from 'node:child_process';
import { prepareJavaScriptChildLaunch } from './process-hardening.js';
import { killChildProcessTree, trackChildProcessTreeContainment, waitForChildProcessExit } from './process-tree.js';
import { containWindowsEffectProcess, terminateWindowsEffectJob } from './windows-effect-job.js';

// The gate cannot launch user code until its caller has installed both the Job
// and durable registration. The target receives its original environment and
// stdin; bootstrap data never becomes shell input.
const GATE_SOURCE = String.raw`
const { spawn } = require('node:child_process');
let header = Buffer.alloc(0);
process.stdin.on('data', function receive(chunk) {
  header = Buffer.concat([header, chunk]);
  const end = header.indexOf(10);
  if (end < 0) return;
  process.stdin.off('data', receive);
  process.stdin.pause();
  const input = JSON.parse(header.subarray(0, end).toString('utf8'));
  const child = spawn(input.executable, input.args, {
    cwd: input.cwd, env: input.env, windowsHide: true, shell: false,
    windowsVerbatimArguments: input.windowsVerbatimArguments,
    stdio: ['pipe', 'inherit', 'inherit', ...(input.controlPipe ? [3] : [])],
  });
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    }
  });
  child.once('spawn', () => process.send({ type: 'started' }));
  child.once('error', error => {
    process.send({ type: 'start-error', message: error.message }, () => {
      process.disconnect(); process.exit(1);
    });
  });
  child.once('exit', code => {
    process.stdin.destroy(); process.exitCode = code ?? 1; process.disconnect();
  });
  const remainder = header.subarray(end + 1);
  if (remainder.length) child.stdin.write(remainder);
  header = undefined;
  process.stdin.pipe(child.stdin);
});
process.stdin.once('end', () => { if (header !== undefined) process.exit(1); });
`;

/** The admitted gate proves the requested executable never started. */
export class WindowsManagedProcessStartError extends Error {}

export interface WindowsManagedProcessInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly windowsVerbatimArguments?: boolean;
  readonly controlPipe?: boolean;
  readonly signal?: AbortSignal;
  readonly deadlineAt: number;
}

/** Prepare a non-interactive command inside a Job before admitting its effects. */
export async function prepareWindowsManagedProcess(input: WindowsManagedProcessInput): Promise<{
  readonly child: ChildProcess;
  readonly drained: Promise<void>;
  /** Call only after durable registration; subsequent writes are target stdin. */
  start(): Promise<void>;
}> {
  if (process.platform !== 'win32') throw new Error('Windows managed processes require Windows.');
  input.signal?.throwIfAborted();
  const assertBudget = (): void => {
    if (Date.now() >= input.deadlineAt) {
      throw new DOMException('Windows process preparation timed out before target start.', 'TimeoutError');
    }
  };
  assertBudget();
  // Target-controlled runtime flags must not execute a preload in the gate
  // before it has entered its Job. The unmodified target env travels in stdin.
  const gateEnv = Object.fromEntries(Object.entries(input.env).filter(([name]) =>
    !['NODE_OPTIONS', 'BUN_OPTIONS'].includes(name.toUpperCase())));
  const launch = prepareJavaScriptChildLaunch({
    args: [...(process.versions.bun !== undefined ? ['--no-env-file', '--config=NUL'] : []), '-e', GATE_SOURCE],
    env: gateEnv, isElectron: process.versions.electron !== undefined,
  });
  const child = spawn(launch.command, [...launch.args], {
    cwd: input.cwd, env: launch.env, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe', input.controlPipe ? 'pipe' : 'ignore', 'ipc'],
  });
  let pipeFailure: Error | undefined;
  let rejectStart: ((error: Error) => void) | undefined;
  const onInputError = (error: Error): void => { pipeFailure = error; rejectStart?.(error); };
  child.stdin?.on('error', onInputError);
  child.stdin?.once('close', () => child.stdin?.off('error', onInputError));
  // Observe asynchronous spawn errors before waiting for Job readiness.
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  await spawned;
  if (child.pid === undefined) throw new Error('Windows process gate did not expose a PID.');
  const onAbort = (): void => { child.kill(); };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const startupTimer = setTimeout(onAbort, Math.max(0, input.deadlineAt - Date.now()));
  const job = await containWindowsEffectProcess(child.pid).catch(async (error: unknown) => {
    child.kill();
    if (!await waitForChildProcessExit(child, 5_000)) {
      throw new AggregateError([error], 'Windows process gate startup failed and cleanup is unconfirmed.');
    }
    input.signal?.throwIfAborted();
    assertBudget();
    throw error;
  }).finally(() => {
    clearTimeout(startupTimer);
    input.signal?.removeEventListener('abort', onAbort);
  });
  trackChildProcessTreeContainment(child, job.drained, async () => {
    await terminateWindowsEffectJob(job.jobName);
    await job.drained;
  });
  if (input.signal?.aborted || Date.now() >= input.deadlineAt) {
    await killChildProcessTree(child);
    input.signal?.throwIfAborted();
    assertBudget();
  }
  let started: Promise<void> | undefined;
  return { child, drained: job.drained, start: () => started ??= new Promise<void>((resolve, reject) => {
    input.signal?.throwIfAborted();
    assertBudget();
    if (pipeFailure !== undefined) { reject(pipeFailure); return; }
    if (child.stdin === null) { reject(new Error('Windows process gate has no stdin.')); return; }
    const settle = (error?: Error): void => {
      rejectStart = undefined;
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error); else resolve();
    };
    rejectStart = settle;
    const onMessage = (message: unknown): void => {
      if (typeof message !== 'object' || message === null) return;
      const result = message as { type?: unknown; message?: unknown };
      if (result.type === 'started') settle();
      else if (result.type === 'start-error' && typeof result.message === 'string') {
        settle(new WindowsManagedProcessStartError(result.message));
      }
    };
    const onExit = (): void => settle(new Error('Windows process gate exited without target-start evidence.'));
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.stdin.write(`${JSON.stringify(input)}\n`, error => { if (error) settle(error); });
  }) };
}
