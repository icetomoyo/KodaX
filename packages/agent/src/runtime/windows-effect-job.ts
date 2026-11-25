import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { emitKodaXDiagnostic } from '../diagnostics.js';
import { killChildProcessTree, resolveWindowsProcessHelper } from './process-tree.js';

const PAYLOAD_ENV = 'KODAX_EFFECT_JOB_PAYLOAD';
const STARTUP_TIMEOUT_MS = 15_000;
const SUPERVISOR_OUTPUT_LIMIT = 8_192;
// New Jobs are machine-global. Accept the exact pre-global name as a recovery-
// only compatibility input so an interrupted older SDK can still converge.
const WINDOWS_EFFECT_JOB_NAME_PATTERN = /^(?:Global\\)?KodaXEffect-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WINDOWS_PROGRAM_HASHES = {
  "effectJob": "c9696ac7595a83d47d40f8e714f76ae6d1991836c39b163251a97a1b4097fe61",
  "sidProbe": "02307259d2398a467692c41e5673fccd141f7ad08d4862601e99f6fae63f05ce"
} as const;
const encodedPrograms = new Map<keyof typeof WINDOWS_PROGRAM_HASHES, string>();
function windowsProgram(key: keyof typeof WINDOWS_PROGRAM_HASHES): string {
  const cached = encodedPrograms.get(key);
  if (cached !== undefined) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = process.env.KODAX_BUNDLED === 'true'
    ? [path.join(path.dirname(process.execPath), 'windows-effect-job-programs.json')]
    : [path.join(here, 'windows-effect-job-programs.json'), path.join(here, '..', 'windows-effect-job-programs.json')];
  const programs: unknown = JSON.parse(fs.readFileSync(candidates.find(fs.existsSync) ?? candidates[0]!, 'utf8'));
  const text = typeof programs === 'object' && programs !== null
    ? (programs as Record<string, unknown>)[key] : undefined;
  if (typeof text !== 'string' || createHash('sha256').update(text, 'utf8').digest('hex') !== WINDOWS_PROGRAM_HASHES[key]) {
    throw new Error('Packaged Windows program is missing or does not match the audited program.');
  }
  const encoded = Buffer.from(text, 'utf16le').toString('base64');
  encodedPrograms.set(key, encoded);
  return encoded;
}

export interface WindowsEffectJob {
  /** Resolves only after the Job reports zero active processes. */
  readonly drained: Promise<void>;
  /** The process that owns the Job handle and proves the effect is still fenced. */
  readonly supervisorPid: number;
  /** Unique kernel Job name persisted by recovery tickets across host restarts. */
  readonly jobName: string;
  /** Stops the supervisor and its pipes from keeping the Node.js event loop alive. */
  unref?(): void;
}

export interface WindowsSandboxSidProbeLauncher {
  readonly executable: string;
  readonly prependArgs?: readonly string[];
  /** Native helper the sandbox user can read; without it the probe uses PowerShell. */
  readonly nativeHelper?: string;
}

interface WindowsEffectJobActionResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

function unrefIfSupported(resource: object | null): void {
  if (resource === null) return;
  const unref = Reflect.get(resource, 'unref');
  if (typeof unref === 'function') unref.call(resource);
}

function windowsPowerShellPath(): string {
  return path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

interface WindowsEffectJobCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

function powershellEffectJobCommand(
  payloadValue: Readonly<Record<string, unknown>>,
  launcher?: WindowsSandboxSidProbeLauncher,
): WindowsEffectJobCommand {
  const payload = Buffer.from(JSON.stringify(payloadValue), 'utf8').toString('base64');
  const powershell = windowsPowerShellPath();
  const encodedCommand = payloadValue.action === 'sid-active'
    ? windowsProgram('sidProbe')
    : windowsProgram('effectJob');
  const powershellArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  ];
  if (launcher === undefined) {
    return { executable: powershell, args: powershellArgs, env: { ...process.env, [PAYLOAD_ENV]: payload } };
  }
  return {
    executable: launcher.executable,
    args: [
      ...(launcher.prependArgs ?? []),
      'exec',
      '--quiet',
      '--env',
      `${PAYLOAD_ENV}=${payload}`,
      '--',
      powershell,
      ...powershellArgs,
    ],
    env: process.env,
  };
}

/**
 * The native helper replaces PowerShell compiling C# with Add-Type on every
 * call, which is slow and looks like code injection to security software.
 */
function nativeEffectJobCommand(
  helperArgs: readonly string[],
  launcher?: WindowsSandboxSidProbeLauncher,
): WindowsEffectJobCommand | undefined {
  if (launcher !== undefined) {
    if (launcher.nativeHelper === undefined) return undefined;
    return {
      executable: launcher.executable,
      args: [...(launcher.prependArgs ?? []), 'exec', '--quiet', '--', launcher.nativeHelper, ...helperArgs],
      env: process.env,
    };
  }
  const helper = resolveWindowsProcessHelper();
  return helper === undefined ? undefined : { executable: helper, args: helperArgs, env: process.env };
}

