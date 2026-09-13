import { spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { emitKodaXDiagnostic } from '../diagnostics.js';
import { getAgentConfigPath } from './agent-home.js';
import {
  captureWindowsProcessTree,
  isCurrentProcessWindowsJobContained,
  killChildProcessTree,
  killPidTree,
  mergeWindowsProcessTreeCaptures,
  rememberChildProcessTree,
  rememberedChildProcessTreeIdentities,
  rememberedChildProcessTreeIsComplete,
  retainedWindowsProcessTree,
  type WindowsProcessTreeIdentity,
} from './process-tree.js';

const REGISTRY_VERSION = 4;
const PROCESS_QUERY_TIMEOUT_MS = 5_000;

export interface ManagedChildProcessMetadata {
  readonly runtimeRunId?: string;
  readonly kind: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

export interface ManagedChildRegistrationOptions {
  /** Persist the Run's exact recovery reference before the tool reports admission. */
  readonly onRegistered?: (reference: ManagedRunChildProcessReference) => void;
  /** Keep the record until the returned cleanup callback is invoked. */
  readonly manualUnregister?: boolean;
  /** Do not let an externally mutating child start without durable recovery evidence. */
  readonly requireDurableRecord?: boolean;
}

export interface ManagedRunChildProcessReference {
  readonly runtimeRunId: string;
  readonly pid: number;
  readonly registrationId: string;
}

export type ManagedRunChildCleanupResult =
  | { readonly status: 'verified'; readonly release: () => void }
  | { readonly status: 'unknown' };

/** Missing evidence is never equivalent to a verified process-tree drain. */
export async function cleanupManagedRunChildProcess(
  reference: ManagedRunChildProcessReference,
): Promise<ManagedRunChildCleanupResult> {
  let record = readRunChildRecord(reference);
  if (record === undefined) return { status: 'unknown' };
  const active = activeChildren.get(record.pid);
  const owned = record.ownerPid === process.pid && active?.record.registrationId === record.registrationId
    && active.record.runtimeRunId === record.runtimeRunId
    && active.record.processStartIdentity === record.processStartIdentity
    && active.record.registeredAtMs === record.registeredAtMs;
  if (!owned && !runChildOwnerIsGone(record)) return { status: 'unknown' };
  if (!owned && record.processStartIdentity === undefined) return { status: 'unknown' };
  if (!owned) record = persistRunChildTree(record);
  const result = owned ? await killChildProcessTree(active.child) : await killPidTree(record.pid, {
    expectedProcessStartIdentity: record.processStartIdentity,
    expectedProcessTreeIdentities: record.processTreeIdentities,
    expectedProcessTreeComplete: record.processTreeComplete === true,
  });
  if (result.status === 'unknown') return { status: 'unknown' };
  return { status: 'verified', release: () => {
    const current = readRunChildRecord(reference);
    if (current !== undefined && current.ownerPid === record.ownerPid
      && current.ownerProcessStartIdentity === record.ownerProcessStartIdentity
      && current.processStartIdentity === record.processStartIdentity
      && current.registeredAtMs === record.registeredAtMs) {
      removeRecord(record.pid, record.registrationId);
    }
  } };
}

function persistRunChildTree(record: ManagedChildProcessRecord): ManagedChildProcessRecord {
  if (process.platform !== 'win32' || record.processStartIdentity === undefined) return record;
  const observed = captureWindowsProcessTree(record.pid, record.processStartIdentity);
  if (observed === undefined || observed === null) return record;
  const retained = retainedWindowsProcessTree(record.pid, record.processStartIdentity,
    record.processTreeIdentities, record.processTreeComplete === true);
  const captured = mergeWindowsProcessTreeCaptures(observed, retained) ?? observed;
  const updated = { ...record, processTreeComplete: captured.completeTree,
    processTreeIdentities: [
      ...[captured.root, ...captured.descendants].map(({ pid, creationTime }) => ({ pid, creationTime })),
      ...captured.uncertainDescendantPids.map((pid) => ({ pid, creationTime: '0' })),
    ],
  };
  writeRecord(updated);
  return updated;
}

function runChildOwnerIsGone(record: ManagedChildProcessRecord): boolean {
  try { process.kill(record.ownerPid, 0); }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  if (record.ownerProcessStartIdentity === undefined) return false;
  const current = processStartIdentity(record.ownerPid);
  return current !== undefined && current !== record.ownerProcessStartIdentity;
}

function readRunChildRecord(reference: ManagedRunChildProcessReference): ManagedChildProcessRecord | undefined {
  if (!Number.isSafeInteger(reference.pid) || reference.pid <= 0
    || !/^[0-9a-f-]{36}$/i.test(reference.registrationId)
    || !reference.runtimeRunId) return undefined;
  const persisted = readRecord(registryPath(reference.pid, reference.registrationId));
  if (persisted.status !== 'current' || persisted.record.pid !== reference.pid
    || persisted.record.registrationId !== reference.registrationId
    || persisted.record.runtimeRunId !== reference.runtimeRunId) return undefined;
  return persisted.record;
}

interface ManagedChildProcessRecord extends ManagedChildProcessMetadata {
  readonly version: typeof REGISTRY_VERSION;
  readonly pid: number;
  readonly ownerPid: number;
  readonly registrationId: string;
  readonly registeredAtMs: number;
  readonly ownerProcessStartIdentity?: string;
  readonly processStartIdentity?: string;
  readonly processTreeIdentities?: readonly WindowsProcessTreeIdentity[];
  readonly processTreeComplete?: boolean;
}

interface ActiveManagedChildProcess {
  readonly record: ManagedChildProcessRecord;
  readonly child: ChildProcess;
}

const activeChildren = new Map<number, ActiveManagedChildProcess>();

export interface ManagedChildCleanupSummary {
  readonly killed: number;
  readonly pruned: number;
  readonly skipped: number;
}

interface CleanupOptions {
  readonly includeCurrentOwner?: boolean;
  /** Fail when a child owned by this process cannot be verified as reclaimed. */
  readonly requireCurrentOwnerCleanup?: boolean;
  /**
   * The current process entered a Windows Job before it could spawn user code.
   * Unknown child ancestry can be retired because the Job is the authoritative
   * final process-tree boundary.
   */
  readonly currentOwnerJobContained?: boolean;
}

interface WindowsProcessInfo {
  readonly ProcessId?: number;
  readonly CreationDate?: string;
  readonly CommandLine?: string;
}

type WindowsProcessLookup =
  | { readonly status: 'found'; readonly info: WindowsProcessInfo }
  | { readonly status: 'missing' }
  | { readonly status: 'unknown' };

type PosixCommandLineLookup =
  | { readonly status: 'found'; readonly commandLine: string }
  | { readonly status: 'missing' }
  | { readonly status: 'unknown' };

function registryDir(): string {
  return getAgentConfigPath('runtime', 'processes', 'children');
}

function legacyRegistryDir(): string {
  return getAgentConfigPath('processes', 'children');
}

function verifiedLegacyRegistryDir(): string | undefined {
  const directory = legacyRegistryDir();
  const home = path.dirname(path.dirname(directory));
  try {
    const canonicalHome = realpathSync.native(home);
    let current = home;
    for (const component of ['processes', 'children']) {
      current = path.join(current, component);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Legacy managed-child path is not a physical directory: ${current}`);
      }
      const canonical = realpathSync.native(current);
      const relative = path.relative(canonicalHome, canonical);
      if (
        relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
      ) {
        throw new Error(`Legacy managed-child path escapes Agent Home: ${current}`);
      }
    }
    return directory;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    emitKodaXDiagnostic({
      source: 'agent.managed-child-processes',
      level: 'warn',
      message: 'Ignored an unsafe legacy managed-child registry path.',
      detail: { directory, error },
    });
    return undefined;
  }
}

function registryPath(pid: number, registrationId: string): string {
  return path.join(registryDir(), `${pid}.${registrationId}.json`);
}

interface ManagedChildOwnerRecord {
  readonly pid: number;
  readonly ownerPid: number;
  readonly ownerProcessStartIdentity?: string;
}

function quarantineRecord(filePath: string): boolean {
  const targetDir = path.join(registryDir(), '.unresolved');
  const target = path.join(targetDir, path.basename(filePath));
  try {
    mkdirSync(targetDir, { recursive: true });
    renameSync(filePath, target);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    emitKodaXDiagnostic({
      source: 'agent.managed-child-processes',
      level: 'warn',
      message: 'Failed to isolate unresolved managed child recovery evidence.',
      detail: { filePath, target, error },
    });
    return false;
  }
}

type ManagedChildRecordReadResult =
  | { readonly status: 'current'; readonly record: ManagedChildProcessRecord }
  | { readonly status: 'unsupported'; readonly record: ManagedChildOwnerRecord }
  | { readonly status: 'invalid' };

function writeRecord(record: ManagedChildProcessRecord): void {
  mkdirSync(registryDir(), { recursive: true });
  writeFileSync(
    registryPath(record.pid, record.registrationId),
    JSON.stringify(record),
    'utf8',
  );
}

function removeRecord(pid: number, registrationId: string): boolean {
  const active = activeChildren.get(pid);
  const file = registryPath(pid, registrationId);
  const persisted = readRecord(file);
  if (persisted.status === 'unsupported') return false;
  if (
    persisted.status === 'current'
    && persisted.record.registrationId !== registrationId
  ) {
    return false;
  }
  rmSync(file, { force: true });
  if (active?.record.registrationId === registrationId) {
    activeChildren.delete(pid);
  }
  return true;
}

function removePersistedRecord(filePath: string): boolean {
  try {
    rmSync(filePath, { force: true });
    return true;
  } catch (error: unknown) {
    emitKodaXDiagnostic({
      source: 'agent.managed-child-processes',
      level: 'warn',
      message: 'Failed to retire a persisted managed child record.',
      detail: { filePath, error },
    });
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandNeedle(command: string): string {
  return path.basename(command).toLowerCase();
}

function tokenMatches(token: string, commandLine: string): boolean {
  const haystack = commandLine.toLowerCase();
  const raw = token.toLowerCase();
  if (haystack.includes(raw)) {
    return true;
  }
  const basename = path.basename(raw);
  return basename.length > 3 && haystack.includes(basename);
}

function significantArg(arg: string): boolean {
  return arg.length > 3 && !arg.startsWith('-');
}

function commandMatches(record: ManagedChildProcessRecord, commandLine: string): boolean {
  const haystack = commandLine.toLowerCase();
  if (!tokenMatches(record.command, haystack) && !haystack.includes(commandNeedle(record.command))) {
    return false;
  }
  const args = record.args?.filter(significantArg) ?? [];
  return args.length === 0 || args.some((arg) => tokenMatches(arg, haystack));
}

function argsMatch(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function activeChildMatchesRecord(record: ManagedChildProcessRecord): boolean {
  if (record.ownerPid !== process.pid) {
    return false;
  }
  const active = activeChildren.get(record.pid);
  if (!active || active.child.exitCode !== null || active.child.signalCode !== null) {
    return false;
  }
  return active.record.registeredAtMs === record.registeredAtMs
    && active.record.registrationId === record.registrationId
    && active.record.processStartIdentity === record.processStartIdentity
    && active.record.kind === record.kind
    && active.record.command === record.command
    && argsMatch(active.record.args, record.args)
    && active.record.cwd === record.cwd;
}

function processStartIdentity(pid: number): string | undefined {
  if (process.platform === 'win32') {
    const lookup = getWindowsProcessInfo(pid);
    if (lookup.status !== 'found') return undefined;
    const creationMs = parseWindowsDate(lookup.info.CreationDate);
    return creationMs === undefined
      ? undefined
      : `windows:${(BigInt(creationMs) + 11_644_473_600_000n).toString()}`;
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
    timeout: PROCESS_QUERY_TIMEOUT_MS,
  });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return value === '' ? undefined : `${process.platform}:${value}`;
}

function managedOwnerState(
  record: ManagedChildOwnerRecord,
  readStartIdentity: (pid: number) => string | undefined,
): 'alive' | 'gone' | 'unknown' {
  if (!isPidAlive(record.ownerPid)) return 'gone';
  if (record.ownerProcessStartIdentity === undefined) return 'unknown';
  const current = readStartIdentity(record.ownerPid);
  if (current === undefined) return 'unknown';
  return current === record.ownerProcessStartIdentity ? 'alive' : 'gone';
}

function parseWindowsDate(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const dmtf = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{1,6})([+-]\d{3})/.exec(value);
  if (dmtf) {
    const [, year, month, day, hour, minute, second, micros, offset] = dmtf;
    const utcMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(micros.slice(0, 3).padEnd(3, '0')),
    );
    return utcMs - Number(offset) * 60_000;
  }
  const match = /\/Date\((\d+)\)\//.exec(value);
  if (match?.[1]) {
    return Number(match[1]);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeWmicValue(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseWmicListOutput(stdout: string): WindowsProcessInfo | undefined {
  const info: {
    ProcessId?: number;
    CreationDate?: string;
    CommandLine?: string;
  } = {};
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    const value = decodeWmicValue(line.slice(separator + 1).trim());
    if (key === 'ProcessId') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        info.ProcessId = parsed;
      }
    } else if (key === 'CreationDate') {
      info.CreationDate = value;
    } else if (key === 'CommandLine') {
      info.CommandLine = value;
    }
  }
  return info.ProcessId === undefined ? undefined : info;
}

function getWindowsProcessInfoViaWmic(pid: number): WindowsProcessLookup {
  const result = spawnSync('wmic', [
    'process',
    'where',
    `ProcessId=${pid}`,
    'get',
    'ProcessId,CreationDate,CommandLine',
    '/format:list',
  ], {
    encoding: 'utf8',
    timeout: PROCESS_QUERY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    return { status: 'unknown' };
  }
  if (result.status !== 0) {
    return { status: 'unknown' };
  }
  const info = parseWmicListOutput(result.stdout);
  return info ? { status: 'found', info } : { status: 'missing' };
}

function getWindowsProcessInfo(pid: number): WindowsProcessLookup {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    'if ($null -eq $p) { exit 0 }',
    '$p | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: PROCESS_QUERY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    return getWindowsProcessInfoViaWmic(pid);
  }
  if (result.status !== 0) {
    return getWindowsProcessInfoViaWmic(pid);
  }
  if (!result.stdout.trim()) {
    return { status: 'missing' };
  }
  try {
    return { status: 'found', info: JSON.parse(result.stdout) as WindowsProcessInfo };
  } catch {
    return getWindowsProcessInfoViaWmic(pid);
  }
}

function getPosixCommandLine(pid: number): PosixCommandLineLookup {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: PROCESS_QUERY_TIMEOUT_MS,
  });
  if (result.error) {
    return { status: 'unknown' };
  }
  if (result.status !== 0) {
    return { status: 'missing' };
  }
  const commandLine = result.stdout.trim();
  if (!commandLine) {
    return { status: 'missing' };
  }
  return { status: 'found', commandLine };
}

function isConfirmedRecord(record: ManagedChildProcessRecord): boolean | undefined {
  if (process.platform === 'win32') {
    const lookup = getWindowsProcessInfo(record.pid);
    if (lookup.status === 'unknown') {
      return undefined;
    }
    if (lookup.status === 'missing') {
      return false;
    }
    const info = lookup.info;
    if (!info?.CommandLine || !commandMatches(record, info.CommandLine)) {
      return false;
    }
    const creationMs = parseWindowsDate(info.CreationDate);
    if (creationMs === undefined || record.processStartIdentity === undefined) {
      return undefined;
    }
    const identity = (BigInt(creationMs) + 11_644_473_600_000n).toString();
    return identity === record.processStartIdentity;
  }

  const lookup = getPosixCommandLine(record.pid);
  if (lookup.status === 'unknown') {
    return undefined;
  }
  if (lookup.status === 'missing') {
    return false;
  }
  return commandMatches(record, lookup.commandLine);
}

function readRecord(filePath: string): ManagedChildRecordReadResult {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isManagedChildRecordBase(parsed)) return { status: 'invalid' };
    if (parsed.version !== REGISTRY_VERSION) {
      return Number.isSafeInteger(parsed.version)
        && typeof parsed.version === 'number'
        && parsed.version > 0
        ? {
            status: 'unsupported',
            record: {
              pid: parsed.pid,
              ownerPid: parsed.ownerPid,
              ...(typeof parsed.ownerProcessStartIdentity === 'string'
                ? { ownerProcessStartIdentity: parsed.ownerProcessStartIdentity }
                : {}),
            },
          }
        : { status: 'invalid' };
    }
    if (
      typeof parsed.registrationId !== 'string'
      || (
        parsed.args !== undefined
        && (
          !Array.isArray(parsed.args)
          || parsed.args.some((arg) => typeof arg !== 'string')
        )
      )
      || (parsed.cwd !== undefined && typeof parsed.cwd !== 'string')
      || (parsed.runtimeRunId !== undefined && typeof parsed.runtimeRunId !== 'string')
      || (
        parsed.processStartIdentity !== undefined
        && typeof parsed.processStartIdentity !== 'string'
      )
      || (
        parsed.ownerProcessStartIdentity !== undefined
        && typeof parsed.ownerProcessStartIdentity !== 'string'
      )
      || (
        parsed.processTreeComplete !== undefined
        && typeof parsed.processTreeComplete !== 'boolean'
      )
      || (
        parsed.processTreeIdentities !== undefined
        && (
          !Array.isArray(parsed.processTreeIdentities)
          || parsed.processTreeIdentities.some((identity) => (
            typeof identity !== 'object'
            || identity === null
            || typeof identity.pid !== 'number'
            || typeof identity.creationTime !== 'string'
          ))
        )
      )
    ) {
      return { status: 'invalid' };
    }
    return {
      status: 'current',
      record: parsed as unknown as ManagedChildProcessRecord,
    };
  } catch {
    return { status: 'invalid' };
  }
}

function parseWindowsProcessInfoRows(stdout: string): WindowsProcessInfo[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row): WindowsProcessInfo[] => {
      if (typeof row !== 'object' || row === null) return [];
      const candidate = row as {
        readonly ProcessId?: unknown;
        readonly CreationDate?: unknown;
        readonly CommandLine?: unknown;
      };
      if (typeof candidate.ProcessId !== 'number') return [];
      return [{
        ProcessId: candidate.ProcessId,
        ...(typeof candidate.CreationDate === 'string'
          ? { CreationDate: candidate.CreationDate }
          : {}),
        ...(typeof candidate.CommandLine === 'string'
          ? { CommandLine: candidate.CommandLine }
          : {}),
      }];
    });
  } catch {
    return undefined;
  }
}

function getWindowsProcessInfos(pids: readonly number[]): Map<number, WindowsProcessLookup> {
  const uniquePids = [...new Set(pids)];
  if (uniquePids.length === 0) return new Map();
  const script = [
    `$ids = @(${uniquePids.join(',')})`,
    '$rows = @(Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId })',
    '$rows | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: PROCESS_QUERY_TIMEOUT_MS,
    windowsHide: true,
  });
  const rows = result.error || result.status !== 0 || !result.stdout.trim()
    ? undefined
    : parseWindowsProcessInfoRows(result.stdout);
  if (rows === undefined) {
    return new Map(uniquePids.map((pid) => [pid, getWindowsProcessInfoViaWmic(pid)]));
  }
  const byPid = new Map(rows.map((info) => [info.ProcessId!, info]));
  return new Map(uniquePids.map((pid) => [
    pid,
    byPid.has(pid)
      ? { status: 'found', info: byPid.get(pid)! }
      : { status: 'missing' },
  ]));
}

function processStartIdentities(pids: readonly number[]): Map<number, string | undefined> {
  if (process.platform !== 'win32') {
    return new Map(pids.map((pid) => [pid, processStartIdentity(pid)]));
  }
  return new Map([...getWindowsProcessInfos(pids)].map(([pid, lookup]) => {
    if (lookup.status !== 'found') return [pid, undefined];
    const creationMs = parseWindowsDate(lookup.info.CreationDate);
    return [
      pid,
      creationMs === undefined
        ? undefined
        : `windows:${(BigInt(creationMs) + 11_644_473_600_000n).toString()}`,
    ];
  }));
}

function isManagedChildRecordBase(
  value: unknown,
): value is Record<string, unknown> & {
  readonly pid: number;
  readonly ownerPid: number;
  readonly registeredAtMs: number;
  readonly kind: string;
  readonly command: string;
} {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).pid === 'number'
    && typeof (value as Record<string, unknown>).ownerPid === 'number'
    && typeof (value as Record<string, unknown>).registeredAtMs === 'number'
    && typeof (value as Record<string, unknown>).kind === 'string'
    && typeof (value as Record<string, unknown>).command === 'string';
}

export function registerManagedChildProcess(
  child: ChildProcess,
  metadata: ManagedChildProcessMetadata,
  options: ManagedChildRegistrationOptions = {},
): () => void {
  const pid = child.pid;
  if (pid === undefined) {
    return () => {};
  }

  let registered = false;
  const registrationId = randomUUID();
  const unregister = (): void => {
    if (!registered) {
      return;
    }
    registered = false;
    const active = activeChildren.get(pid);
    if (
      process.platform === 'win32'
      && active?.record.registrationId === registrationId
      && (child.exitCode !== null || child.signalCode !== null)
      && active.record.processTreeComplete !== true
      && !isCurrentProcessWindowsJobContained()
    ) {
      activeChildren.delete(pid);
      return;
    }
    removeRecord(pid, registrationId);
  };

  const initialRecord: ManagedChildProcessRecord = {
    version: REGISTRY_VERSION,
    pid,
    ownerPid: process.pid,
    registrationId,
    registeredAtMs: Date.now(),
    kind: metadata.kind,
    ...(metadata.runtimeRunId === undefined ? {} : { runtimeRunId: metadata.runtimeRunId }),
    command: metadata.command,
    args: metadata.args ? [...metadata.args] : undefined,
    cwd: metadata.cwd,
  };
  activeChildren.set(pid, { record: initialRecord, child });
  registered = true;

  try {
    const rootProcessStartIdentity = rememberChildProcessTree(child);
    const ownerProcessStartIdentity = processStartIdentity(process.pid);
    const processTreeIdentities = rememberedChildProcessTreeIdentities(child);
    const record: ManagedChildProcessRecord = {
      ...initialRecord,
      ...(ownerProcessStartIdentity === undefined
        ? {}
        : { ownerProcessStartIdentity }),
      ...(rootProcessStartIdentity === undefined
        ? {}
        : { processStartIdentity: rootProcessStartIdentity }),
      ...(processTreeIdentities === undefined
        ? {}
        : { processTreeIdentities }),
      processTreeComplete: rememberedChildProcessTreeIsComplete(child),
    };
    activeChildren.set(pid, { record, child });
    writeRecord(record);
  } catch (error: unknown) {
    if (options.requireDurableRecord) {
      registered = false;
      activeChildren.delete(pid);
      throw error;
    }
    emitKodaXDiagnostic({
      source: 'agent.managed-child-processes',
      level: 'warn',
      message: 'Failed to register a managed child process.',
      detail: { pid, error },
    });
  }

  const refreshTreeRecord = (): void => {
    rememberChildProcessTree(child);
    const active = activeChildren.get(pid);
    if (!registered || active?.record.registrationId !== registrationId) return;
    const identities = rememberedChildProcessTreeIdentities(child);
    const refreshed: ManagedChildProcessRecord = {
      ...active.record,
      ...(identities === undefined ? {} : { processTreeIdentities: identities }),
      processTreeComplete: rememberedChildProcessTreeIsComplete(child),
    };
    activeChildren.set(pid, { record: refreshed, child });
    try {
      writeRecord(refreshed);
    } catch (error: unknown) {
      if (options.requireDurableRecord) {
        void killChildProcessTree(child)
          .then((outcome) => {
            if (outcome.status !== 'unknown') return;
            emitKodaXDiagnostic({
              source: 'agent.managed-child-processes',
              level: 'error',
              message: 'Managed process-tree termination could not be confirmed after a durable-record failure.',
              detail: { pid, registrationId },
            });
          })
          .catch((terminationError: unknown) => {
            emitKodaXDiagnostic({
              source: 'agent.managed-child-processes',
              level: 'error',
              message: 'Managed process-tree termination failed after a durable-record failure.',
              detail: { pid, registrationId, error: terminationError },
            });
          });
      }
      emitKodaXDiagnostic({
        source: 'agent.managed-child-processes',
        level: 'warn',
        message: 'Failed to persist refreshed managed process-tree evidence.',
        detail: { pid, registrationId, error },
      });
    }
  };
  child.on('exit', refreshTreeRecord);
  child.on('error', refreshTreeRecord);

  if (!options.manualUnregister) {
    child.once('exit', unregister);
    child.once('error', unregister);
  }
  // A failed Run-reference write must leave the exact local child recoverable.
  if (metadata.runtimeRunId !== undefined) {
    options.onRegistered?.({ runtimeRunId: metadata.runtimeRunId, pid, registrationId });
  }
  return () => {
    child.off('exit', refreshTreeRecord);
    child.off('error', refreshTreeRecord);
    if (!options.manualUnregister) {
      child.off('exit', unregister);
      child.off('error', unregister);
    }
    unregister();
  };
}

export async function cleanupRegisteredManagedChildren(
  options: CleanupOptions = {},
): Promise<ManagedChildCleanupSummary> {
  let killed = 0;
  let pruned = 0;
  let skipped = 0;
  let unresolvedCurrentOwner = 0;
  let quarantined = 0;
  const persistedRecordFiles: Array<{
    readonly file: string;
    readonly filePath: string;
    readonly current: boolean;
  }> = [];
  const registryReadErrors: Error[] = [];
  const skip = (ownerPid?: number): void => {
    skipped += 1;
    if (ownerPid === process.pid) unresolvedCurrentOwner += 1;
  };

  const activeSummary = await cleanupActiveCurrentOwnerChildren(options);
  killed += activeSummary.killed;
  pruned += activeSummary.pruned;
  skipped += activeSummary.skipped;
  unresolvedCurrentOwner += activeSummary.unresolved;

  const legacyDirectory = verifiedLegacyRegistryDir();
  const registrySources = [
    { directory: registryDir(), current: true },
    ...(legacyDirectory === undefined
      ? []
      : [{ directory: legacyDirectory, current: false }]),
  ];
  for (const source of registrySources) {
    try {
      persistedRecordFiles.push(...readdirSync(source.directory)
        .filter((file) => file.endsWith('.json'))
        .map((file) => ({
          file,
          filePath: path.join(source.directory, file),
          current: source.current,
        })));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        registryReadErrors.push(new Error(
          `Managed child registry is unreadable: ${source.directory}`,
          { cause: error },
        ));
      }
    }
  }

  const persistedFiles = persistedRecordFiles
    .filter(({ current, file }) => !current || !activeSummary.processedFiles.has(file))
    .map(({ filePath, current }) => ({
      filePath,
      current,
      persisted: readRecord(filePath),
    }));
  const ownerPids = persistedFiles.flatMap(({ persisted }) => (
    persisted.status !== 'invalid'
    && isPidAlive(persisted.record.ownerPid)
      ? [persisted.record.ownerPid]
      : []
  ));
  // Resolve all live owners at one cleanup boundary. On Windows this is one
  // CIM snapshot even when stale records belong to several former KodaX PIDs.
  const ownerStartIdentities = processStartIdentities(ownerPids);
  const readOwnerStartIdentity = (pid: number): string | undefined => (
    ownerStartIdentities.get(pid)
  );

  for (const { filePath, current, persisted } of persistedFiles) {
    if (!current) {
      if (persisted.status === 'invalid') {
        if (removePersistedRecord(filePath)) pruned += 1;
        else skip();
        continue;
      }
      if (quarantineRecord(filePath)) quarantined += 1;
      skip(persisted.record.ownerPid);
      continue;
    }
    if (persisted.status === 'unsupported') {
      if (
        process.platform === 'win32'
        && options.currentOwnerJobContained === true
        && persisted.record.ownerPid === process.pid
      ) {
        rmSync(filePath, { force: true });
        pruned += 1;
        continue;
      }
      const ownerState = managedOwnerState(
        persisted.record,
        readOwnerStartIdentity,
      );
      if (ownerState === 'gone' && !isPidAlive(persisted.record.pid)) {
        if (quarantineRecord(filePath)) quarantined += 1;
      }
      skip(persisted.record.ownerPid);
      continue;
    }
    if (persisted.status === 'invalid') {
      rmSync(filePath, { force: true });
      pruned += 1;
      continue;
    }
    const record = persisted.record;

    if (
      process.platform === 'win32'
      && options.currentOwnerJobContained === true
      && record.ownerPid === process.pid
    ) {
      if (removePersistedRecord(filePath)) pruned += 1;
      else skip(record.ownerPid);
      continue;
    }

    if (!options.includeCurrentOwner && record.ownerPid === process.pid) {
      const currentOwnerIdentity = readOwnerStartIdentity(process.pid);
      if (
        record.ownerProcessStartIdentity === undefined
        || currentOwnerIdentity === undefined
        || record.ownerProcessStartIdentity === currentOwnerIdentity
      ) {
        skip(record.ownerPid);
        continue;
      }
    }

    if (record.ownerPid !== process.pid) {
      const ownerState = managedOwnerState(record, readOwnerStartIdentity);
      if (ownerState !== 'gone') {
        skip(record.ownerPid);
        continue;
      }
    }

    const rootWasAlive = isPidAlive(record.pid);
    if (!rootWasAlive) {
      if (process.platform !== 'win32') {
        if (removePersistedRecord(filePath)) pruned += 1;
        else skip(record.ownerPid);
        continue;
      }
      const retainedRoot = record.processTreeIdentities?.find(
        (identity) => identity.pid === record.pid,
      );
      if (
        record.processStartIdentity === undefined
        || retainedRoot?.creationTime !== record.processStartIdentity
      ) {
        if (quarantineRecord(filePath)) quarantined += 1;
        skip(record.ownerPid);
        continue;
      }
    }

    const confirmed = !rootWasAlive
      ? true
      : activeChildMatchesRecord(record) ? true : isConfirmedRecord(record);
    if (confirmed === undefined) {
      skip(record.ownerPid);
      continue;
    }

    if (!confirmed) {
      if (process.platform !== 'win32') {
        if (removePersistedRecord(filePath)) pruned += 1;
        else skip(record.ownerPid);
        continue;
      }
      const retainedRoot = record.processTreeIdentities?.find(
        (identity) => identity.pid === record.pid,
      );
      if (
        record.processStartIdentity === undefined
        || retainedRoot?.creationTime !== record.processStartIdentity
      ) {
        if (quarantineRecord(filePath)) quarantined += 1;
        skip(record.ownerPid);
        continue;
      }
    }

    const result = await killPidTree(record.pid, {
      ...(record.processStartIdentity === undefined
        ? {}
        : { expectedProcessStartIdentity: record.processStartIdentity }),
      ...(record.processTreeIdentities === undefined
        ? {}
        : { expectedProcessTreeIdentities: record.processTreeIdentities }),
      expectedProcessTreeComplete: record.processTreeComplete === true,
    });
    if (result.status !== 'unknown') {
      if (removePersistedRecord(filePath)) {
        killed += 1;
      } else {
        skip(record.ownerPid);
      }
    } else {
      if (
        process.platform === 'win32'
        && (!rootWasAlive || confirmed === false)
        && quarantineRecord(filePath)
      ) quarantined += 1;
      skip(record.ownerPid);
    }
  }

  if (quarantined > 0) {
    emitKodaXDiagnostic({
      source: 'agent.managed-child-processes',
      level: 'warn',
      message: `Isolated ${quarantined} unresolved managed child record(s) from startup cleanup.`,
      detail: { quarantined, directory: path.join(registryDir(), '.unresolved') },
    });
  }

  if (options.requireCurrentOwnerCleanup === true) {
    const errors: Error[] = [];
    errors.push(...registryReadErrors);
    if (unresolvedCurrentOwner > 0) {
      errors.push(new Error(
        `Managed child cleanup could not verify ${unresolvedCurrentOwner} current-owner process tree(s).`,
      ));
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Managed child final cleanup failed because registry evidence is unreadable or unresolved.',
      );
    }
  }

  return { killed, pruned, skipped };
}

async function cleanupActiveCurrentOwnerChildren(
  options: CleanupOptions,
): Promise<{
  readonly killed: number;
  readonly pruned: number;
  readonly skipped: number;
  readonly unresolved: number;
  readonly processedFiles: ReadonlySet<string>;
}> {
  if (options.includeCurrentOwner !== true) {
    return { killed: 0, pruned: 0, skipped: 0, unresolved: 0, processedFiles: new Set() };
  }
  let killed = 0;
  let pruned = 0;
  let skipped = 0;
  let unresolved = 0;
  const processedFiles = new Set<string>();
  const records = [...activeChildren.values()]
    .filter(({ record }) => record.ownerPid === process.pid);
  for (const { record } of records) {
    processedFiles.add(path.basename(registryPath(record.pid, record.registrationId)));
    if (
      process.platform === 'win32'
      && options.currentOwnerJobContained === true
    ) {
      if (removeRecord(record.pid, record.registrationId)) pruned += 1;
      else {
        skipped += 1;
        unresolved += 1;
      }
      continue;
    }
    try {
      const result = await killPidTree(record.pid, {
        ...(record.processStartIdentity === undefined
          ? {}
          : { expectedProcessStartIdentity: record.processStartIdentity }),
        ...(record.processTreeIdentities === undefined
          ? {}
          : { expectedProcessTreeIdentities: record.processTreeIdentities }),
        expectedProcessTreeComplete: record.processTreeComplete === true,
      });
      if (result.status === 'unknown' || !removeRecord(record.pid, record.registrationId)) {
        skipped += 1;
        unresolved += 1;
      } else {
        killed += 1;
      }
    } catch (error: unknown) {
      emitKodaXDiagnostic({
        source: 'agent.managed-child-processes',
        level: 'warn',
        message: 'Failed to reclaim an active current-owner managed child.',
        detail: { pid: record.pid, error },
      });
      skipped += 1;
      unresolved += 1;
    }
  }
  return { killed, pruned, skipped, unresolved, processedFiles };
}
