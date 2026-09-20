import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STARTUP_TIMEOUT_MS = 15_000;
const PAYLOAD_ENV = 'KODAX_INTERNAL_WINDOWS_JOB_LAUNCH';
const READY_FILE_ENV = 'KODAX_INTERNAL_WINDOWS_JOB_READY_FILE';
const SCRIPT_FILE_ENV = 'KODAX_INTERNAL_WINDOWS_JOB_SCRIPT_FILE';
const OWNER_AFTER_READY_ENV = 'KODAX_INTERNAL_WINDOWS_JOB_TEST_OWNER_AFTER_READY';
const HANDOFF_ENV = 'KODAX_INTERNAL_WINDOWS_JOB_HANDOFF';

// PowerShell launched detached by Node exits without executing its command on
// supported Windows hosts. This detached Node bootstrap keeps one ordinary
// PowerShell child alive after the SDK caller exits. PowerShell remains the
// authoritative Job owner. The bootstrap retains its exact ChildProcess handle
// for startup cleanup and reports the public owner PID over private Node IPC.
const WINDOWS_JOB_WRAPPER_SOURCE = String.raw`
const { spawn } = require('node:child_process');
const { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const readyFile = process.env.${READY_FILE_ENV};
const scriptFile = process.env.${SCRIPT_FILE_ENV};
const handoffFile = process.env.${HANDOFF_ENV};
const logFile = JSON.parse(Buffer.from(process.env.${PAYLOAD_ENV}, 'base64').toString('utf8')).logFile;
const childEnv = { ...process.env };
delete childEnv.${SCRIPT_FILE_ENV};
delete childEnv.${OWNER_AFTER_READY_ENV};
const fail = (message) => {
  if (!existsSync(readyFile)) writeFileSync(readyFile, 'ERROR:' + message);
};
let child;
let childExited = false;
let phase = 'candidate';
const reportError = (error) => {
  try { appendFileSync(logFile, 'Windows Job startup control failed: ' + error.message + '\n'); }
  catch (logError) { process.stderr.write(String(logError) + '\n'); }
};
const cleanHandoff = () => {
  if (!handoffFile) return;
  try { rmSync(handoffFile, { force: true }); }
  catch (error) { reportError(error); }
};
const cleanReady = () => {
  try { rmSync(readyFile, { force: true }); }
  catch (error) { reportError(error); }
};
const cleanScript = () => {
  try { rmSync(scriptFile, { force: true }); }
  catch (error) { reportError(error); }
};
const cleanAfterExit = async () => {
  if (!handoffFile) return;
  cleanScript();
  if (phase === 'aborting') {
    // The wrapper owns this ready file until teardown. Missing publication
    // proves the suspended target was never resumed; malformed data does not.
    let targetPid;
    try {
      const ready = JSON.parse(readFileSync(readyFile, 'utf8'));
      if (!Number.isSafeInteger(ready.processPid) || ready.processPid <= 0
        || ready.containmentSupervisorPid !== child.pid) throw new Error('Cannot verify startup target identity after Job owner exit.');
      targetPid = ready.processPid;
    } catch (error) {
      if (error.code !== 'ENOENT') { reportError(error); return; }
    }
    const deadline = Date.now() + 2000;
    while (targetPid !== undefined) {
      try { process.kill(targetPid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') break;
        reportError(error); return;
      }
      if (Date.now() >= deadline) {
        reportError(new Error('Startup target did not exit; preserving abort marker.'));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  cleanHandoff();
  cleanReady();
};
const stopCandidate = () => {
  if (childExited || phase === 'aborting') return 'terminating';
  if (phase === 'persistent') return 'retained';
  if (handoffFile) {
    // Only this wrapper and the trusted target create the one-shot marker.
    // After observing commit, remember it before removing the marker.
    let descriptor;
    try { descriptor = openSync(handoffFile, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      phase = 'persistent';
      cleanHandoff();
      cleanReady();
      cleanScript();
      return 'retained';
    }
    phase = 'aborting';
    try { closeSync(descriptor); } catch (error) { reportError(error); }
  } else phase = 'aborting';
  if (child?.pid) child.kill();
  else process.exit(1);
  return 'terminating';
};
const reply = (message) => {
  if (!process.connected) return;
  try { process.send(message, (error) => { if (error) reportError(error); }); }
  catch (error) { reportError(error); }
};
process.on('message', (message) => {
  if (message?.kind !== 'terminate') return;
  try {
    const outcome = stopCandidate();
    if (handoffFile) reply({ kind: 'termination', requestId: message.requestId, outcome });
  } catch (error) {
    reportError(error);
    reply({ kind: 'termination', requestId: message.requestId, error: error.message });
  }
});
if (handoffFile) process.on('disconnect', () => {
  try { stopCandidate(); }
  catch (error) { reportError(error); }
});
child = spawn('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  process.env.${SCRIPT_FILE_ENV},
], { detached: false, windowsHide: true, stdio: 'ignore', env: childEnv });
child.once('error', (error) => {
  if (!handoffFile) { fail(error.message); return; }
  reportError(error);
  if (child.pid !== undefined) return;
  // A failed spawn emits error without exit; there is no Job or target to wait for.
  childExited = true;
  cleanScript();
  cleanHandoff();
  cleanReady();
  process.exit(1);
});
child.once('exit', async (code) => {
  childExited = true;
  if (code !== 0 && !handoffFile) fail('PowerShell supervisor exited before readiness.');
  await cleanAfterExit();
  process.exit(code ?? 1);
});
const publishOwner = () => {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || !process.send) return;
  process.send({ kind: 'owner', pid: child.pid }, (error) => {
    if (!error) return;
    try { stopCandidate(); } catch (cleanupError) { reportError(cleanupError); }
    if (handoffFile) reportError(new Error('Could not publish the PowerShell Job owner: ' + error.message));
    else fail('Could not publish the PowerShell Job owner: ' + error.message);
  });
};
if (process.env.${OWNER_AFTER_READY_ENV} === '1') {
  const timer = setInterval(() => {
    if (!existsSync(readyFile)) return;
    clearInterval(timer);
    publishOwner();
  }, 10);
} else {
  publishOwner();
}
`;

