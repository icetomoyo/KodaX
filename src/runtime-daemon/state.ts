import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

import { readProcessStartIdentity } from '@kodax-ai/agent';

let currentProcessStartIdentity: string | undefined;
let currentProcessStartIdentityRead = false;

export type RuntimeDaemonStatus =
  | 'starting'
  | 'ready'
  | 'draining'
  | 'stopping'
  | 'unhealthy'
  | 'crashed';

export interface RuntimeDaemonState {
  readonly runtimeId: string;
  readonly profile: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly endpoint: string;
  readonly version: string;
  readonly status: RuntimeDaemonStatus;
  /** Absent only on state written by a pre-binding daemon. */
  readonly configHome?: string;
  readonly lastError?: string;
}

export type RuntimeDaemonLogLevel = 'info' | 'warn' | 'error';

export interface RuntimeDaemonLogEntry {
  readonly time: string;
  readonly level: RuntimeDaemonLogLevel;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface RuntimeDaemonShutdownOutcome {
  readonly version: 1;
  readonly runtimeId: string;
  readonly pid: number;
  readonly status: 'succeeded' | 'failed';
  readonly completedAt: string;
  readonly error?: string;
}

export interface RuntimeDaemonShutdownIdentity {
  readonly runtimeId: string;
  readonly pid: number;
}

export interface RuntimeDaemonPaths {
  readonly profile: string;
  readonly configHome: string;
  readonly rootDir: string;
  readonly stateFile: string;
  readonly lockFile: string;
  readonly tokenFile: string;
  readonly logFile: string;
  readonly runsDir: string;
  readonly eventsDir: string;
  readonly ownerPolicyFile: string;
  readonly ownerPolicyLockFile: string;
}

export interface RuntimeDaemonLockOwner {
  readonly runtimeId: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly kind?: 'daemon' | 'inline';
  /** OS-issued identity used to distinguish a live owner from PID reuse. */
  readonly processStartIdentity?: string;
  /** Present when the daemon was assigned to a Windows Job before user code could start. */
  readonly processContainment?: 'windows-job';
  /** Process outside the Job whose exit proves that the Job became empty. */
  readonly supervisorPid?: number;
  /** OS-issued identity that distinguishes the original supervisor from PID reuse. */
  readonly supervisorProcessStartIdentity?: string;
}

export interface RuntimeOwnerPolicy {
  readonly mode: 'daemon' | 'inline';
  readonly revision: number;
  readonly updatedAt: string;
}

export interface RuntimeDaemonLockHandle {
  readonly file: string;
  readonly owner: RuntimeDaemonLockOwner;
}

export function readRuntimeOwnerProcessStartIdentity(pid: number): string | undefined {
  if (pid !== process.pid) return readProcessStartIdentity(pid);
  if (!currentProcessStartIdentityRead) {
    currentProcessStartIdentity = readProcessStartIdentity(pid);
    currentProcessStartIdentityRead = true;
  }
  return currentProcessStartIdentity;
}

export type RuntimeDaemonHealth =
  | 'missing'
  | 'healthy'
  | 'stale'
  | 'unhealthy'
  | 'mismatch';

export interface RuntimeDaemonHealthObservation {
  readonly state?: RuntimeDaemonState;
  /** Authenticated probe handshake; lets the SDK gate capabilities before a client attach. */
  readonly initialization?: unknown;
  readonly pidAlive: boolean;
  readonly endpointReachable: boolean;
  readonly identityMatches: boolean;
  readonly lockOwnerPidAlive?: boolean;
  readonly observedLockOwner?: RuntimeDaemonLockOwner;
}

interface RuntimeOwnerCoordinationHandle {
  readonly nonce: string;
  readonly owner: RuntimeDaemonLockOwner;
}

export type RuntimeDaemonOwnershipDecision =
  | {
      readonly kind: 'attach';
      readonly state: RuntimeDaemonState;
      readonly health: 'healthy';
    }
  | {
      readonly kind: 'claim';
      readonly lock: RuntimeDaemonLockHandle;
      readonly health: 'missing' | 'stale';
    }
  | {
      readonly kind: 'wait';
      readonly lockOwner: RuntimeDaemonLockOwner;
      readonly state?: RuntimeDaemonState;
      readonly health: 'missing' | 'stale';
    }
  | {
      readonly kind: 'unhealthy';
      readonly health: 'unhealthy' | 'mismatch';
      readonly state?: RuntimeDaemonState;
      readonly lockOwner?: RuntimeDaemonLockOwner;
    };

export function resolveRuntimeDaemonPaths(
  homeDir: string,
  profile = 'default',
): RuntimeDaemonPaths {
  return resolveRuntimeDaemonPathsFromConfigHome(path.join(path.resolve(homeDir), '.kodax'), profile);
}

export function resolveRuntimeDaemonPathsFromConfigHome(
  configHome: string,
  profile = 'default',
): RuntimeDaemonPaths {
  const normalizedProfile = normalizeRuntimeDaemonProfile(profile);
  const resolvedConfigHome = path.resolve(configHome);
  const rootDir = path.join(resolvedConfigHome, 'runtime', 'daemon', normalizedProfile);
  return {
    profile: normalizedProfile,
    configHome: resolvedConfigHome,
    rootDir,
    stateFile: path.join(rootDir, 'daemon.json'),
    lockFile: path.join(rootDir, 'daemon.lock'),
    tokenFile: path.join(rootDir, 'daemon.token'),
    logFile: path.join(rootDir, 'daemon.log'),
    runsDir: path.join(rootDir, 'runs'),
    eventsDir: path.join(rootDir, 'events'),
    ownerPolicyFile: path.join(rootDir, 'owner-policy.json'),
    ownerPolicyLockFile: path.join(rootDir, 'owner-policy.lock'),
  };
}

export function isSameRuntimeDaemonPath(left: string, right: string): boolean {
  const resolveIdentity = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return resolveIdentity(left) === resolveIdentity(right);
}

export function resolveRuntimeDaemonEndpointScope(
  homeDir: string,
  configHome: string,
): string {
  const resolvedHome = path.resolve(homeDir);
  return isSameRuntimeDaemonPath(configHome, path.join(resolvedHome, '.kodax'))
    ? resolvedHome
    : path.resolve(configHome);
}

export function readRuntimeOwnerPolicy(paths: RuntimeDaemonPaths): RuntimeOwnerPolicy {
  if (!fs.existsSync(paths.ownerPolicyFile)) {
    return { mode: 'daemon', revision: 0, updatedAt: new Date(0).toISOString() };
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(paths.ownerPolicyFile, 'utf8'));
    if (
      isRecord(parsed)
      && (parsed.mode === 'daemon' || parsed.mode === 'inline')
      && typeof parsed.revision === 'number'
      && Number.isSafeInteger(parsed.revision)
      && parsed.revision >= 0
      && typeof parsed.updatedAt === 'string'
    ) {
      return {
        mode: parsed.mode,
        revision: parsed.revision,
        updatedAt: parsed.updatedAt,
      };
    }
  } catch {
    // Fail closed below: a corrupt policy must not enable a competing daemon.
  }
  throw new Error('Runtime owner policy is corrupt; refusing to choose an owner.');
}