function spawnWindowsEffectJobCommand(command: WindowsEffectJobCommand): ChildProcess {
  return spawn(command.executable, [...command.args], {
    env: command.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function isProcessSpawnFailure(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const syscall = (current as NodeJS.ErrnoException).syscall;
    if (typeof syscall === 'string' && syscall.startsWith('spawn')) return true;
  }
  return false;
}

function reportNativeHelperFallback(subject: string, error: unknown): void {
  emitKodaXDiagnostic({
    source: 'runtime:windows',
    level: 'warn',
    message: `${subject} could not use the native helper; using PowerShell.`,
    detail: { error: error instanceof Error ? error.message : String(error) },
  });
}

class WindowsEffectJobActionObserver {
  private readonly stderrChunks: Buffer[] = [];
  private readonly stdoutChunks: Buffer[] = [];
  private outputBytes = 0;
  private settled = false;
  private stopFailure: Error | undefined;
  private stopping = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly timeoutMs: number,
    private readonly subject: string,
    private readonly resolve: (result: WindowsEffectJobActionResult) => void,
    private readonly reject: (error: Error) => void,
  ) {}

  start(): void {
    this.timer = setTimeout(() => {
      this.requestStop(new Error(
        `${this.subject} timed out after ${Math.max(1, this.timeoutMs)} ms.`,
      ));
    }, Math.max(1, this.timeoutMs));
    this.child.stdout?.on('data', this.onStdout);
    this.child.stderr?.on('data', this.onStderr);
    this.child.on('error', this.onError);
    this.child.on('close', this.onClose);
  }

  private stopObservingOutput(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.child.stdout?.off('data', this.onStdout);
    this.child.stderr?.off('data', this.onStderr);
    this.child.stdout?.resume();
    this.child.stderr?.resume();
  }

  private cleanup(): void {
    this.stopObservingOutput();
    this.child.off('error', this.onError);
    this.child.off('close', this.onClose);
  }

  private rejectFailure(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.stopObservingOutput();
    this.child.unref();
    unrefIfSupported(this.child.stdout);
    unrefIfSupported(this.child.stderr);
    this.reject(error);
  }

  private requestStop(error: Error): void {
    if (this.stopping || this.settled) return;
    this.stopping = true;
    this.stopFailure = error;
    this.stopObservingOutput();
    void killChildProcessTree(this.child).then(
      (result) => this.rejectStopFailure(error, result.status === 'unknown'),
      (killError: unknown) => this.rejectKillFailure(error, killError),
    );
  }

  private rejectStopFailure(error: Error, terminationUnknown: boolean): void {
    const failure = this.stopFailure ?? error;
    this.rejectFailure(terminationUnknown
      ? new AggregateError(
          [failure],
          `${failure.message} Helper process-tree termination was not confirmed.`,
        )
      : failure);
  }

  private rejectKillFailure(error: Error, killError: unknown): void {
    const failure = this.stopFailure ?? error;
    this.rejectFailure(new AggregateError(
      [failure, killError],
      `${failure.message} Its helper could not be terminated.`,
    ));
  }

  private append(chunks: Buffer[], chunk: Buffer | string): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.outputBytes += value.byteLength;
    if (this.outputBytes > SUPERVISOR_OUTPUT_LIMIT) {
      this.requestStop(new Error(
        `${this.subject} exceeded its ${SUPERVISOR_OUTPUT_LIMIT}-byte output limit.`,
      ));
      return;
    }
    chunks.push(value);
  }

  private readonly onStdout = (chunk: Buffer | string): void => {
    this.append(this.stdoutChunks, chunk);
  };

  private readonly onStderr = (chunk: Buffer | string): void => {
    this.append(this.stderrChunks, chunk);
  };

  private readonly onError = (error: Error): void => {
    const failure = new Error(`${this.subject} failed to start: ${error.message}`, { cause: error });
    if (this.stopping && this.stopFailure !== undefined) {
      this.stopFailure = new AggregateError(
        [this.stopFailure, failure],
        `${this.subject} failed while its helper was being terminated.`,
      );
      return;
    }
    this.rejectFailure(failure);
  };

  private readonly onClose = (
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.cleanup();
    if (this.settled) return;
    if (this.stopping && this.stopFailure !== undefined) {
      this.rejectFailure(this.stopFailure);
      return;
    }
    this.settled = true;
    this.resolve({
      exitCode,
      signal,
      stdout: Buffer.concat(this.stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(this.stderrChunks).toString('utf8'),
    });
  };
}

function runWindowsEffectJobCommand(
  command: WindowsEffectJobCommand,
  timeoutMs: number,
  subject: string,
): Promise<WindowsEffectJobActionResult> {
  let child: ChildProcess;
  try {
    child = spawnWindowsEffectJobCommand(command);
  } catch (error: unknown) {
    return Promise.reject(new Error(`${subject} failed to start: ${String(error)}`, { cause: error }));
  }
  return new Promise<WindowsEffectJobActionResult>((resolve, reject) => {
    new WindowsEffectJobActionObserver(child, timeoutMs, subject, resolve, reject).start();
  });
}

interface WindowsEffectJobAction<Answer extends string> {
  /** PowerShell program input. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Native helper arguments for the same action. */
  readonly helperArgs: readonly string[];
  readonly answers: readonly Answer[];
}

/** Run an action and return its last stdout line, which must be one of its answers. */
async function runWindowsEffectJobAction<Answer extends string>(
  action: WindowsEffectJobAction<Answer>,
  timeoutMs: number,
  subject: string,
  launcher?: WindowsSandboxSidProbeLauncher,
): Promise<Answer> {
  const native = nativeEffectJobCommand(action.helperArgs, launcher);
  if (native !== undefined) {
    try {
      return windowsEffectJobAnswer(await runWindowsEffectJobCommand(native, timeoutMs, subject), action.answers, subject);
    } catch (error: unknown) {
      // The host's own helper is hash-verified, so only a launch failure (for
      // example a quarantined image) justifies PowerShell; its other answers
      // are authoritative. The sandbox user may be unable to read its copy.
      if (launcher === undefined && !isProcessSpawnFailure(error)) throw error;
      reportNativeHelperFallback(subject, error);
    }
  }
  const command = powershellEffectJobCommand(action.payload, launcher);
  return windowsEffectJobAnswer(await runWindowsEffectJobCommand(command, timeoutMs, subject), action.answers, subject);
}

function windowsEffectJobAnswer<Answer extends string>(
  result: WindowsEffectJobActionResult,
  answers: readonly Answer[],
  subject: string,
): Answer {
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  const answer = answers.find((candidate) => candidate === output);
  if (result.exitCode !== 0 || answer === undefined) {
    throw new Error(
      `${subject} failed (exit ${String(result.exitCode)}`
      + `${result.signal === null ? '' : `, signal ${result.signal}`}): `
      + `${result.stdout.trim() || result.stderr.trim() || '(empty output)'}.`,
    );
  }
  return answer;
}

export async function containWindowsEffectProcess(
  processPid: number,
  ownerPid = process.pid,
): Promise<WindowsEffectJob> {
  if (process.platform !== 'win32') {
    throw new Error('Windows effect Job containment is available only on Windows.');
  }
  const jobName = `Global\\KodaXEffect-${randomUUID()}`;
  const native = nativeEffectJobCommand([
    '__effect-job-supervise',
    String(processPid),
    String(ownerPid),
    jobName,
  ]);
  if (native !== undefined) {
    try {
      return await startWindowsEffectJobSupervisor(native, jobName);
    } catch (error: unknown) {
      // Only a helper that could not launch at all falls back; a helper that
      // ran and refused the target has the authoritative answer.
      if (!isProcessSpawnFailure(error)) throw error;
      reportNativeHelperFallback('Windows effect Job supervisor', error);
    }
  }
  return await startWindowsEffectJobSupervisor(
    powershellEffectJobCommand({ targetPid: processPid, ownerPid, jobName }),
    jobName,
  );
}

async function startWindowsEffectJobSupervisor(
  command: WindowsEffectJobCommand,
  jobName: string,
): Promise<WindowsEffectJob> {
  const supervisor = spawnWindowsEffectJobCommand(command);
  const drained = new Promise<void>((resolve, reject) => {
    supervisor.once('error', reject);
    supervisor.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Windows effect Job supervisor exited with code ${String(code)}.`));
    });
  });
  // The supervisor can fail after READY but before its owner reaches the
  // eventual drain await. Observe that rejection immediately while preserving
  // the original promise for the caller's authoritative result.
  void drained.catch(() => undefined);
  if (supervisor.pid === undefined) {
    try {
      await drained;
    } catch (error: unknown) {
      throw new Error('Windows effect Job supervisor failed to start.', { cause: error });
    }
    throw new Error('Windows effect Job supervisor did not expose a process ID.');
  }
  try {
    await waitForEffectJobReady(supervisor);
  } catch (error) {
    supervisor.kill();
    await drained.catch(() => undefined);
    throw error;
  }
  supervisor.stdout?.resume();
  supervisor.stderr?.resume();
  let unreferenced = false;
  return {
    drained,
    supervisorPid: supervisor.pid,
    jobName,
    unref: () => {
      if (unreferenced) return;
      unreferenced = true;
      supervisor.unref();
      unrefIfSupported(supervisor.stdout);
      unrefIfSupported(supervisor.stderr);
    },
  };
}

export async function terminateWindowsEffectJob(
  jobName: string,
  timeoutMs = 15_000,
): Promise<'drained' | 'not_found'> {
  if (process.platform !== 'win32') {
    throw new Error('Windows effect Job recovery is available only on Windows.');
  }
  if (!WINDOWS_EFFECT_JOB_NAME_PATTERN.test(jobName)) {
    throw new Error('Windows effect Job recovery received an invalid Job name.');
  }
  const answer = await runWindowsEffectJobAction({
    payload: { action: 'recover', jobName },
    helperArgs: ['__effect-job-recover', jobName],
    answers: ['DRAINED', 'NOT_FOUND'],
  }, timeoutMs, 'Windows effect Job recovery');
  return answer === 'DRAINED' ? 'drained' : 'not_found';
}

function assertWindowsSidProbeInput(sid: string): void {
  if (process.platform !== 'win32') {
    throw new Error('Windows sandbox process inspection is available only on Windows.');
  }
  if (!/^S-1-(?:\d+-)+\d+$/i.test(sid)) {
    throw new Error('Windows sandbox process inspection received an invalid SID.');
  }
}

export async function windowsSandboxSidHasActiveProcesses(
  sid: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  assertWindowsSidProbeInput(sid);
  const answer = await runWindowsEffectJobAction({
    payload: { action: 'sid-active', sid },
    helperArgs: ['__sid-active', sid],
    answers: ['ACTIVE', 'CLEAR'],
  }, timeoutMs, 'Windows sandbox process inspection');
  return answer === 'ACTIVE';
}

export async function windowsSandboxSidHasOtherProcesses(
  sid: string,
  launcher: WindowsSandboxSidProbeLauncher,
  timeoutMs = 15_000,
): Promise<boolean> {
  assertWindowsSidProbeInput(sid);
  const answer = await runWindowsEffectJobAction({
    payload: { action: 'sid-active', sid, ignoreCurrentProcessTree: true },
    helperArgs: ['__sid-active', sid, '--ignore-current-tree'],
    answers: ['ACTIVE', 'CLEAR'],
  }, timeoutMs, 'Windows sandbox-user process inspection', launcher);
  return answer === 'ACTIVE';
}

/** PowerShell startup is mostly Add-Type compiling the supervisor; the native helper reports no compile time. */
function reportSupervisorStartup(readyMs: number, compileMs: number | undefined, error?: Error): void {
  emitKodaXDiagnostic({
    source: 'runtime:windows',
    level: error ? 'warn' : 'debug',
    message: error ? 'Windows effect Job supervisor failed to start.' : 'Windows effect Job supervisor ready.',
    detail: { readyMs, compileMs, timeoutMs: STARTUP_TIMEOUT_MS, ...(error ? { error: error.message } : {}) },
  });
}

function waitForEffectJobReady(supervisor: ChildProcess): Promise<void> {
  const stdout = supervisor.stdout;
  const stderr = supervisor.stderr;
  if (stdout === null) {
    return Promise.reject(new Error('Windows effect Job supervisor stdout is unavailable.'));
  }
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    let compileMs: number | undefined;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    const timer = setTimeout(() => {
      settle(new Error('Windows effect Job supervisor did not become ready in time.'));
    }, STARTUP_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      stdout.off('data', onStdout);
      stderr?.off('data', onStderr);
      supervisor.off('error', onError);
      supervisor.off('close', onExit);
    };
    const settle = (error?: Error): void => {
      cleanup();
      reportSupervisorStartup(Date.now() - startedAt, compileMs, error);
      if (error) reject(error);
      else resolve();
    };
    const onStdout = (chunk: Buffer | string): void => {
      stdoutBuffer = `${stdoutBuffer}${chunk.toString()}`.slice(-SUPERVISOR_OUTPUT_LIMIT);
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('COMPILED:')) compileMs = Number(line.slice('COMPILED:'.length));
        if (line === 'READY') {
          settle();
          return;
        }
        if (line.startsWith('ERROR:')) {
          settle(new Error(line.slice('ERROR:'.length)));
          return;
        }
      }
    };
    const onStderr = (chunk: Buffer | string): void => {
      stderrBuffer = `${stderrBuffer}${chunk.toString()}`.slice(-SUPERVISOR_OUTPUT_LIMIT);
    };
    const onError = (error: Error): void => settle(error);
    const onExit = (): void => settle(new Error(
      `Windows effect Job supervisor exited before readiness${
        stderrBuffer ? `: ${stderrBuffer.trim()}` : '.'
      }`,
    ));
    stdout.on('data', onStdout);
    stderr?.on('data', onStderr);
    supervisor.once('error', onError);
    supervisor.once('close', onExit);
  });
}
