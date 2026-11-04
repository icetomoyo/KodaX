import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { emitKodaXDiagnostic } from '../diagnostics.js';
import { killChildProcessTree } from './process-tree.js';

const PAYLOAD_ENV = 'KODAX_EFFECT_JOB_PAYLOAD';
const STARTUP_TIMEOUT_MS = 15_000;
const SUPERVISOR_OUTPUT_LIMIT = 8_192;
// New Jobs are machine-global. Accept the exact pre-global name as a recovery-
// only compatibility input so an interrupted older SDK can still converge.
const WINDOWS_EFFECT_JOB_NAME_PATTERN = /^(?:Global\\)?KodaXEffect-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WINDOWS_EFFECT_JOB_SOURCE = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class KodaXEffectJob {
  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimitInformation {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimitInformation {
    public BasicLimitInformation BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct BasicAccountingInformation {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr OpenJobObjectW(uint desiredAccess, bool inheritHandle, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(
    IntPtr job,
    int infoClass,
    ref ExtendedLimitInformation info,
    uint length);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool QueryInformationJobObject(
    IntPtr job,
    int infoClass,
    out BasicAccountingInformation info,
    uint length,
    IntPtr returnLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private const uint Synchronize = 0x00100000;
  private const uint ProcessTerminate = 0x0001;
  private const uint ProcessSetQuota = 0x0100;
  private const uint ProcessQueryLimitedInformation = 0x1000;
  private const uint JobObjectTerminate = 0x0008;
  private const uint JobObjectQuery = 0x0004;
  private const uint JobObjectLimitKillOnJobClose = 0x00002000;
  private const uint WaitObject0 = 0;

  private static void Require(bool result, string operation) {
    if (!result) throw new InvalidOperationException(
      operation + " failed with Win32 error " + Marshal.GetLastWin32Error());
  }

  private static void PublishReady() {
    Console.Out.WriteLine("READY");
    Console.Out.Flush();
  }

  public static void Run(uint targetPid, uint ownerPid, string jobName) {
    var job = CreateJobObjectW(IntPtr.Zero, jobName);
    if (job == IntPtr.Zero) throw new InvalidOperationException(
      "CreateJobObject failed with Win32 error " + Marshal.GetLastWin32Error());
    var processAccess = Synchronize | ProcessTerminate | ProcessSetQuota | ProcessQueryLimitedInformation;
    var target = OpenProcess(processAccess, false, targetPid);
    var owner = OpenProcess(Synchronize, false, ownerPid);
    if (target == IntPtr.Zero || owner == IntPtr.Zero) {
      if (target != IntPtr.Zero) CloseHandle(target);
      if (owner != IntPtr.Zero) CloseHandle(owner);
      CloseHandle(job);
      throw new InvalidOperationException(
        "OpenProcess failed with Win32 error " + Marshal.GetLastWin32Error());
    }
    try {
      var limits = new ExtendedLimitInformation();
      limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
      Require(SetInformationJobObject(
        job,
        9,
        ref limits,
        (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))),
        "SetInformationJobObject");
      Require(AssignProcessToJobObject(job, target), "AssignProcessToJobObject");
      PublishReady();

      uint targetExitCode = 1;
      while (true) {
        if (WaitForSingleObject(owner, 0) == WaitObject0) break;
        if (WaitForSingleObject(target, 0) == WaitObject0) {
          GetExitCodeProcess(target, out targetExitCode);
          break;
        }
        Thread.Sleep(20);
      }

      Require(TerminateJobObject(job, targetExitCode), "TerminateJobObject");
      while (true) {
        BasicAccountingInformation accounting;
        Require(QueryInformationJobObject(
          job,
          1,
          out accounting,
          (uint)Marshal.SizeOf(typeof(BasicAccountingInformation)),
          IntPtr.Zero),
          "QueryInformationJobObject");
        if (accounting.ActiveProcesses == 0) return;
        Thread.Sleep(10);
      }
    } finally {
      CloseHandle(owner);
      CloseHandle(target);
      CloseHandle(job);
    }
  }

  public static bool TerminateAndDrain(string jobName) {
    var job = OpenJobObjectW(JobObjectTerminate | JobObjectQuery, false, jobName);
    if (job == IntPtr.Zero) {
      var error = Marshal.GetLastWin32Error();
      if (error == 2) return false;
      throw new InvalidOperationException(
        "OpenJobObject failed with Win32 error " + error);
    }
    try {
      Require(TerminateJobObject(job, 1), "TerminateJobObject");
      while (true) {
        BasicAccountingInformation accounting;
        Require(QueryInformationJobObject(
          job,
          1,
          out accounting,
          (uint)Marshal.SizeOf(typeof(BasicAccountingInformation)),
          IntPtr.Zero),
          "QueryInformationJobObject");
        if (accounting.ActiveProcesses == 0) return true;
        Thread.Sleep(10);
      }
    } finally {
      CloseHandle(job);
    }
  }

}`;

const WINDOWS_SID_PROBE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class KodaXSidProbe {
  [StructLayout(LayoutKind.Sequential)]
  private struct WtsProcessInformation {
    public uint SessionId;
    public uint ProcessId;
    public IntPtr ProcessName;
    public IntPtr UserSid;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct ProcessEntry32 {
    public uint Size;
    public uint Usage;
    public uint ProcessId;
    public UIntPtr DefaultHeapId;
    public uint ModuleId;
    public uint Threads;
    public uint ParentProcessId;
    public int PriorityClassBase;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string ExecutableFile;
  }

  [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool WTSEnumerateProcessesW(
    IntPtr server,
    uint reserved,
    uint version,
    out IntPtr processInformation,
    out uint count);

  [DllImport("wtsapi32.dll")]
  private static extern void WTSFreeMemory(IntPtr memory);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry32 entry);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry32 entry);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private static Dictionary<uint, uint> ProcessParents() {
    var parents = new Dictionary<uint, uint>();
    var snapshot = CreateToolhelp32Snapshot(0x00000002, 0);
    if (snapshot == new IntPtr(-1)) throw new InvalidOperationException(
      "CreateToolhelp32Snapshot failed with Win32 error " + Marshal.GetLastWin32Error());
    try {
      var entry = new ProcessEntry32();
      entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
      if (!Process32FirstW(snapshot, ref entry)) throw new InvalidOperationException(
        "Process32First failed with Win32 error " + Marshal.GetLastWin32Error());
      do {
        parents[entry.ProcessId] = entry.ParentProcessId;
        entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
      } while (Process32NextW(snapshot, ref entry));
    } finally {
      CloseHandle(snapshot);
    }
    return parents;
  }

  private static HashSet<uint> MatchingProcesses(SecurityIdentifier expected) {
    var matches = new HashSet<uint>();
    IntPtr processes;
    uint count;
    if (!WTSEnumerateProcessesW(IntPtr.Zero, 0, 1, out processes, out count)) {
      throw new InvalidOperationException(
        "WTSEnumerateProcesses failed with Win32 error " + Marshal.GetLastWin32Error());
    }
    try {
      var entrySize = Marshal.SizeOf(typeof(WtsProcessInformation));
      for (uint index = 0; index < count; index++) {
        var address = new IntPtr(processes.ToInt64() + ((long)index * entrySize));
        var entry = (WtsProcessInformation)Marshal.PtrToStructure(
          address,
          typeof(WtsProcessInformation));
        if (entry.UserSid == IntPtr.Zero) continue;
        if (new SecurityIdentifier(entry.UserSid).Equals(expected)) matches.Add(entry.ProcessId);
      }
    } finally {
      WTSFreeMemory(processes);
    }
    return matches;
  }

  private static bool DescendsFrom(
    uint process,
    uint root,
    Dictionary<uint, uint> parents
  ) {
    var visited = new HashSet<uint>();
    while (process != 0 && visited.Add(process)) {
      if (process == root) return true;
      if (!parents.ContainsKey(process)) return false;
      process = parents[process];
    }
    return false;
  }

  public static bool HasOtherProcessWithSid(string expectedSid, bool ignoreProbeTree) {
    var expected = new SecurityIdentifier(expectedSid);
    using (var identity = WindowsIdentity.GetCurrent()) {
      var sameUser = identity.User != null && identity.User.Equals(expected);
      var administrator = new WindowsPrincipal(identity)
        .IsInRole(WindowsBuiltInRole.Administrator);
      if (ignoreProbeTree && !sameUser) {
        throw new InvalidOperationException("Process-tree SID probe must run as the expected sandbox user");
      }
      if (!ignoreProbeTree && !sameUser && !administrator) {
        throw new InvalidOperationException(
          "Machine-wide inspection of a foreign Windows SID requires an elevated administrator token");
      }
    }
    var matches = MatchingProcesses(expected);
    if (!ignoreProbeTree) return matches.Count > 0;
    var current = (uint)Process.GetCurrentProcess().Id;
    if (!matches.Contains(current)) throw new InvalidOperationException(
      "SID probe could not observe its own process");
    var parents = ProcessParents();
    var root = parents.ContainsKey(current) ? parents[current] : current;
    foreach (var process in matches) {
      if (!DescendsFrom(process, root, parents)) return true;
    }
    return false;
  }
}`;

const WINDOWS_EFFECT_JOB_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $payload = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($env:${PAYLOAD_ENV})) | ConvertFrom-Json
  Remove-Item Env:${PAYLOAD_ENV} -ErrorAction SilentlyContinue
  $source = @'
${WINDOWS_EFFECT_JOB_SOURCE}
'@
  $compile = [Diagnostics.Stopwatch]::StartNew()
  Add-Type -TypeDefinition $source
  [Console]::Out.WriteLine('COMPILED:' + $compile.ElapsedMilliseconds)
  [Console]::Out.Flush()
  if ($payload.action -eq 'recover') {
    $drained = [KodaXEffectJob]::TerminateAndDrain([string]$payload.jobName)
    [Console]::Out.WriteLine($(if ($drained) { 'DRAINED' } else { 'NOT_FOUND' }))
    [Console]::Out.Flush()
  } else {
    [KodaXEffectJob]::Run(
      [uint32]$payload.targetPid,
      [uint32]$payload.ownerPid,
      [string]$payload.jobName)
  }
  exit 0
} catch {
  [Console]::Out.WriteLine('ERROR:' + $_.Exception.Message)
  [Console]::Out.Flush()
  exit 1
}`;

const WINDOWS_EFFECT_JOB_ENCODED_COMMAND = Buffer.from(
  WINDOWS_EFFECT_JOB_SCRIPT,
  'utf16le',
).toString('base64');

const WINDOWS_SID_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $payload = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($env:${PAYLOAD_ENV})) | ConvertFrom-Json
  Remove-Item Env:${PAYLOAD_ENV} -ErrorAction SilentlyContinue
  $source = @'
${WINDOWS_SID_PROBE_SOURCE}
'@
  Add-Type -TypeDefinition $source
  $active = [KodaXSidProbe]::HasOtherProcessWithSid(
    [string]$payload.sid,
    [bool]$payload.ignoreCurrentProcessTree)
  [Console]::Out.WriteLine($(if ($active) { 'ACTIVE' } else { 'CLEAR' }))
  [Console]::Out.Flush()
  exit 0
} catch {
  [Console]::Out.WriteLine('ERROR:' + $_.Exception.Message)
  [Console]::Out.Flush()
  exit 1
}`;

const WINDOWS_SID_PROBE_ENCODED_COMMAND = Buffer.from(
  WINDOWS_SID_PROBE_SCRIPT,
  'utf16le',
).toString('base64');

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

function spawnWindowsEffectJobAction(
  payloadValue: Readonly<Record<string, unknown>>,
  launcher?: WindowsSandboxSidProbeLauncher,
): ChildProcess {
  const payload = Buffer.from(JSON.stringify(payloadValue), 'utf8').toString('base64');
  const powershell = windowsPowerShellPath();
  const encodedCommand = payloadValue.action === 'sid-active'
    ? WINDOWS_SID_PROBE_ENCODED_COMMAND
    : WINDOWS_EFFECT_JOB_ENCODED_COMMAND;
  const powershellArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  ];
  const executable = launcher?.executable ?? powershell;
  const args = launcher === undefined
    ? powershellArgs
    : [
        ...(launcher.prependArgs ?? []),
        'exec',
        '--quiet',
        '--env',
        `${PAYLOAD_ENV}=${payload}`,
        '--',
        powershell,
        ...powershellArgs,
      ];
  return spawn(executable, args, {
    env: launcher === undefined
      ? { ...process.env, [PAYLOAD_ENV]: payload }
      : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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

function runWindowsEffectJobAction(
  payloadValue: Readonly<Record<string, unknown>>,
  timeoutMs: number,
  subject: string,
  launcher?: WindowsSandboxSidProbeLauncher,
): Promise<WindowsEffectJobActionResult> {
  let child: ChildProcess;
  try {
    child = spawnWindowsEffectJobAction(payloadValue, launcher);
  } catch (error: unknown) {
    return Promise.reject(new Error(`${subject} failed to start: ${String(error)}`, { cause: error }));
  }
  return new Promise<WindowsEffectJobActionResult>((resolve, reject) => {
    new WindowsEffectJobActionObserver(child, timeoutMs, subject, resolve, reject).start();
  });
}

export async function containWindowsEffectProcess(
  processPid: number,
  ownerPid = process.pid,
): Promise<WindowsEffectJob> {
  if (process.platform !== 'win32') {
    throw new Error('Windows effect Job containment is available only on Windows.');
  }
  const powershell = windowsPowerShellPath();
  const jobName = `Global\\KodaXEffect-${randomUUID()}`;
  const payload = Buffer.from(JSON.stringify({
    targetPid: processPid,
    ownerPid,
    jobName,
  }), 'utf8').toString('base64');
  let supervisor: ChildProcess;
  try {
    supervisor = spawn(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      WINDOWS_EFFECT_JOB_ENCODED_COMMAND,
    ], {
      env: { ...process.env, [PAYLOAD_ENV]: payload },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    throw error;
  }
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
  const result = await runWindowsEffectJobAction({
    action: 'recover',
    jobName,
  }, timeoutMs, 'Windows effect Job recovery');
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  if (result.exitCode !== 0 || (output !== 'DRAINED' && output !== 'NOT_FOUND')) {
    throw new Error(
      `Windows effect Job recovery failed (exit ${String(result.exitCode)}`
      + `${result.signal === null ? '' : `, signal ${result.signal}`}): `
      + `${result.stdout.trim() || result.stderr.trim() || '(empty output)'}.`,
    );
  }
  return output === 'DRAINED' ? 'drained' : 'not_found';
}

export async function windowsSandboxSidHasActiveProcesses(
  sid: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  if (process.platform !== 'win32') {
    throw new Error('Windows sandbox process inspection is available only on Windows.');
  }
  if (!/^S-1-(?:\d+-)+\d+$/i.test(sid)) {
    throw new Error('Windows sandbox process inspection received an invalid SID.');
  }
  const result = await runWindowsEffectJobAction(
    { action: 'sid-active', sid },
    timeoutMs,
    'Windows sandbox process inspection',
  );
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  if (result.exitCode !== 0 || (output !== 'ACTIVE' && output !== 'CLEAR')) {
    throw new Error(
      `Windows sandbox process inspection failed (exit ${String(result.exitCode)}`
      + `${result.signal === null ? '' : `, signal ${result.signal}`}): `
      + `${result.stdout.trim() || result.stderr.trim() || '(empty output)'}.`,
    );
  }
  return output === 'ACTIVE';
}

export async function windowsSandboxSidHasOtherProcesses(
  sid: string,
  launcher: WindowsSandboxSidProbeLauncher,
  timeoutMs = 15_000,
): Promise<boolean> {
  if (process.platform !== 'win32') {
    throw new Error('Windows sandbox process inspection is available only on Windows.');
  }
  if (!/^S-1-(?:\d+-)+\d+$/i.test(sid)) {
    throw new Error('Windows sandbox process inspection received an invalid SID.');
  }
  const result = await runWindowsEffectJobAction(
    { action: 'sid-active', sid, ignoreCurrentProcessTree: true },
    timeoutMs,
    'Windows sandbox-user process inspection',
    launcher,
  );
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  if (result.exitCode !== 0 || (output !== 'ACTIVE' && output !== 'CLEAR')) {
    throw new Error(
      `Windows sandbox-user process inspection failed (exit ${String(result.exitCode)}`
      + `${result.signal === null ? '' : `, signal ${result.signal}`}): `
      + `${result.stdout.trim() || result.stderr.trim() || '(empty output)'}.`,
    );
  }
  return output === 'ACTIVE';
}

/** Startup cost is mostly Add-Type compiling the supervisor, which runs on every launch. */
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
      supervisor.off('exit', onExit);
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
    supervisor.once('exit', onExit);
  });
}