const WINDOWS_JOB_SUPERVISOR_SOURCE = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class KodaXWindowsJobSupervisor {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct StartupInfo {
    public uint cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public uint dwX;
    public uint dwY;
    public uint dwXSize;
    public uint dwYSize;
    public uint dwXCountChars;
    public uint dwYCountChars;
    public uint dwFillAttribute;
    public uint dwFlags;
    public ushort wShowWindow;
    public ushort cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInformation {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct SecurityAttributes {
    public int length;
    public IntPtr securityDescriptor;
    public int inheritHandle;
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
  private struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
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
  private static extern bool CreateProcessW(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref StartupInfo startupInfo,
    out ProcessInformation processInformation);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(
    IntPtr job,
    int informationClass,
    ref ExtendedLimitInformation information,
    uint informationLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool QueryInformationJobObject(
    IntPtr job,
    int informationClass,
    out BasicAccountingInformation information,
    uint informationLength,
    IntPtr returnLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateFileW(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    ref SecurityAttributes securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile);

  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  private const uint CreateSuspended = 0x00000004;
  private const uint CreateNoWindow = 0x08000000;
  private const uint StartfUseStdHandles = 0x00000100;
  private const uint JobObjectLimitKillOnJobClose = 0x00002000;
  private const uint FileAppendData = 0x00000004;
  private const uint Synchronize = 0x00100000;
  private const uint FileShareRead = 0x00000001;
  private const uint FileShareWrite = 0x00000002;
  private const uint FileShareDelete = 0x00000004;
  private const uint OpenAlways = 4;
  private const uint FileAttributeNormal = 0x00000080;

  private static void Require(bool result, string operation) {
    if (!result) throw new InvalidOperationException(
      operation + " failed with Win32 error " + Marshal.GetLastWin32Error());
  }

  private static void PublishReady(string readyFile, uint processId) {
    var temporaryFile = readyFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
    try {
      File.WriteAllText(
        temporaryFile,
        "{\"processPid\":" + processId +
          ",\"containmentSupervisorPid\":" +
          System.Diagnostics.Process.GetCurrentProcess().Id + "}");
      File.Move(temporaryFile, readyFile);
    } finally {
      if (File.Exists(temporaryFile)) File.Delete(temporaryFile);
    }
  }

  public static int Run(
    string executable,
    string commandLine,
    string cwd,
    string readyFile,
    string logFile,
    string jobName) {
    var job = CreateJobObjectW(IntPtr.Zero, jobName);
    if (job == IntPtr.Zero) throw new InvalidOperationException(
      "CreateJobObject failed with Win32 error " + Marshal.GetLastWin32Error());
    var process = new ProcessInformation();
    var processAssigned = false;
    var security = new SecurityAttributes();
    security.length = Marshal.SizeOf(typeof(SecurityAttributes));
    security.inheritHandle = 1;
    var logHandle = CreateFileW(
      logFile,
      FileAppendData | Synchronize,
      FileShareRead | FileShareWrite | FileShareDelete,
      ref security,
      OpenAlways,
      FileAttributeNormal,
      IntPtr.Zero);
    if (logHandle == new IntPtr(-1)) throw new InvalidOperationException(
      "CreateFile for daemon log failed with Win32 error " + Marshal.GetLastWin32Error());
    try {
      var limits = new ExtendedLimitInformation();
      limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
      Require(SetInformationJobObject(
        job,
        9,
        ref limits,
        (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))),
        "SetInformationJobObject");

      var startup = new StartupInfo();
      startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
      startup.dwFlags = StartfUseStdHandles;
      startup.hStdInput = IntPtr.Zero;
      startup.hStdOutput = logHandle;
      startup.hStdError = logHandle;
      Require(CreateProcessW(
        executable,
        new StringBuilder(commandLine),
        IntPtr.Zero,
        IntPtr.Zero,
        true,
        CreateSuspended | CreateNoWindow,
        IntPtr.Zero,
        cwd,
        ref startup,
        out process),
        "CreateProcess");
      Require(AssignProcessToJobObject(job, process.hProcess), "AssignProcessToJobObject");
      processAssigned = true;
      PublishReady(readyFile, process.dwProcessId);
      if (ResumeThread(process.hThread) == 0xffffffff) {
        throw new InvalidOperationException(
          "ResumeThread failed with Win32 error " + Marshal.GetLastWin32Error());
      }

      if (WaitForSingleObject(process.hProcess, 0xffffffff) == 0xffffffff) {
        throw new InvalidOperationException(
          "WaitForSingleObject failed with Win32 error " + Marshal.GetLastWin32Error());
      }
      uint exitCode;
      if (!GetExitCodeProcess(process.hProcess, out exitCode)) exitCode = 1;
      Require(TerminateJobObject(job, exitCode), "TerminateJobObject");
      while (true) {
        BasicAccountingInformation accounting;
        Require(QueryInformationJobObject(
          job,
          1,
          out accounting,
          (uint)Marshal.SizeOf(typeof(BasicAccountingInformation)),
          IntPtr.Zero),
          "QueryInformationJobObject");
        if (accounting.ActiveProcesses == 0) return unchecked((int)exitCode);
        Thread.Sleep(10);
      }
    } finally {
      if (process.hProcess != IntPtr.Zero && !processAssigned) {
        TerminateProcess(process.hProcess, 1);
        WaitForSingleObject(process.hProcess, 2000);
      }
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
      CloseHandle(logHandle);
      CloseHandle(job);
    }
  }
}`;

const WINDOWS_JOB_SUPERVISOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $readyFile = $env:${READY_FILE_ENV}
  $payloadBytes = [Convert]::FromBase64String($env:${PAYLOAD_ENV})
  $payload = [Text.Encoding]::UTF8.GetString($payloadBytes) | ConvertFrom-Json
  Remove-Item Env:${PAYLOAD_ENV} -ErrorAction SilentlyContinue
  Remove-Item Env:${READY_FILE_ENV} -ErrorAction SilentlyContinue
  $env:KODAX_DAEMON_JOB_CONTAINED = '1'
  $env:KODAX_DAEMON_JOB_SUPERVISOR_PID = [string]$PID
  $env:KODAX_DAEMON_JOB_NAME = [string]$payload.jobName
  $source = @'
${WINDOWS_JOB_SUPERVISOR_SOURCE}
'@
  Add-Type -TypeDefinition $source
  $exitCode = [KodaXWindowsJobSupervisor]::Run(
    [string]$payload.executable,
    [string]$payload.commandLine,
    [string]$payload.cwd,
    [string]$payload.readyFile,
    [string]$payload.logFile,
    [string]$payload.jobName)
  exit $exitCode
} catch {
  [IO.File]::WriteAllText($readyFile, 'ERROR:' + $_.Exception.Message)
  exit 1
}
`;

export interface WindowsJobContainedProcess {
  readonly processPid: number;
  /** PID of the PowerShell process that owns the Job handle. */
  readonly containmentSupervisorPid: number;
  readonly supervisor: ChildProcess;
  /** Handoff-enabled targets must commit publication before their launcher releases. */
  release(): void;
  /** A committed shared target is retained; this is not proof of process exit. */
  terminate(): Promise<void | 'retained'>;
}

export interface WindowsJobContainedSpawnInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logFile: string;
  readonly startupTimeoutMs?: number;
  /** @internal Enable daemon-owned publication versus startup-abort arbitration. */
  readonly startupHandoff?: boolean;
}

export function quoteWindowsCommandLineArg(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
}

export function buildWindowsCommandLine(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quoteWindowsCommandLineArg).join(' ');
}

export async function spawnWindowsJobContainedProcess(
  input: WindowsJobContainedSpawnInput,
): Promise<WindowsJobContainedProcess> {
  if (process.platform !== 'win32') {
    throw new Error('Windows Job containment is available only on Windows.');
  }
  const readyFile = path.join(os.tmpdir(), `kodax-daemon-job-${randomUUID()}.ready`);
  const scriptFile = path.join(os.tmpdir(), `kodax-daemon-job-${randomUUID()}.ps1`);
  const handoffFile = input.startupHandoff
    ? path.join(os.tmpdir(), `kodax-daemon-handoff-${randomUUID()}`)
    : undefined;
  writeFileSync(scriptFile, WINDOWS_JOB_SUPERVISOR_SCRIPT, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  const payload = Buffer.from(JSON.stringify({
    executable: input.executable,
    commandLine: buildWindowsCommandLine(input.executable, input.args),
    cwd: input.cwd,
    readyFile,
    logFile: input.logFile,
    jobName: `KodaXDaemonJob-${randomUUID()}`,
  }), 'utf8').toString('base64');
  const supervisorEnv = { ...input.env };
  delete supervisorEnv.KODAX_DAEMON_JOB_CONTAINED;
  delete supervisorEnv.KODAX_DAEMON_JOB_SUPERVISOR_PID;
  delete supervisorEnv.KODAX_DAEMON_JOB_NAME;
  delete supervisorEnv[HANDOFF_ENV];
  let supervisor: ChildProcess;
  try {
    supervisor = spawn(process.execPath, ['-e', WINDOWS_JOB_WRAPPER_SOURCE], {
      cwd: input.cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...supervisorEnv,
        [PAYLOAD_ENV]: payload,
        [READY_FILE_ENV]: readyFile,
        [SCRIPT_FILE_ENV]: scriptFile,
        ...(handoffFile === undefined ? {} : { [HANDOFF_ENV]: handoffFile }),
      },
    });
  } catch (error) {
    rmSync(readyFile, { force: true });
    rmSync(scriptFile, { force: true });
    throw error;
  }
  const readiness = await waitForSupervisorReadiness(
    supervisor,
    readyFile,
    input.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
  ).catch(async (error: unknown) => {
    try {
      if (await terminateSupervisor(supervisor, undefined, input.startupHandoff) === 'retained') {
        releaseSupervisor(supervisor);
      }
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        'Windows Job supervisor startup failed and its process tree was not reclaimed.',
      );
    }
    throw error;
  }).finally(() => {
    if (handoffFile === undefined) rmSync(readyFile, { force: true });
    rmSync(scriptFile, { force: true });
  });
  let released = false;
  return {
    ...readiness,
    supervisor,
    release: () => {
      released = true;
      releaseSupervisor(supervisor);
    },
    terminate: () => released && input.startupHandoff
      && supervisor.exitCode === null && supervisor.signalCode === null
      ? Promise.resolve('retained')
      : terminateSupervisor(supervisor, readiness.processPid, input.startupHandoff),
  };
}

async function waitForSupervisorReadiness(
  supervisor: ChildProcess,
  readyFile: string,
  timeoutMs: number,
): Promise<{ readonly processPid: number; readonly containmentSupervisorPid: number }> {
  let launchError: Error | undefined;
  let containmentSupervisorPid: number | undefined;
  const captureLaunchError = (error: Error): void => {
    launchError = error;
  };
  const captureOwner = (message: unknown): void => {
    if (
      message !== null
      && typeof message === 'object'
      && 'kind' in message
      && message.kind === 'owner'
      && 'pid' in message
      && Number.isSafeInteger(message.pid)
      && Number(message.pid) > 0
    ) containmentSupervisorPid = Number(message.pid);
  };
  supervisor.once('error', captureLaunchError);
  supervisor.on('message', captureOwner);
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      if (launchError !== undefined) throw launchError;
      try {
        const value = readFileSync(readyFile, 'utf8').trim();
        if (value.startsWith('ERROR:')) {
          throw new Error(`Windows Job supervisor startup failed: ${value.slice(6)}`);
        }
        const parsed = JSON.parse(value) as {
          readonly processPid?: unknown;
          readonly containmentSupervisorPid?: unknown;
        };
        if (
          !Number.isSafeInteger(parsed.processPid)
          || Number(parsed.processPid) <= 0
          || !Number.isSafeInteger(parsed.containmentSupervisorPid)
          || Number(parsed.containmentSupervisorPid) <= 0
        ) {
          throw new Error('Windows Job supervisor wrote invalid readiness identities.');
        }
        if (containmentSupervisorPid !== undefined) {
          if (Number(parsed.containmentSupervisorPid) !== containmentSupervisorPid) {
            throw new Error('Windows Job supervisor readiness owner identities do not match.');
          }
          return {
            processPid: Number(parsed.processPid),
            containmentSupervisorPid,
          };
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
        throw new Error(
          `Windows Job supervisor exited before daemon readiness (code ${supervisor.exitCode ?? 'unknown'}).`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error('Windows Job supervisor did not report daemon readiness in time.');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    supervisor.off('error', captureLaunchError);
    supervisor.off('message', captureOwner);
  }
}

function releaseSupervisor(supervisor: ChildProcess): void {
  if (supervisor.connected) supervisor.disconnect();
  supervisor.unref();
}

async function terminateSupervisor(
  supervisor: ChildProcess,
  daemonPid?: number,
  startupHandoff = false,
): Promise<void | 'retained'> {
  if (supervisor.pid === undefined) return;
  const deadline = Date.now() + 2_000;
  let controlError: unknown;
  if (supervisor.exitCode === null && supervisor.signalCode === null && supervisor.connected) {
    try {
      if (await requestSupervisorTermination(supervisor, startupHandoff, deadline) === 'retained') {
        return 'retained';
      }
    } catch (error: unknown) {
      controlError = error;
    }
  }
  // Natural exit can close IPC before Node delivers the exit event. Only
  // process-exit proof settles cleanup; a lost channel alone never does.
  try {
    await waitForWrapperExit(supervisor, deadline);
    if (daemonPid !== undefined) await waitForPidExit(daemonPid, 2_000);
  } catch (error: unknown) {
    if (controlError !== undefined) {
      throw new AggregateError([controlError, error],
        'Windows Job supervisor control failed and process cleanup could not be confirmed.');
    }
    throw error;
  }
}

async function requestSupervisorTermination(
  supervisor: ChildProcess,
  startupHandoff: boolean,
  deadline: number,
): Promise<void | 'retained'> {
  const requestId = randomUUID();
  let onMessage: ((message: unknown) => void) | undefined;
  let onExit: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<void | 'retained'>((resolve, reject) => {
      if (startupHandoff) {
        onMessage = (message) => {
          if (message === null || typeof message !== 'object'
            || !('kind' in message) || message.kind !== 'termination'
            || !('requestId' in message) || message.requestId !== requestId) return;
          if ('error' in message && typeof message.error === 'string') {
            reject(new Error(message.error));
          } else if ('outcome' in message && message.outcome === 'retained') resolve('retained');
          else resolve();
        };
        onExit = () => resolve();
        supervisor.on('message', onMessage);
        supervisor.once('exit', onExit);
        timeout = setTimeout(() => reject(new Error('Windows Job startup control did not acknowledge termination.')), Math.max(0, deadline - Date.now()));
      }
      supervisor.send({ kind: 'terminate', requestId }, (error) => {
        if (error) reject(error);
        else if (!startupHandoff) resolve();
      });
    });
  } finally {
    if (onMessage) supervisor.off('message', onMessage);
    if (onExit) supervisor.off('exit', onExit);
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForWrapperExit(supervisor: ChildProcess, deadline: number): Promise<void> {
  while (supervisor.exitCode === null && supervisor.signalCode === null) {
    if (Date.now() >= deadline) {
      throw new Error('Windows Job supervisor did not exit after startup cleanup.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Process ${pid} did not exit after termination.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
