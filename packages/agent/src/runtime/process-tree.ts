import {
  spawnSync,
  type ChildProcess,
  type SpawnSyncReturns,
} from 'node:child_process';
import { readFileSync } from 'node:fs';
import { emitKodaXDiagnostic } from '../diagnostics.js';

function reportWindowsProbe(stage: string, result: SpawnSyncReturns<string>, startedAt: number, available: boolean): void {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  emitKodaXDiagnostic({
    source: 'runtime:windows', level: available ? 'debug' : 'warn',
    message: 'Windows process probe completed.',
    detail: {
      stage, cached: false, available, durationMs: Date.now() - startedAt, timeoutMs: 5_000,
      exitCode: result.status,
      errorCode: code === undefined ? undefined
        : ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ENOEXEC', 'ENOMEM', 'EIO'].includes(code) ? code : 'OTHER',
    },
  });
}

// Keep Windows snapshot, identity-fence, and termination semantics in sync with
// packages/llm/src/cli-events/process-tree.ts. Public exports and timeout
// plumbing intentionally differ because @kodax-ai/llm stays dependency-light.

const DEFAULT_GRACE_MS = 300;
const DEFAULT_FORCE_MS = 2_000;
const DEFAULT_TASKKILL_MS = 5_000;
const WINDOWS_JOB_MEMBERSHIP_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
public static class KodaXWindowsJobMembership {
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
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr OpenJobObjectW(uint desiredAccess, bool inheritHandle, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool QueryInformationJobObject(
    IntPtr job,
    int informationClass,
    out ExtendedLimitInformation information,
    uint informationLength,
    IntPtr returnLength);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  public static bool IsCurrentProcessContained(string name) {
    var job = OpenJobObjectW(4, false, name);
    if (job == IntPtr.Zero) return false;
    try {
      bool inJob;
      if (!IsProcessInJob(GetCurrentProcess(), job, out inJob) || !inJob) return false;
      ExtendedLimitInformation limits;
      if (!QueryInformationJobObject(
        job,
        9,
        out limits,
        (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation)),
        IntPtr.Zero)) return false;
      return (limits.BasicLimitInformation.LimitFlags & 0x00002000) != 0;
    } finally {
      CloseHandle(job);
    }
  }
}`;
const WINDOWS_JOB_MEMBERSHIP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:KODAX_INTERNAL_JOB_QUERY_SOURCE))
Add-Type -TypeDefinition $source
if ([KodaXWindowsJobMembership]::IsCurrentProcessContained($env:KODAX_DAEMON_JOB_NAME)) {
  [Console]::Out.Write('1')
} else {
  [Console]::Out.Write('0')
}`;
const NATIVE_PARENT_PROCESS_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KodaXNativeProcessSnapshot {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  private struct ProcessEntry32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry32 entry);
  [StructLayout(LayoutKind.Sequential)]
  private struct FileTime {
    public uint Low;
    public uint High;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll")]
  private static extern void GetSystemTimeAsFileTime(out FileTime systemTime);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  private static ulong ReadCreationTime(uint processId) {
    var process = OpenProcess(0x1000, false, processId);
    if (process == IntPtr.Zero) return 0;
    try {
      FileTime creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return 0;
      return ((ulong)creation.High << 32) | creation.Low;
    } finally {
      CloseHandle(process);
    }
  }
  public static int TerminateExact(uint processId, ulong expectedCreationTime) {
    var process = OpenProcess(0x1001, false, processId);
    if (process == IntPtr.Zero) return 0;
    try {
      FileTime creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return 0;
      var actual = (((ulong)creation.High << 32) | creation.Low) / 10000;
      if (actual != expectedCreationTime) return 2;
      return TerminateProcess(process, 1) ? 1 : 0;
    } finally {
      CloseHandle(process);
    }
  }
  public static string ReadRows() {
    FileTime cutoffTime;
    GetSystemTimeAsFileTime(out cutoffTime);
    var cutoff = (((ulong)cutoffTime.High << 32) | cutoffTime.Low) / 10000;
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) return string.Empty;
    var rows = new StringBuilder();
    var entry = new ProcessEntry32();
    entry.dwSize = (uint)Marshal.SizeOf(entry);
    try {
      if (!Process32First(snapshot, ref entry)) return string.Empty;
      do {
        var creationTime = ReadCreationTime(entry.th32ProcessID) / 10000;
        if (creationTime == 0 || creationTime <= cutoff) {
          rows.Append(entry.th32ProcessID).Append(',').Append(entry.th32ParentProcessID).Append(',').Append(creationTime).Append('\n');
        }
        entry.dwSize = (uint)Marshal.SizeOf(entry);
      } while (Process32Next(snapshot, ref entry));
      return rows.ToString();
    } finally {
      CloseHandle(snapshot);
    }
  }
}`;

export interface ProcessTreeKillOptions {
  readonly gracefulStdinEnd?: boolean;
  readonly gracefulMs?: number;
  readonly forceMs?: number;
  readonly taskkillMs?: number;
  /** Exact OS process-start identity captured before cleanup begins. */
  readonly expectedProcessStartIdentity?: string;
  /** Exact Windows tree identities retained by a managed-process registry. */
  readonly expectedProcessTreeIdentities?: readonly WindowsProcessTreeIdentity[];
  readonly expectedProcessTreeComplete?: boolean;
}

export interface WindowsProcessTreeIdentity {
  readonly pid: number;
  readonly creationTime: string;
}

export type ProcessTreeKillStatus = 'terminated' | 'already-exited' | 'unknown';

export interface ProcessTreeKillResult {
  readonly status: ProcessTreeKillStatus;
}

const TERMINATED: ProcessTreeKillResult = Object.freeze({ status: 'terminated' });
const ALREADY_EXITED: ProcessTreeKillResult = Object.freeze({ status: 'already-exited' });
const UNKNOWN: ProcessTreeKillResult = Object.freeze({ status: 'unknown' });

export function isChildProcessExited(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function waitForChildProcessExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (isChildProcessExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
    child.once('error', onExit);
  });
}

function signalPosixPidTree(pid: number, signal: NodeJS.Signals): boolean {
  let signaled = false;
  try {
    process.kill(-pid, signal);
    signaled = true;
  } catch {
    // The child may not be a process-group leader (older registrations or
    // callers that did not use detached:true). Fall back to direct PID below.
  }

  try {
    process.kill(pid, signal);
    signaled = true;
  } catch {
    // If the group signal succeeded, the direct PID may already be gone.
  }
  return signaled;
}

function signalTargetExists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isPosixPidTreeAlive(pid: number): boolean {
  return signalTargetExists(-pid) || signalTargetExists(pid);
}

async function waitForPosixPidTreeExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPosixPidTreeAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPosixPidTreeAlive(pid);
}

interface WindowsProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly creationTime: string;
}

function parseWindowsProcessSnapshotJson(stdout: string): WindowsProcessIdentity[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row) => {
      if (typeof row !== 'object' || row === null) return [];
      const record = row as Record<string, unknown>;
      const pid = Number(record.pid);
      const parentPid = Number(record.parentPid);
      const creationTime = typeof record.creationTime === 'string'
        ? record.creationTime
        : String(record.creationTime ?? '0');
      if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(parentPid)) return [];
      return [{
        pid,
        parentPid,
        creationTime: /^\d+$/.test(creationTime) ? creationTime : '0',
      }];
    });
  } catch {
    return [];
  }
}

function parseWmicCreationTime(
  value: string,
): { readonly identity: string; readonly unixMs: number } | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction, sign, offset] = match;
  const localMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.slice(0, 3)),
  );
  const offsetMs = Number(offset) * 60_000 * (sign === '+' ? 1 : -1);
  const unixMs = localMs - offsetMs;
  if (!Number.isFinite(unixMs)) return undefined;
  return {
    identity: (BigInt(unixMs) + 11_644_473_600_000n).toString(),
    unixMs,
  };
}

function readWindowsProcessSnapshotFallback(): WindowsProcessIdentity[] | undefined {
  const script = [
    '$cutoff = [DateTime]::UtcNow',
    '$items = try { @(Get-CimInstance Win32_Process -ErrorAction Stop) } catch { @(Get-WmiObject Win32_Process -ErrorAction Stop) }',
    '$rows = @($items | ForEach-Object {',
    "  $creationTime = '0'",
    '  try {',
    '    $created = $_.CreationDate',
    '    if ($created -isnot [DateTime]) { $created = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created) }',
    '    $created = $created.ToUniversalTime()',
    '    if ($created -le $cutoff) { $creationTime = ([long][Math]::Floor($created.ToFileTimeUtc() / 10000)).ToString() }',
    '  } catch {}',
    '  [PSCustomObject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; creationTime = $creationTime }',
    '})',
    '$rows | ConvertTo-Json -Compress',
  ].join('\n');
  const startedAt = Date.now();
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: DEFAULT_TASKKILL_MS,
    windowsHide: true,
  });
  if (!result.error && result.status === 0) {
    const snapshot = parseWindowsProcessSnapshotJson(result.stdout);
    if (snapshot.length > 0) return snapshot;
  }
  reportWindowsProbe('process-snapshot-cim', result, startedAt, false);

  const cutoffUnixMs = Date.now();
  const wmic = spawnSync('wmic', [
    'process',
    'get',
    'CreationDate,ParentProcessId,ProcessId',
    '/format:list',
  ], {
    encoding: 'utf8',
    timeout: DEFAULT_TASKKILL_MS,
    windowsHide: true,
  });
  if (wmic.error || wmic.status !== 0) {
    reportWindowsProbe('process-snapshot-wmic', wmic, cutoffUnixMs, false);
    return undefined;
  }
  const snapshot = wmic.stdout.split(/\r?\n\s*\r?\n/).flatMap((block) => {
    const values = new Map(
      block.split(/\r?\n/).flatMap((line): Array<[string, string]> => {
        const separator = line.indexOf('=');
        return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
      }),
    );
    const pid = Number(values.get('ProcessId'));
    const parentPid = Number(values.get('ParentProcessId'));
    const creationTime = values.get('CreationDate');
    const parsedCreationTime = creationTime === undefined
      ? undefined
      : parseWmicCreationTime(creationTime);
    if (
      !Number.isFinite(pid)
      || pid <= 0
      || !Number.isFinite(parentPid)
      || parsedCreationTime === undefined
      || parsedCreationTime.unixMs > cutoffUnixMs
    ) return [];
    return [{ pid, parentPid, creationTime: parsedCreationTime.identity }];
  });
  return snapshot.length > 0 ? snapshot : undefined;
}

function readWindowsProcessSnapshotNative(): WindowsProcessIdentity[] | undefined {
  const script = [
    "$source = @'",
    NATIVE_PARENT_PROCESS_SOURCE,
    "'@",
    'Add-Type -TypeDefinition $source',
    '[KodaXNativeProcessSnapshot]::ReadRows()',
  ].join('\n');
  const startedAt = Date.now();
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: DEFAULT_TASKKILL_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    reportWindowsProbe('process-snapshot-native', result, startedAt, false);
    return undefined;
  }
  const snapshot = parseWindowsNativeProcessRows(result.stdout);
  if (snapshot === undefined) reportWindowsProbe('process-snapshot-native', result, startedAt, false);
  return snapshot;
}

function parseWindowsNativeProcessRows(stdout: string): WindowsProcessIdentity[] | undefined {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => !/^\d+,\d+,\d+$/.test(line))) return undefined;
  const snapshot = lines.flatMap((line) => {
    const [pidText, parentText, creationTime = '0'] = line.split(',', 3);
    const pid = Number(pidText);
    const parentPid = Number(parentText);
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(parentPid)) return [];
    return [{ pid, parentPid, creationTime }];
  });
  return snapshot.length > 0 ? snapshot : undefined;
}

function readWindowsProcessSnapshotUncached(): WindowsProcessIdentity[] | undefined {
  const nativeSnapshot = readWindowsProcessSnapshotNative();
  return nativeSnapshot ?? readWindowsProcessSnapshotFallback();
}

// The stale-children cleanup sweep captures and kills several recorded trees
// back to back; each capture used to pay a fresh powershell process snapshot
// (~1s). Inside `withSharedWindowsProcessSnapshot` all reads reuse one
// snapshot, and any actual termination invalidates it so later reads and
// captures never trust pre-kill data.
let sharedSnapshot: WindowsProcessIdentity[] | undefined;
let sharedSnapshotRead = false;
let sharedSnapshotScopeDepth = 0;

function readWindowsProcessSnapshot(): WindowsProcessIdentity[] | undefined {
  if (sharedSnapshotScopeDepth <= 0) return readWindowsProcessSnapshotUncached();
  if (!sharedSnapshotRead) {
    sharedSnapshot = readWindowsProcessSnapshotUncached();
    sharedSnapshotRead = true;
  }
  return sharedSnapshot;
}

function invalidateSharedWindowsProcessSnapshot(): void {
  sharedSnapshot = undefined;
  sharedSnapshotRead = false;
}

export async function withSharedWindowsProcessSnapshot<T>(
  scope: () => Promise<T>,
): Promise<T> {
  sharedSnapshotScopeDepth += 1;
  try {
    return await scope();
  } finally {
    sharedSnapshotScopeDepth -= 1;
    if (sharedSnapshotScopeDepth === 0) invalidateSharedWindowsProcessSnapshot();
  }
}

/** Read an OS-issued start identity so later cleanup never trusts a bare PID. */
export function readProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'win32') {
    const identity = readWindowsProcessSnapshot()
      ?.find((candidate) => candidate.pid === pid);
    if (identity === undefined || identity.creationTime === '0') {
      emitKodaXDiagnostic({
        source: 'runtime:windows', level: 'warn', message: 'Windows process start identity is unavailable.',
        detail: { stage: 'process-start-identity', pid, available: false },
      });
    }
    return identity?.creationTime === '0' ? undefined : identity?.creationTime;
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return fields[19] === undefined ? undefined : `linux:${fields[19]}`;
    } catch {
      return undefined;
    }
  }
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: DEFAULT_TASKKILL_MS,
    windowsHide: true,
  });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return value === '' ? undefined : `${process.platform}:${value}`;
}

/** True only when this daemon entered its supervising Windows Job before startup. */
let currentProcessWindowsJobContained: boolean | undefined;

export function isCurrentProcessWindowsJobContained(): boolean {
  if (process.platform !== 'win32') return false;
  if (currentProcessWindowsJobContained !== undefined) {
    emitKodaXDiagnostic({
      source: 'runtime:windows', level: 'debug', message: 'Using cached Windows Job probe result.',
      detail: { stage: 'job-membership', cached: true, available: currentProcessWindowsJobContained },
    });
    return currentProcessWindowsJobContained;
  }
  const supervisorPid = Number.parseInt(
    process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID ?? '',
    10,
  );
  if (
    process.env.KODAX_DAEMON_JOB_CONTAINED !== '1'
    || !process.env.KODAX_DAEMON_JOB_NAME
    || !Number.isSafeInteger(supervisorPid)
    || supervisorPid <= 0
  ) {
    currentProcessWindowsJobContained = false;
    emitKodaXDiagnostic({
      source: 'runtime:windows', level: 'warn', message: 'Windows Job supervisor metadata is unavailable.',
      detail: { stage: 'job-membership', cached: false, available: false, reason: 'supervisor-metadata' },
    });
    return false;
  }
  const startedAt = Date.now();
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_JOB_MEMBERSHIP_SCRIPT],
    {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      env: {
        ...process.env,
        KODAX_INTERNAL_JOB_QUERY_SOURCE: Buffer.from(
          WINDOWS_JOB_MEMBERSHIP_SOURCE,
          'utf8',
        ).toString('base64'),
      },
    },
  );
  currentProcessWindowsJobContained = result.status === 0 && result.stdout.trim() === '1';
  reportWindowsProbe('job-membership', result, startedAt, currentProcessWindowsJobContained);
  return currentProcessWindowsJobContained;
}

function collectDescendantIdentities(
  snapshot: readonly WindowsProcessIdentity[],
  parentPid: number,
  parentCreationTime?: string,
): WindowsProcessIdentity[] {
  const children = new Map<number, WindowsProcessIdentity[]>();
  for (const identity of snapshot) {
    children.set(identity.parentPid, [
      ...(children.get(identity.parentPid) ?? []),
      identity,
    ]);
  }

  const descendants: WindowsProcessIdentity[] = [];
  const pending: Array<{
    readonly pid: number;
    readonly creationTime?: string;
    readonly ancestryVerified: boolean;
  }> = [{
    pid: parentPid,
    ...(parentCreationTime === undefined ? {} : { creationTime: parentCreationTime }),
    ancestryVerified: parentCreationTime !== undefined && parentCreationTime !== '0',
  }];
  const seen = new Set<number>([parentPid]);
  while (pending.length > 0) {
    const parent = pending.shift();
    if (parent === undefined) break;
    for (const child of children.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      if (!windowsCreationAtLeast(child.creationTime, parent.creationTime)) continue;
      seen.add(child.pid);
      const ancestryVerified = parent.ancestryVerified
        && child.creationTime !== '0';
      descendants.push(ancestryVerified
        ? child
        : { ...child, creationTime: '0' });
      pending.push({
        pid: child.pid,
        creationTime: child.creationTime,
        ancestryVerified,
      });
    }
  }
  return descendants;
}

function windowsCreationAtLeast(
  childCreationTime: string,
  parentCreationTime: string | undefined,
): boolean {
  if (
    childCreationTime === '0'
    || parentCreationTime === undefined
    || parentCreationTime === '0'
  ) return true;
  try {
    return BigInt(childCreationTime) >= BigInt(parentCreationTime);
  } catch {
    return false;
  }
}

function currentCapturedWindowsPids(
  captured: readonly WindowsProcessIdentity[],
  snapshot: readonly WindowsProcessIdentity[] | undefined = readWindowsProcessSnapshot(),
): Set<number> | undefined {
  if (snapshot === undefined) return undefined;
  const uncertainPids = new Set(
    snapshot
      .filter((identity) => identity.creationTime === '0')
      .map((identity) => identity.pid),
  );
  if (captured.some((identity) => uncertainPids.has(identity.pid))) return undefined;
  const currentKeys = new Set(
    snapshot
      .filter((identity) => identity.creationTime !== '0')
      .map((identity) => `${identity.pid}:${identity.creationTime}`),
  );
  return new Set(
    captured
      .filter((identity) => identity.creationTime !== '0')
      .filter((identity) => currentKeys.has(`${identity.pid}:${identity.creationTime}`))
      .map((identity) => identity.pid),
  );
}

function capturedWindowsProcessesGone(
  capture: WindowsProcessTreeCapture,
  snapshot: readonly WindowsProcessIdentity[] | undefined = readWindowsProcessSnapshot(),
): boolean | undefined {
  if (snapshot === undefined) return undefined;
  const known = currentCapturedWindowsPids(
    [capture.root, ...capture.descendants],
    snapshot,
  );
  if (known === undefined) return undefined;
  if (known.size > 0) return false;
  if (capture.completeTree) {
    return capture.uncertainDescendantPids.every((pid) => (
      !snapshot.some((identity) => identity.pid === pid)
    ))
      ? true
      : undefined;
  }
  // A userspace capture that lost its root cannot prove that an exited
  // intermediate did not leave a detached descendant behind.
  return undefined;
}

function capturedWindowsPidMayBeAlive(capture: WindowsProcessTreeCapture): boolean {
  return [
    capture.root.pid,
    ...capture.descendants.map((identity) => identity.pid),
    ...capture.uncertainDescendantPids,
  ].some(signalTargetExists);
}

async function waitForCapturedWindowsProcessesExit(
  capture: WindowsProcessTreeCapture,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!capturedWindowsPidMayBeAlive(capture)) {
      return capturedWindowsProcessesGone(capture) === true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return capturedWindowsProcessesGone(capture) === true;
}

const WINDOWS_TERMINATION_COMPLETED = 'KODAX_TERMINATION_COMPLETED';
const WINDOWS_SNAPSHOT_COMPLETED = 'KODAX_SNAPSHOT_COMPLETED';

interface WindowsTerminationResult {
  readonly terminationAttempted: boolean;
  readonly snapshot?: readonly WindowsProcessIdentity[];
}

function readWindowsTerminationResult(
  stdout: string,
  succeeded: boolean,
): WindowsTerminationResult {
  const lines = stdout.trim().split(/\r?\n/);
  const terminated = lines.indexOf(WINDOWS_TERMINATION_COMPLETED);
  const completed = lines.indexOf(WINDOWS_SNAPSHOT_COMPLETED);
  return {
    // Snapshot failure must not erase a completed termination or suppress retry.
    terminationAttempted: succeeded || terminated >= 0,
    snapshot: succeeded && terminated >= 0 && completed > terminated
      ? parseWindowsNativeProcessRows(lines.slice(terminated + 1, completed).join('\n'))
      : undefined,
  };
}

function terminateCapturedWindowsProcesses(
  captured: readonly WindowsProcessIdentity[],
  timeoutMs: number,
  includeSnapshot = false,
): WindowsTerminationResult {
  const commands = [...captured].reverse().flatMap((identity) => (
    /^\d+$/.test(identity.creationTime)
      ? [`[KodaXNativeProcessSnapshot]::TerminateExact(${identity.pid}, [UInt64]${identity.creationTime}) | Out-Null`]
      : []
  ));
  if (commands.length === 0) return { terminationAttempted: false };
  const script = [
    "$source = @'",
    NATIVE_PARENT_PROCESS_SOURCE,
    "'@",
    'Add-Type -TypeDefinition $source',
    ...commands,
    ...(includeSnapshot ? [
      `[Console]::Out.WriteLine('${WINDOWS_TERMINATION_COMPLETED}')`,
      '[Console]::Out.Flush()',
      '[Console]::Out.Write([KodaXNativeProcessSnapshot]::ReadRows())',
      `[Console]::Out.WriteLine('${WINDOWS_SNAPSHOT_COMPLETED}')`,
      '[Console]::Out.Flush()',
    ] : []),
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  const termination = readWindowsTerminationResult(result.stdout ?? '', !result.error && result.status === 0);
  if (termination.terminationAttempted) invalidateSharedWindowsProcessSnapshot();
  return termination;
}

interface WindowsProcessTreeCapture {
  readonly root: WindowsProcessIdentity;
  readonly descendants: readonly WindowsProcessIdentity[];
  readonly uncertainDescendantPids: readonly number[];
  readonly completeTree: boolean;
}

/** Preserve exact identities even after an exited intermediate breaks ancestry. */
export function mergeWindowsProcessTreeCaptures(
  current: WindowsProcessTreeCapture | null | undefined,
  retained: WindowsProcessTreeCapture | undefined,
): WindowsProcessTreeCapture | undefined {
  if (current === undefined || current === null) return retained;
  if (retained === undefined) return current;
  if (current.root.pid !== retained.root.pid
    || current.root.creationTime !== retained.root.creationTime) return retained;
  const descendants = new Map<string, WindowsProcessIdentity>();
  for (const identity of [...retained.descendants, ...current.descendants]) {
    descendants.set(`${identity.pid}:${identity.creationTime}`, identity);
  }
  return { root: current.root, descendants: [...descendants.values()],
    uncertainDescendantPids: [...new Set([...retained.uncertainDescendantPids, ...current.uncertainDescendantPids])],
    completeTree: current.completeTree || retained.completeTree,
  };
}

const windowsCaptureByChild = new WeakMap<ChildProcess, WindowsProcessTreeCapture>();

export function rememberChildProcessTree(child: ChildProcess): string | undefined {
  if (
    process.platform !== 'win32'
    || child.pid === undefined
  ) return undefined;
  const tracked = windowsCaptureByChild.get(child);
  if (tracked !== undefined && !isChildProcessExited(child)) {
    const refreshed = captureWindowsProcessTree(child.pid, tracked.root.creationTime);
    if (refreshed !== undefined && refreshed !== null) {
      windowsCaptureByChild.set(child, mergeWindowsProcessTreeCaptures(refreshed, tracked) ?? tracked);
    }
    return tracked.root.creationTime;
  }
  const snapshot = readWindowsProcessSnapshot();
  if (tracked !== undefined && isChildProcessExited(child)) {
    if (snapshot === undefined) return tracked.root.creationTime;
    const currentRoot = snapshot.find((identity) => identity.pid === child.pid);
    if (
      currentRoot !== undefined
      && currentRoot.creationTime !== tracked.root.creationTime
    ) return tracked.root.creationTime;
    const descendants = collectDescendantIdentities(
      snapshot,
      tracked.root.pid,
      tracked.root.creationTime,
    );
    windowsCaptureByChild.set(child, mergeWindowsProcessTreeCaptures({
      root: tracked.root,
      descendants: descendants.filter((identity) => identity.creationTime !== '0'),
      uncertainDescendantPids: descendants
        .filter((identity) => identity.creationTime === '0')
        .map((identity) => identity.pid),
      // Once an incomplete capture loses its root, the remaining snapshot can
      // enrich known descendants but cannot prove that an already-exited
      // intermediate did not leave a detached grandchild behind.
      completeTree: tracked.completeTree,
    }, tracked) ?? tracked);
    return tracked.root.creationTime;
  }
  let root = snapshot?.find((identity) => (
    identity.pid === child.pid && identity.creationTime !== '0'
  ));
  if (root === undefined && snapshot !== undefined && !isChildProcessExited(child)) {
    root = readWindowsProcessSnapshot()?.find((identity) => (
      identity.pid === child.pid && identity.creationTime !== '0'
    ));
  }
  if (root === undefined || isChildProcessExited(child)) return undefined;
  windowsCaptureByChild.set(child, {
    root,
    descendants: [],
    uncertainDescendantPids: [],
    completeTree: false,
  });
  return root.creationTime;
}

export function rememberedChildProcessTreeIdentities(
  child: ChildProcess,
): readonly WindowsProcessTreeIdentity[] | undefined {
  if (process.platform !== 'win32') return undefined;
  const capture = windowsCaptureByChild.get(child);
  if (capture === undefined) return undefined;
  return [
    ...[capture.root, ...capture.descendants].map((identity) => ({
      pid: identity.pid,
      creationTime: identity.creationTime,
    })),
    ...capture.uncertainDescendantPids.map((pid) => ({
      pid,
      creationTime: '0',
    })),
  ];
}

export function rememberedChildProcessTreeIsComplete(
  child: ChildProcess,
): boolean {
  return windowsCaptureByChild.get(child)?.completeTree === true;
}

export function captureWindowsProcessTree(
  pid: number,
  expectedProcessStartIdentity: string,
): WindowsProcessTreeCapture | null | undefined {
  const snapshot = readWindowsProcessSnapshot();
  if (snapshot === undefined) return undefined;
  const root = snapshot.find((identity) => identity.pid === pid);
  if (root === undefined) return null;
  if (
    root.creationTime === '0'
    || root.creationTime !== expectedProcessStartIdentity
  ) return null;
  const descendants = collectDescendantIdentities(
    snapshot,
    pid,
    root.creationTime,
  );
  return {
    root,
    descendants: descendants.filter((identity) => identity.creationTime !== '0'),
    uncertainDescendantPids: descendants
      .filter((identity) => identity.creationTime === '0')
      .map((identity) => identity.pid),
    completeTree: true,
  };
}

async function killCapturedWindowsTree(
  capture: WindowsProcessTreeCapture,
  taskkillMs: number,
  forceMs: number,
): Promise<ProcessTreeKillResult> {
  const captured = [capture.root, ...capture.descendants];
  const termination = terminateCapturedWindowsProcesses(
    captured,
    taskkillMs,
    capture.completeTree,
  );
  if (!capture.completeTree) return UNKNOWN;
  if (termination.snapshot !== undefined
    && capturedWindowsProcessesGone(capture, termination.snapshot) === true) return TERMINATED;
  if (await waitForCapturedWindowsProcessesExit(capture, forceMs)) {
    return TERMINATED;
  }
  if (!termination.terminationAttempted) return UNKNOWN;
  terminateCapturedWindowsProcesses(captured, taskkillMs);
  return await waitForCapturedWindowsProcessesExit(capture, forceMs)
    ? TERMINATED
    : UNKNOWN;
}

export function retainedWindowsProcessTree(
  pid: number,
  expectedIdentity: string,
  identities: readonly WindowsProcessTreeIdentity[] | undefined,
  completeTree: boolean,
): WindowsProcessTreeCapture | undefined {
  const root = identities?.find((identity) => identity.pid === pid);
  if (root?.creationTime !== expectedIdentity || identities === undefined) {
    return undefined;
  }
  return {
    root: { ...root, parentPid: 0 },
    descendants: identities
      .filter((identity) => identity.pid !== pid && identity.creationTime !== '0')
      .map((identity) => ({ ...identity, parentPid: 0 })),
    uncertainDescendantPids: identities
      .filter((identity) => identity.pid !== pid && identity.creationTime === '0')
      .map((identity) => identity.pid),
    completeTree,
  };
}

export async function killPidTree(
  pid: number,
  options: ProcessTreeKillOptions = {},
): Promise<ProcessTreeKillResult> {
  if (process.platform === 'win32') {
    const taskkillMs = options.taskkillMs ?? DEFAULT_TASKKILL_MS;
    const forceMs = options.forceMs ?? DEFAULT_FORCE_MS;
    // Capture parent links before exact-handle termination can detach a
    // missed descendant. A failed snapshot is unknown, never equivalent to a
    // process that has been verified gone.
    const expectedIdentity = options.expectedProcessStartIdentity;
    if (expectedIdentity === undefined) return UNKNOWN;
    const retainedCapture = retainedWindowsProcessTree(
      pid,
      expectedIdentity,
      options.expectedProcessTreeIdentities,
      options.expectedProcessTreeComplete === true,
    );
    const capturedNow = captureWindowsProcessTree(pid, expectedIdentity);
    const capture = mergeWindowsProcessTreeCaptures(capturedNow, retainedCapture);
    if (capture === undefined) return UNKNOWN;
    if (capture === null) return UNKNOWN;
    return killCapturedWindowsTree(capture, taskkillMs, forceMs);
  }

  if (options.expectedProcessStartIdentity !== undefined) {
    // Node exposes only kill(pid) on POSIX. A fresh identity check would still
    // leave time for PID/PGID reuse before the signal syscall. Without a
    // retained kernel process handle, fail closed.
    return isPosixPidTreeAlive(pid) ? UNKNOWN : ALREADY_EXITED;
  }
  const forceMs = options.forceMs ?? DEFAULT_FORCE_MS;
  if (!signalPosixPidTree(pid, 'SIGTERM')) {
    return ALREADY_EXITED;
  }
  if (await waitForPosixPidTreeExit(pid, forceMs)) {
    return TERMINATED;
  }
  signalPosixPidTree(pid, 'SIGKILL');
  return await waitForPosixPidTreeExit(pid, forceMs) ? TERMINATED : UNKNOWN;
}

export function killPidTreeSync(pid: number): ProcessTreeKillResult {
  if (process.platform === 'win32') {
    // A bare PID has no durable identity and may already have been reused.
    return UNKNOWN;
  }

  signalPosixPidTree(pid, 'SIGTERM');
  signalPosixPidTree(pid, 'SIGKILL');
  return isPosixPidTreeAlive(pid) ? UNKNOWN : TERMINATED;
}

export async function killChildProcessTree(
  child: ChildProcess,
  options: ProcessTreeKillOptions = {},
): Promise<ProcessTreeKillResult> {
  const gracefulMs = options.gracefulMs ?? DEFAULT_GRACE_MS;
  const forceMs = options.forceMs ?? DEFAULT_FORCE_MS;
  const trackedWindowsCapture = process.platform === 'win32'
    ? windowsCaptureByChild.get(child)
    : undefined;
  const capturedNow = process.platform === 'win32'
    && child.pid !== undefined
    && trackedWindowsCapture !== undefined
    ? captureWindowsProcessTree(
        child.pid,
        trackedWindowsCapture.root.creationTime,
      )
    : undefined;
  const reusableWindowsCapture = mergeWindowsProcessTreeCaptures(capturedNow, trackedWindowsCapture);
  if (reusableWindowsCapture !== undefined) {
    windowsCaptureByChild.set(child, reusableWindowsCapture);
  }
  let windowsTreeResult: ProcessTreeKillResult | undefined;

  if (options.gracefulStdinEnd && !isChildProcessExited(child) && child.stdin?.writable) {
    try {
      child.stdin.end();
    } catch {
      // Fall through to forceful termination below.
    }
    if (await waitForChildProcessExit(child, gracefulMs) && process.platform !== 'win32') {
      return TERMINATED;
    }
  }

  if (child.pid !== undefined && process.platform !== 'win32') {
    if (!signalPosixPidTree(child.pid, 'SIGTERM')) {
      return ALREADY_EXITED;
    }
    if (await waitForPosixPidTreeExit(child.pid, forceMs)) {
      return TERMINATED;
    }
    signalPosixPidTree(child.pid, 'SIGKILL');
    return await waitForPosixPidTreeExit(child.pid, forceMs) ? TERMINATED : UNKNOWN;
  }

  if (isChildProcessExited(child)) {
    if (process.platform !== 'win32' || child.pid === undefined) return ALREADY_EXITED;
    if (reusableWindowsCapture === undefined) return UNKNOWN;
    if (
      !reusableWindowsCapture.completeTree
      && reusableWindowsCapture.descendants.length === 0
    ) return UNKNOWN;
    return killCapturedWindowsTree(
      reusableWindowsCapture,
      options.taskkillMs ?? DEFAULT_TASKKILL_MS,
      forceMs,
    );
  }

  if (process.platform === 'win32' && child.pid !== undefined) {
    if (reusableWindowsCapture === undefined) return UNKNOWN;
    windowsTreeResult = await killCapturedWindowsTree(
      reusableWindowsCapture,
      options.taskkillMs ?? DEFAULT_TASKKILL_MS,
      forceMs,
    );
    if (await waitForChildProcessExit(child, forceMs)) {
      return windowsTreeResult.status === 'unknown' ? UNKNOWN : TERMINATED;
    }
    return UNKNOWN;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    return isChildProcessExited(child) && windowsTreeResult?.status !== 'unknown'
      ? TERMINATED
      : UNKNOWN;
  }
  if (await waitForChildProcessExit(child, forceMs)) {
    return windowsTreeResult?.status === 'unknown' ? UNKNOWN : TERMINATED;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // Nothing else to do once the OS refuses termination.
  }
  if (!await waitForChildProcessExit(child, forceMs)) return UNKNOWN;
  return windowsTreeResult?.status === 'unknown' ? UNKNOWN : TERMINATED;
}

export function killChildProcessTreeSync(child: ChildProcess): ProcessTreeKillResult {
  if (child.pid === undefined) {
    return isChildProcessExited(child) ? ALREADY_EXITED : UNKNOWN;
  }

  if (process.platform === 'win32') {
    const tracked = windowsCaptureByChild.get(child);
    if (tracked === undefined) return UNKNOWN;
    const capture = captureWindowsProcessTree(
      child.pid,
      tracked.root.creationTime,
    );
    const reusable = mergeWindowsProcessTreeCaptures(capture, tracked) ?? tracked;
    windowsCaptureByChild.set(child, reusable);
    const termination = terminateCapturedWindowsProcesses(
      [reusable.root, ...reusable.descendants],
      DEFAULT_TASKKILL_MS,
      reusable.completeTree,
    );
    if (!reusable.completeTree) return UNKNOWN;
    if (termination.snapshot !== undefined
      && capturedWindowsProcessesGone(reusable, termination.snapshot) === true) return TERMINATED;
    return capturedWindowsProcessesGone(reusable) === true ? TERMINATED : UNKNOWN;
  }

  return killPidTreeSync(child.pid);
}