export function updateRuntimeOwnerPolicy(
  paths: RuntimeDaemonPaths,
  mode: RuntimeOwnerPolicy['mode'],
  expectedRevision: number,
): RuntimeOwnerPolicy {
  ensureRuntimeDaemonDirectories(paths);
  const coordination = tryAcquireRuntimeOwnerCoordination(paths);
  if (!coordination) throw new Error('Runtime owner policy update is already in progress.');
  try {
    if (fs.existsSync(paths.lockFile)) {
      throw new Error('Cannot change Runtime owner mode while an owner lock exists.');
    }
    return writeRuntimeOwnerPolicy(paths, mode, expectedRevision, coordination.nonce);
  } finally {
    releaseRuntimeOwnerCoordination(paths, coordination);
  }
}

/** Enable daemon ownership, reclaiming only a provably abandoned inline fence. */
export function enableRuntimeDaemonOwner(paths: RuntimeDaemonPaths): RuntimeOwnerPolicy {
  ensureRuntimeDaemonDirectories(paths);
  const coordination = tryAcquireRuntimeOwnerCoordination(paths);
  if (!coordination) throw new Error('Runtime owner transition is already in progress.');
  try {
    const current = readRuntimeOwnerPolicy(paths);
    if (current.mode === 'daemon') return current;
    const owner = readRuntimeDaemonLockOwner(paths.lockFile);
    if (owner === undefined && fs.existsSync(paths.lockFile)) {
      throw new Error('Cannot enable Runtime daemon ownership because the owner lock is unreadable.');
    }
    if (owner !== undefined) {
      if (owner.kind !== 'inline') {
        throw new Error(
          `Cannot enable Runtime daemon ownership while a ${owner.kind ?? 'legacy'} owner lock exists.`,
        );
      }
      const ownerProcessState = runtimeOwnerProcessState(owner);
      if (ownerProcessState === 'alive') {
        throw new Error('Cannot enable Runtime daemon ownership while the inline owner is active.');
      }
      if (ownerProcessState === 'unknown') {
        throw new Error(
          'Cannot enable Runtime daemon ownership because inline owner liveness could not be verified.',
        );
      }
      if (!unlinkRuntimeDaemonLockIfOwned({ file: paths.lockFile, owner })) {
        throw new Error('Cannot enable Runtime daemon ownership because the inline owner changed.');
      }
    }
    return writeRuntimeOwnerPolicy(
      paths,
      'daemon',
      current.revision,
      coordination.nonce,
    );
  } finally {
    releaseRuntimeOwnerCoordination(paths, coordination);
  }
}

