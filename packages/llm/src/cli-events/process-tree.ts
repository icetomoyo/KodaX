import { spawnSync, type ChildProcess } from 'node:child_process';

// Keep Windows snapshot, identity-fence, and termination semantics in sync with
// packages/agent/src/runtime/process-tree.ts. Public exports and timeout
// plumbing intentionally differ because @kodax-ai/llm stays dependency-light.

const TASKKILL_TIMEOUT_MS = 2_000;
const FORCE_WAIT_MS = 2_000;
const NATIVE_SNAPSHOT_TIMEOUT_MS = 5_000;
export type ProcessTreeKillStatus = 'terminated' | 'already-exited' | 'unknown';

export interface ProcessTreeKillResult {
  readonly status: ProcessTreeKillStatus;
}

const TERMINATED: ProcessTreeKillResult = Object.freeze({ status: 'terminated' });
const ALREADY_EXITED: ProcessTreeKillResult = Object.freeze({ status: 'already-exited' });
const UNKNOWN: ProcessTreeKillResult = Object.freeze({ status: 'unknown' });
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

function isExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isExited(child)) {
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
    // Child may not be a process-group leader; fall back to direct PID.
  }

  try {
    process.kill(pid, signal);
    signaled = true;
  } catch {
    // It may already be gone after the process-group signal.
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
    await new Promise(resolve => setTimeout(resolve, 50));
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
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: NATIVE_SNAPSHOT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (!result.error && result.status === 0) {
    const snapshot = parseWindowsProcessSnapshotJson(result.stdout);
    if (snapshot.length > 0) return snapshot;
  }

  const cutoffUnixMs = Date.now();
  const wmic = spawnSync('wmic', [
    'process',
    'get',
    'CreationDate,ParentProcessId,ProcessId',
    '/format:list',
  ], {
    encoding: 'utf8',
    timeout: NATIVE_SNAPSHOT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (wmic.error || wmic.status !== 0) return undefined;
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
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: NATIVE_SNAPSHOT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return undefined;
  return parseWindowsNativeProcessRows(result.stdout);
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

function readWindowsProcessSnapshot(): WindowsProcessIdentity[] | undefined {
  const nativeSnapshot = readWindowsProcessSnapshotNative();
  return nativeSnapshot ?? readWindowsProcessSnapshotFallback();
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
    await new Promise(resolve => setTimeout(resolve, 50));
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
    timeout: TASKKILL_TIMEOUT_MS,
    windowsHide: true,
  });
  return readWindowsTerminationResult(result.stdout ?? '', !result.error && result.status === 0);
}

interface WindowsProcessTreeCapture {
  readonly root: WindowsProcessIdentity;
  readonly descendants: readonly WindowsProcessIdentity[];
  readonly uncertainDescendantPids: readonly number[];
  readonly completeTree: boolean;
}

const windowsCaptureByChild = new WeakMap<ChildProcess, WindowsProcessTreeCapture>();

export function rememberChildProcessTree(child: ChildProcess): string | undefined {
  if (
    process.platform !== 'win32'
    || child.pid === undefined
  ) return undefined;
  const tracked = windowsCaptureByChild.get(child);
  const snapshot = readWindowsProcessSnapshot();
  if (tracked !== undefined && isExited(child)) {
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
    windowsCaptureByChild.set(child, {
      root: tracked.root,
      descendants: descendants.filter((identity) => identity.creationTime !== '0'),
      uncertainDescendantPids: descendants
        .filter((identity) => identity.creationTime === '0')
        .map((identity) => identity.pid),
      completeTree: tracked.completeTree,
    });
    return tracked.root.creationTime;
  }
  let root = snapshot?.find((identity) => (
    identity.pid === child.pid && identity.creationTime !== '0'
  ));
  if (root === undefined && snapshot !== undefined && !isExited(child)) {
    root = readWindowsProcessSnapshot()?.find((identity) => (
      identity.pid === child.pid && identity.creationTime !== '0'
    ));
  }
  if (root === undefined || isExited(child)) return undefined;
  windowsCaptureByChild.set(child, {
    root,
    descendants: [],
    uncertainDescendantPids: [],
    completeTree: false,
  });
  return root.creationTime;
}

function captureWindowsProcessTree(
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
  const descendants = collectDescendantIdentities(snapshot, pid, root.creationTime);
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
): Promise<ProcessTreeKillResult> {
  const captured = [capture.root, ...capture.descendants];
  const termination = terminateCapturedWindowsProcesses(captured, capture.completeTree);
  if (!capture.completeTree) return UNKNOWN;
  if (termination.snapshot !== undefined
    && capturedWindowsProcessesGone(capture, termination.snapshot) === true) return TERMINATED;
  if (await waitForCapturedWindowsProcessesExit(capture, FORCE_WAIT_MS)) {
    return TERMINATED;
  }
  if (!termination.terminationAttempted) return UNKNOWN;
  terminateCapturedWindowsProcesses(captured);
  return await waitForCapturedWindowsProcessesExit(capture, FORCE_WAIT_MS)
    ? TERMINATED
    : UNKNOWN;
}

export async function killChildProcessTree(child: ChildProcess): Promise<ProcessTreeKillResult> {
  let windowsTreeResult: ProcessTreeKillResult | undefined;
  if (process.platform === 'win32' && child.pid !== undefined) {
    const tracked = windowsCaptureByChild.get(child);
    const capture = tracked === undefined
      ? undefined
      : captureWindowsProcessTree(child.pid, tracked.root.creationTime);
    if (capture !== undefined && capture !== null) {
      windowsCaptureByChild.set(child, capture);
    }
    const reusable = capture ?? tracked;
    if (capture === undefined && reusable === undefined) return UNKNOWN;
    if (
      isExited(child)
      && reusable !== undefined
      && !reusable.completeTree
      && reusable.descendants.length === 0
    ) {
      return UNKNOWN;
    }
    windowsTreeResult = capture === undefined
      ? (reusable === undefined
          ? UNKNOWN
          : await killCapturedWindowsTree(reusable))
      : capture === null
        ? (reusable === undefined
            ? UNKNOWN
            : await killCapturedWindowsTree(reusable))
        : await killCapturedWindowsTree(capture);
    if (await waitForExit(child, FORCE_WAIT_MS)) {
      return windowsTreeResult.status === 'unknown' ? UNKNOWN : TERMINATED;
    }
    return UNKNOWN;
  }

  if (child.pid !== undefined && process.platform !== 'win32') {
    if (!signalPosixPidTree(child.pid, 'SIGTERM')) {
      return ALREADY_EXITED;
    }
    if (await waitForPosixPidTreeExit(child.pid, FORCE_WAIT_MS)) {
      return TERMINATED;
    }
    signalPosixPidTree(child.pid, 'SIGKILL');
    return await waitForPosixPidTreeExit(child.pid, FORCE_WAIT_MS)
      ? TERMINATED
      : UNKNOWN;
  }

  if (isExited(child)) {
    return process.platform === 'win32' && child.pid !== undefined
      ? UNKNOWN
      : ALREADY_EXITED;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    return isExited(child) && windowsTreeResult?.status !== 'unknown'
      ? TERMINATED
      : UNKNOWN;
  }
  if (await waitForExit(child, FORCE_WAIT_MS)) {
    return windowsTreeResult?.status === 'unknown' ? UNKNOWN : TERMINATED;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // Best-effort cleanup.
  }
  if (!await waitForExit(child, FORCE_WAIT_MS)) return UNKNOWN;
  return windowsTreeResult?.status === 'unknown' ? UNKNOWN : TERMINATED;
}