export function acquireRuntimeInlineOwner(
  paths: RuntimeDaemonPaths,
  owner: RuntimeDaemonLockOwner,
  enableRollback = false,
): RuntimeDaemonLockHandle {
  ensureRuntimeDaemonDirectories(paths);
  const coordination = tryAcquireRuntimeOwnerCoordination(paths);
  if (!coordination) throw new Error('Runtime owner transition is already in progress.');
  try {
    const current = readRuntimeOwnerPolicy(paths);
    if (current.mode !== 'inline') {
      if (!enableRollback) {
        throw new Error('Coder inline ownership requires explicit enableRollback: true.');
      }
      if (fs.existsSync(paths.lockFile)) {
        throw new Error('Cannot enable inline rollback while a Coder owner lock exists.');
      }
      writeRuntimeOwnerPolicy(paths, 'inline', current.revision, coordination.nonce);
    }
    if (fs.existsSync(paths.lockFile)) {
      throw new Error(`Coder profile "${paths.profile}" already has an owner.`);
    }
    const lock = tryAcquireRuntimeDaemonLock(paths, owner);
    if (!lock) throw new Error(`Coder profile "${paths.profile}" already has an owner.`);
    return lock;
  } finally {
    releaseRuntimeOwnerCoordination(paths, coordination);
  }
}

function writeRuntimeOwnerPolicy(
  paths: RuntimeDaemonPaths,
  mode: RuntimeOwnerPolicy['mode'],
  expectedRevision: number,
  nonce: string,
): RuntimeOwnerPolicy {
  const current = readRuntimeOwnerPolicy(paths);
  if (current.revision !== expectedRevision) {
    throw runtimeOwnerPolicyConflict(
      `Runtime owner policy conflict: expected ${expectedRevision}, current ${current.revision}.`,
    );
  }
  const updated: RuntimeOwnerPolicy = {
    mode,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${paths.ownerPolicyFile}.${process.pid}.${nonce}.tmp`;
  try {
    const policyFd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(policyFd, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      fs.fsyncSync(policyFd);
    } finally {
      fs.closeSync(policyFd);
    }
    fs.renameSync(temporary, paths.ownerPolicyFile);
    return updated;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function runtimeOwnerPolicyConflict(
  message: string,
): Error & { readonly code: 'conflict' } {
  const error = new Error(message) as Error & { code: 'conflict' };
  error.code = 'conflict';
  return error;
}

function tryAcquireRuntimeOwnerCoordination(
  paths: Pick<RuntimeDaemonPaths, 'ownerPolicyLockFile'>,
  recoverAbandoned = true,
): RuntimeOwnerCoordinationHandle | undefined {
  const nonce = randomUUID();
  const processStartIdentity = readRuntimeOwnerProcessStartIdentity(process.pid);
  const owner: RuntimeDaemonLockOwner = {
    runtimeId: `owner-transition-${nonce}`,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
  };
  let fd: number | undefined;
  try {
    fd = fs.openSync(paths.ownerPolicyLockFile, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ ...owner, nonce })}\n`, 'utf8');
    fs.fsyncSync(fd);
    return { nonce, owner };
  } catch (error: unknown) {
    if (isNodeFileError(error) && error.code === 'EEXIST') {
      if (recoverAbandoned && removeAbandonedRuntimeOwnerCoordination(paths)) {
        return tryAcquireRuntimeOwnerCoordination(paths, false);
      }
      return undefined;
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function removeAbandonedRuntimeOwnerCoordination(
  paths: Pick<RuntimeDaemonPaths, 'ownerPolicyLockFile'>,
): boolean {
  const current = readRuntimeOwnerCoordinationHandle(paths);
  if (!current || runtimeOwnerProcessState(current.owner) !== 'gone') return false;
  try {
    const latest = readRuntimeOwnerCoordinationHandle(paths);
    if (!latest || latest.nonce !== current.nonce) return false;
    fs.unlinkSync(paths.ownerPolicyLockFile);
    return true;
  } catch {
    return false;
  }
}

function readRuntimeOwnerCoordinationHandle(
  paths: Pick<RuntimeDaemonPaths, 'ownerPolicyLockFile'>,
): RuntimeOwnerCoordinationHandle | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(paths.ownerPolicyLockFile, 'utf8'));
    if (
      !isRecord(parsed)
      || typeof parsed.nonce !== 'string'
      || !isRuntimeDaemonLockOwner(parsed)
      || !parsed.runtimeId.startsWith('owner-transition-')
    ) return undefined;
    return { nonce: parsed.nonce, owner: parsed };
  } catch {
    return undefined;
  }
}

function readRuntimeOwnerCoordinator(paths: RuntimeDaemonPaths): RuntimeDaemonLockOwner | undefined {
  return readRuntimeDaemonLockOwner(paths.ownerPolicyLockFile);
}

function releaseRuntimeOwnerCoordination(
  paths: Pick<RuntimeDaemonPaths, 'ownerPolicyLockFile'>,
  handle: RuntimeOwnerCoordinationHandle,
): void {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(paths.ownerPolicyLockFile, 'utf8'));
    if (isRecord(parsed) && parsed.nonce === handle.nonce) {
      fs.unlinkSync(paths.ownerPolicyLockFile);
    }
  } catch {
    // A missing or replaced coordinator is not ours to remove.
  }
}

export function assertRuntimeDaemonOwnerAllowed(paths: RuntimeDaemonPaths): void {
  if (readRuntimeOwnerPolicy(paths).mode !== 'daemon') {
    throw new Error(`Runtime daemon auto-start is disabled for profile "${paths.profile}" by inline rollback policy.`);
  }
}

export function normalizeRuntimeDaemonProfile(profile: string): string {
  const trimmed = profile.trim() || 'default';
  if (trimmed === '.' || trimmed === '..' || !/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error(`Invalid runtime daemon profile: ${profile}`);
  }
  return trimmed;
}

export function ensureRuntimeDaemonDirectories(paths: RuntimeDaemonPaths): void {
  fs.mkdirSync(paths.rootDir, { recursive: true });
  fs.mkdirSync(paths.runsDir, { recursive: true });
  fs.mkdirSync(paths.eventsDir, { recursive: true });
}

export function createRuntimeDaemonToken(): string {
  return `dt_${randomUUID().replace(/-/g, '')}`;
}

export function writeRuntimeDaemonToken(paths: RuntimeDaemonPaths, token: string): void {
  ensureRuntimeDaemonDirectories(paths);
  fs.writeFileSync(paths.tokenFile, `${token}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (process.platform !== 'win32') {
    fs.chmodSync(paths.tokenFile, 0o600);
  }
}

export function readRuntimeDaemonToken(paths: RuntimeDaemonPaths): string | undefined {
  try {
    const token = fs.readFileSync(paths.tokenFile, 'utf8').trim();
    return token.length > 0 ? token : undefined;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function writeRuntimeDaemonState(
  paths: RuntimeDaemonPaths,
  state: RuntimeDaemonState,
): void {
  ensureRuntimeDaemonDirectories(paths);
  const temporary = `${paths.stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Windows readers/AV may briefly deny replacement. Keep the same fsynced
    // staging file and atomic rename; five attempts wait at most 200 ms.
    for (let attempt = 1; ; attempt += 1) {
      try {
        fs.renameSync(temporary, paths.stateFile);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || attempt >= 5 ||
            !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 20);
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function appendRuntimeDaemonLog(
  paths: RuntimeDaemonPaths,
  level: RuntimeDaemonLogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  ensureRuntimeDaemonDirectories(paths);
  const entry: RuntimeDaemonLogEntry = {
    time: new Date().toISOString(),
    level,
    message,
    ...(data !== undefined ? { data } : {}),
  };
  fs.appendFileSync(paths.logFile, `${JSON.stringify(entry)}\n`, 'utf8');
}

export function readRuntimeDaemonLog(
  paths: RuntimeDaemonPaths,
  limit = 200,
): readonly RuntimeDaemonLogEntry[] {
  if (!fs.existsSync(paths.logFile)) return [];
  const entries: RuntimeDaemonLogEntry[] = [];
  const lines = fs.readFileSync(paths.logFile, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines.slice(-limit)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRuntimeDaemonLogEntry(parsed)) entries.push(parsed);
    } catch (error: unknown) {
      entries.push({
        time: new Date().toISOString(),
        level: 'warn',
        message: `Skipped malformed daemon log line: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return entries;
}

export function readRuntimeDaemonState(paths: RuntimeDaemonPaths): RuntimeDaemonState | undefined {
  if (!fs.existsSync(paths.stateFile)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as unknown;
    return isRuntimeDaemonState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type RuntimeOwnerProcessState = 'alive' | 'gone' | 'unknown';

function runtimeOwnerProcessState(owner: RuntimeDaemonLockOwner): RuntimeOwnerProcessState {
  try {
    process.kill(owner.pid, 0);
  } catch (error: unknown) {
    return isNodeFileError(error) && error.code === 'ESRCH' ? 'gone' : 'unknown';
  }
  if (owner.processStartIdentity === undefined) return 'alive';
  const currentIdentity = readRuntimeOwnerProcessStartIdentity(owner.pid);
  if (currentIdentity === undefined) return 'unknown';
  return currentIdentity === owner.processStartIdentity ? 'alive' : 'gone';
}

const MAX_RETAINED_SHUTDOWN_OUTCOMES = 32;

function runtimeDaemonShutdownOutcomePath(
  paths: RuntimeDaemonPaths,
  identity: RuntimeDaemonShutdownIdentity,
): string {
  return path.join(
    paths.rootDir,
    `shutdown-outcome.${encodeURIComponent(identity.runtimeId)}.${identity.pid}.json`,
  );
}

export function writeRuntimeDaemonShutdownOutcome(
  paths: RuntimeDaemonPaths,
  outcome: RuntimeDaemonShutdownOutcome,
): readonly Error[] {
  ensureRuntimeDaemonDirectories(paths);
  const target = runtimeDaemonShutdownOutcomePath(paths, outcome);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(outcome, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return pruneRuntimeDaemonShutdownOutcomes(paths, target);
}

function pruneRuntimeDaemonShutdownOutcomes(
  paths: RuntimeDaemonPaths,
  preservedPath: string,
): readonly Error[] {
  const failures: Error[] = [];
  let candidates: Array<{ readonly path: string; readonly mtimeMs: number }> = [];
  try {
    candidates = fs.readdirSync(paths.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isFile()
        && entry.name.startsWith('shutdown-outcome.')
        && entry.name.endsWith('.json'))
      .map((entry) => {
        const candidatePath = path.join(paths.rootDir, entry.name);
        return { path: candidatePath, mtimeMs: fs.statSync(candidatePath).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs
        || right.path.localeCompare(left.path));
  } catch (error: unknown) {
    return [error instanceof Error ? error : new Error(String(error))];
  }
  const removable = candidates.filter((candidate) => candidate.path !== preservedPath)
    .slice(MAX_RETAINED_SHUTDOWN_OUTCOMES - 1);
  for (const candidate of removable) {
    try {
      fs.rmSync(candidate.path, { force: true });
    } catch (error: unknown) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return failures;
}

export function readRuntimeDaemonShutdownOutcome(
  paths: RuntimeDaemonPaths,
  identity: RuntimeDaemonShutdownIdentity,
): RuntimeDaemonShutdownOutcome | undefined {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(runtimeDaemonShutdownOutcomePath(paths, identity), 'utf8'),
    );
    return isRuntimeDaemonShutdownOutcome(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function clearRuntimeDaemonShutdownOutcome(
  paths: RuntimeDaemonPaths,
  identity: RuntimeDaemonShutdownIdentity,
): void {
  fs.rmSync(runtimeDaemonShutdownOutcomePath(paths, identity), { force: true });
}

export function tryAcquireRuntimeDaemonLock(
  paths: Pick<RuntimeDaemonPaths, 'rootDir' | 'lockFile'>,
  owner: RuntimeDaemonLockOwner,
): RuntimeDaemonLockHandle | undefined {
  fs.mkdirSync(paths.rootDir, { recursive: true });
  let fd: number | undefined;
  try {
    fd = fs.openSync(paths.lockFile, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    return { file: paths.lockFile, owner };
  } catch (error) {
    if (isNodeFileError(error) && error.code === 'EEXIST') {
      return undefined;
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/** Profiles are connection names; the actual Session directory has one product writer. */
export function acquireRuntimeSessionStorageOwner(
  sessionsDir: string,
  runtimeId: string,
): RuntimeDaemonLockHandle {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const rootDir = path.join(fs.realpathSync(sessionsDir), '.product-host');
  fs.mkdirSync(rootDir, { recursive: true });
  const paths = {
    rootDir,
    lockFile: path.join(rootDir, 'owner.lock'),
    ownerPolicyLockFile: path.join(rootDir, 'owner-policy.lock'),
  };
  const conflict = (): Error => Object.assign(
    new Error(`Session storage already has a product Host: ${sessionsDir}`),
    { code: 'session_storage_owned' as const },
  );
  const coordination = tryAcquireRuntimeOwnerCoordination(paths);
  if (!coordination) throw conflict();
  try {
    if (fs.existsSync(paths.lockFile)) {
      const previous = readRuntimeDaemonLockOwner(paths.lockFile);
      if (!previous || runtimeOwnerProcessState(previous) !== 'gone') throw conflict();
      fs.unlinkSync(paths.lockFile);
    }
    const processStartIdentity = readRuntimeOwnerProcessStartIdentity(process.pid);
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      kind: 'daemon',
      ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
    });
    if (!lock) throw conflict();
    return lock;
  } finally {
    releaseRuntimeOwnerCoordination(paths, coordination);
  }
}

export function releaseRuntimeDaemonLock(handle: RuntimeDaemonLockHandle): boolean {
  const coordinationPaths = {
    ownerPolicyLockFile: path.join(path.dirname(handle.file), 'owner-policy.lock'),
  };
  const coordination = tryAcquireRuntimeOwnerCoordination(coordinationPaths);
  if (!coordination) return false;
  try {
    return unlinkRuntimeDaemonLockIfOwned(handle);
  } finally {
    releaseRuntimeOwnerCoordination(coordinationPaths, coordination);
  }
}

export function releaseRuntimeDaemonOwnership(
  paths: RuntimeDaemonPaths,
  handle: RuntimeDaemonLockHandle,
): boolean {
  const coordination = tryAcquireRuntimeOwnerCoordination(paths);
  if (!coordination) return false;
  try {
    const current = readRuntimeDaemonLockOwner(handle.file);
    if (!sameRuntimeLockOwner(current, handle.owner)) return false;
    removeRuntimeDaemonStateFiles(paths);
    return unlinkRuntimeDaemonLockIfOwned(handle);
  } finally {
    releaseRuntimeOwnerCoordination(paths, coordination);
  }
}

function unlinkRuntimeDaemonLockIfOwned(handle: RuntimeDaemonLockHandle): boolean {
  const current = readRuntimeDaemonLockOwner(handle.file);
  if (!sameRuntimeLockOwner(current, handle.owner)) return false;
  fs.unlinkSync(handle.file);
  return true;
}

export function readRuntimeDaemonLockOwner(file: string): RuntimeDaemonLockOwner | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return isRuntimeDaemonLockOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function claimRuntimeDaemonOwnership(
  paths: RuntimeDaemonPaths,
  owner: RuntimeDaemonLockOwner,
  observation: RuntimeDaemonHealthObservation,
): RuntimeDaemonOwnershipDecision {
  ensureRuntimeDaemonDirectories(paths);
  const health = classifyRuntimeDaemonHealth(observation);
  const lockOwner = readRuntimeDaemonLockOwner(paths.lockFile);

  if (health === 'healthy') {
    if (
      observation.state
      && lockOwner !== undefined
      && sameRuntimeOwner(lockOwner, observation.state)
    ) {
      return {
        kind: 'attach',
        state: observation.state,
        health,
      };
    }
    return {
      kind: 'unhealthy',
      health: 'mismatch',
      ...(observation.state !== undefined ? { state: observation.state } : {}),
      ...(lockOwner !== undefined ? { lockOwner } : {}),
    };
  }

  if (
    health === 'unhealthy'
    && observation.state !== undefined
    && isRuntimeDaemonTransitionStatus(observation.state.status)
    && observation.pidAlive
    && lockOwner !== undefined
  ) {
    return {
      kind: 'wait',
      lockOwner,
      state: observation.state,
      health: 'missing',
    };
  }

  if (health === 'unhealthy' || health === 'mismatch') {
    return {
      kind: 'unhealthy',
      health,
      ...(observation.state !== undefined ? { state: observation.state } : {}),
      ...(lockOwner !== undefined ? { lockOwner } : {}),
    };
  }

  const claimHealth: 'missing' | 'stale' = health === 'stale' ? 'stale' : 'missing';
  const coordination = tryAcquireRuntimeOwnerCoordination(paths);
  if (!coordination) {
    const waitingOwner = readRuntimeDaemonLockOwner(paths.lockFile)
      ?? readRuntimeOwnerCoordinator(paths);
    return waitingOwner
      ? {
          kind: 'wait',
          lockOwner: waitingOwner,
          ...(observation.state !== undefined ? { state: observation.state } : {}),
          health: claimHealth,
        }
      : {
          kind: 'unhealthy',
          health: 'unhealthy',
          ...(observation.state !== undefined ? { state: observation.state } : {}),
        };
  }
  try {
    if (readRuntimeOwnerPolicy(paths).mode !== 'daemon') {
      return {
        kind: 'unhealthy',
        health: 'unhealthy',
        ...(observation.state !== undefined ? { state: observation.state } : {}),
      };
    }
    return claimAvailableRuntimeDaemonOwnership(
      paths,
      owner,
      observation,
      claimHealth,
    );
  } finally {
    releaseRuntimeOwnerCoordination(paths, coordination);
  }
}

function claimAvailableRuntimeDaemonOwnership(
  paths: RuntimeDaemonPaths,
  owner: RuntimeDaemonLockOwner,
  observation: RuntimeDaemonHealthObservation,
  claimHealth: 'missing' | 'stale',
): RuntimeDaemonOwnershipDecision {
  const lockOwner = readRuntimeDaemonLockOwner(paths.lockFile);
  if (claimHealth === 'stale') {
    if (
      lockOwner !== undefined
      && (
        (
          observation.observedLockOwner !== undefined
          && !sameRuntimeLockOwner(lockOwner, observation.observedLockOwner)
        )
        || (
          observation.state !== undefined
          && !sameRuntimeOwner(lockOwner, observation.state)
        )
      )
    ) {
      return waitForRuntimeOwner(lockOwner, observation, claimHealth);
    }
    removeRuntimeDaemonOwnershipFiles(paths);
  } else if (lockOwner !== undefined) {
    if (
      observation.observedLockOwner !== undefined
      && !sameRuntimeOwner(lockOwner, observation.observedLockOwner)
    ) {
      return waitForRuntimeOwner(lockOwner, observation, claimHealth);
    }
    if (observation.lockOwnerPidAlive === false) {
      removeRuntimeDaemonOwnershipFiles(paths);
    } else {
      return waitForRuntimeOwner(lockOwner, observation, claimHealth);
    }
  }

  if (claimHealth === 'missing') {
    const nextLockOwner = readRuntimeDaemonLockOwner(paths.lockFile);
    if (nextLockOwner !== undefined) {
      return {
        kind: 'wait',
        lockOwner: nextLockOwner,
        ...(observation.state !== undefined ? { state: observation.state } : {}),
        health: claimHealth,
      };
    }
  }

  const lock = tryAcquireRuntimeDaemonLock(paths, owner);
  if (lock) {
    return {
      kind: 'claim',
      lock,
      health: claimHealth,
    };
  }

  const nextLockOwner = readRuntimeDaemonLockOwner(paths.lockFile);
  if (nextLockOwner) {
    return waitForRuntimeOwner(nextLockOwner, observation, claimHealth);
  }

  return {
    kind: 'unhealthy',
    health: 'unhealthy',
    ...(observation.state !== undefined ? { state: observation.state } : {}),
  };
}

function waitForRuntimeOwner(
  lockOwner: RuntimeDaemonLockOwner,
  observation: RuntimeDaemonHealthObservation,
  health: 'missing' | 'stale',
): RuntimeDaemonOwnershipDecision {
  return {
    kind: 'wait',
    lockOwner,
    ...(observation.state !== undefined ? { state: observation.state } : {}),
    health,
  };
}

function sameRuntimeOwner(
  left: Pick<RuntimeDaemonLockOwner, 'runtimeId' | 'pid'>,
  right: Pick<RuntimeDaemonLockOwner, 'runtimeId' | 'pid'>,
): boolean {
  return left.runtimeId === right.runtimeId && left.pid === right.pid;
}

function sameOptionalRuntimeOwner(
  left: RuntimeDaemonLockOwner | undefined,
  right: RuntimeDaemonLockOwner | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameRuntimeLockOwner(left, right);
}

function sameRuntimeLockOwner(
  left: RuntimeDaemonLockOwner | undefined,
  right: RuntimeDaemonLockOwner | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.runtimeId === right.runtimeId
    && left.pid === right.pid
    && left.createdAt === right.createdAt
    && left.kind === right.kind
    && left.processStartIdentity === right.processStartIdentity
    && left.processContainment === right.processContainment
    && left.supervisorPid === right.supervisorPid
    && left.supervisorProcessStartIdentity === right.supervisorProcessStartIdentity;
}

function sameRuntimeDaemonState(
  left: RuntimeDaemonState | undefined,
  right: RuntimeDaemonState | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.runtimeId === right.runtimeId
    && left.profile === right.profile
    && left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.endpoint === right.endpoint
    && left.version === right.version
    && left.status === right.status
    && left.configHome === right.configHome
    && left.lastError === right.lastError;
}

export function removeRuntimeDaemonOwnershipFiles(paths: RuntimeDaemonPaths): void {
  fs.rmSync(paths.lockFile, { force: true });
  fs.rmSync(paths.stateFile, { force: true });
  fs.rmSync(paths.tokenFile, { force: true });
}

export function removeRuntimeDaemonOwnershipIfUnchanged(
  paths: RuntimeDaemonPaths,
  expected: {
    readonly state?: RuntimeDaemonState;
    readonly lockOwner?: RuntimeDaemonLockOwner;
  },
): boolean {
  ensureRuntimeDaemonDirectories(paths);
  const coordination = tryAcquireRuntimeOwnerCoordination(paths);
  if (!coordination) return false;
  try {
    const currentState = readRuntimeDaemonState(paths);
    const currentLockOwner = readRuntimeDaemonLockOwner(paths.lockFile);
    if (!sameRuntimeDaemonState(currentState, expected.state)) return false;
    if (!sameOptionalRuntimeOwner(currentLockOwner, expected.lockOwner)) return false;
    if (currentState === undefined && fs.existsSync(paths.stateFile)) return false;
    if (currentLockOwner === undefined && fs.existsSync(paths.lockFile)) return false;
    removeRuntimeDaemonOwnershipFiles(paths);
    return true;
  } finally {
    releaseRuntimeOwnerCoordination(paths, coordination);
  }
}

export function removeRuntimeDaemonStateFiles(paths: RuntimeDaemonPaths): void {
  fs.rmSync(paths.stateFile, { force: true });
  fs.rmSync(paths.tokenFile, { force: true });
}

export function classifyRuntimeDaemonHealth(
  observation: RuntimeDaemonHealthObservation,
): RuntimeDaemonHealth {
  if (!observation.state) {
    return 'missing';
  }
  if (observation.endpointReachable && !observation.identityMatches) {
    return 'mismatch';
  }
  if (
    observation.pidAlive
    && observation.endpointReachable
    && observation.identityMatches
  ) {
    return 'healthy';
  }
  if (!observation.pidAlive && !observation.endpointReachable) {
    return 'stale';
  }
  return 'unhealthy';
}

function isRuntimeDaemonState(value: unknown): value is RuntimeDaemonState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const state = value as Record<string, unknown>;
  return typeof state.runtimeId === 'string'
    && typeof state.profile === 'string'
    && typeof state.pid === 'number'
    && typeof state.startedAt === 'string'
    && typeof state.endpoint === 'string'
    && typeof state.version === 'string'
    && isRuntimeDaemonStatus(state.status)
    && (state.configHome === undefined || typeof state.configHome === 'string')
    && (state.lastError === undefined || typeof state.lastError === 'string');
}

function isRuntimeDaemonLogEntry(value: unknown): value is RuntimeDaemonLogEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.time === 'string'
    && isRuntimeDaemonLogLevel(entry.level)
    && typeof entry.message === 'string'
    && (entry.data === undefined || isPlainRecord(entry.data));
}

function isRuntimeDaemonLogLevel(value: unknown): value is RuntimeDaemonLogLevel {
  return value === 'info' || value === 'warn' || value === 'error';
}

function isRuntimeDaemonShutdownOutcome(
  value: unknown,
): value is RuntimeDaemonShutdownOutcome {
  if (!isPlainRecord(value)) return false;
  return value.version === 1
    && typeof value.runtimeId === 'string'
    && typeof value.pid === 'number'
    && (value.status === 'succeeded' || value.status === 'failed')
    && typeof value.completedAt === 'string'
    && (value.error === undefined || typeof value.error === 'string');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRuntimeDaemonLockOwner(value: unknown): value is RuntimeDaemonLockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const owner = value as Record<string, unknown>;
  return typeof owner.runtimeId === 'string'
    && typeof owner.pid === 'number'
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.createdAt === 'string'
    && (owner.kind === undefined || owner.kind === 'daemon' || owner.kind === 'inline')
    && (
      owner.processStartIdentity === undefined
      || (typeof owner.processStartIdentity === 'string' && owner.processStartIdentity.length > 0)
    )
    && (owner.processContainment === undefined || owner.processContainment === 'windows-job')
    && (
      owner.supervisorProcessStartIdentity === undefined
      || (
        typeof owner.supervisorProcessStartIdentity === 'string'
        && owner.supervisorProcessStartIdentity.length > 0
      )
    )
    && (owner.processContainment === 'windows-job'
      ? Number.isSafeInteger(owner.supervisorPid) && (owner.supervisorPid as number) > 0
      : owner.supervisorPid === undefined && owner.supervisorProcessStartIdentity === undefined);
}

function isRuntimeDaemonStatus(value: unknown): value is RuntimeDaemonStatus {
  return value === 'starting'
    || value === 'ready'
    || value === 'draining'
    || value === 'stopping'
    || value === 'unhealthy'
    || value === 'crashed';
}

function isRuntimeDaemonTransitionStatus(status: RuntimeDaemonStatus): boolean {
  return status === 'starting' || status === 'draining' || status === 'stopping';
}

function isNodeFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
