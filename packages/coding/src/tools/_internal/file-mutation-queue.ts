/**
 * file-mutation-queue — FEATURE_131 v0.7.36 Part A.
 *
 * Path-keyed serial mutation queue. Same path → mutations run in
 * arrival order; different paths → mutations still run concurrently.
 *
 * Why this exists: FEATURE_119 Pattern B lets the Worker fan out to
 * multiple async children that can each call `write` / `edit` /
 * `multi_edit` / `insert_after_anchor`. Without serialization at the
 * tool layer, two concurrent edits to the same file race the
 * read-modify-write cycle and silently lose one side's changes (last
 * writer wins).
 *
 * Implementation: a single process-global Map keyed by a normalized
 * path. Each `withFileMutation` call chains its work onto the tail of
 * that path's queue, sets the new tail, and clears the entry when its
 * own work is the current tail (so completed paths don't leak).
 *
 * Per-path ordering is process-local. Host-side sinks additionally retain the
 * cross-process direct lease. Only direct text sinks that actually execute in
 * the Runtime OS sandbox omit that lease, so a background command does not
 * turn a sandboxed workspace mutation into a global conflict.
 *
 * Path normalization rules (Windows/POSIX parity):
 *   - lowercase the drive letter on Windows-style paths so `C:\foo`
 *     and `c:/foo` queue together
 *   - normalize backslashes to forward slashes
 *   - collapse repeated separators
 * The intent is "would this path read and write the same file at the
 * OS level"; we keep the ruleset minimal — three fixups handle
 * 99%+ of the realistic collision space without the surface area of
 * full `path.resolve()` (which would couple us to cwd at queue time
 * and miss the symlink case anyway).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  acquireKodaXFileLock,
  cleanupRegisteredManagedChildren,
  emitKodaXDiagnostic,
  getAgentConfigHome,
  KodaXFileLockTimeoutError,
  readProcessStartIdentity,
} from '@kodax-ai/agent';
import {
  canonicalizeAgentHomePolicyPath,
  isAgentHomeHardMutationTarget,
} from '../../permissions/agent-home-policy.js';

const fileMutationQueue = new Map<string, Promise<unknown>>();
// This lock protects only the small state-file transaction. Its wait budget
// must cover the lock implementation's 30-second stale-owner safety window so
// a rapid process handoff can recover instead of failing before recovery is
// permitted.
const FILE_SYSTEM_EFFECT_COORDINATOR_TIMEOUT_MS = 30_000;
// A real cross-category conflict remains a short fail-closed admission error.
const FILE_SYSTEM_EFFECT_CONFLICT_TIMEOUT_MS = 1_000;
// Exact-policy ACL setup/reset is serialized, not rejected. Real Windows
// account/ACL work can legitimately exceed the ordinary conflict budget.
const FILE_SYSTEM_EFFECT_POLICY_TRANSITION_TIMEOUT_MS = 30_000;
// Workspace ACL reset already has a 130-second process deadline. Keep the
// coordinator wait bounded to the same budget so standalone SDK cleanup also
// fails closed instead of polling forever.
const FILE_SYSTEM_EFFECT_CLEANUP_TIMEOUT_MS = 130_000;
const FILE_SYSTEM_EFFECT_POLL_MAX_MS = 500;
const FILE_SYSTEM_EFFECT_RELEASE_ATTEMPTS = 3;
const FILE_SYSTEM_EFFECT_BACKGROUND_RETRY_MAX_MS = 5_000;
const FILE_SYSTEM_EFFECT_BACKGROUND_LOCK_TIMEOUT_MS = 0;
const EFFECT_STATE_FILE = 'model-filesystem-effects.json';
const EFFECT_COORDINATOR_LOCK = 'model-filesystem-effects.lock';
let effectOwnerStartIdentity: string | undefined;
let effectOwnerStartIdentityRead = false;
function getEffectOwnerStartIdentity(): string | undefined {
  if (!effectOwnerStartIdentityRead) {
    effectOwnerStartIdentity = readProcessStartIdentity(process.pid);
    effectOwnerStartIdentityRead = true;
  }
  return effectOwnerStartIdentity;
}
const EFFECT_TEST_SCOPE = process.env.VITEST_WORKER_ID === undefined
  ? undefined
  : `${process.env.VITEST_WORKER_ID}-${process.pid}`.replace(/[^a-z0-9_-]/gi, '_');

interface EffectLeaseOwner {
  // Kept inside `namespaces` so older Runtime copies still fence this owner.
  readonly cleanupTransition?: boolean;
  readonly effectFinished?: boolean;
  readonly effectPid?: number;
  readonly effectProcessStartIdentity?: string;
  readonly pid: number;
  readonly processStartIdentity?: string;
  readonly sandboxPolicyKey?: string;
  readonly posixProcessGroup?: boolean;
  readonly token: string;
  readonly windowsJobContained?: boolean;
}

interface EffectLeaseState {
  readonly direct: readonly EffectLeaseOwner[];
  readonly namespaces: readonly EffectLeaseOwner[];
  readonly shells: readonly EffectLeaseOwner[];
}

interface EffectLeaseStorage {
  readonly coordinatorPath: string;
  readonly statePath: string;
}

type EffectLeaseMode = 'cleanup' | 'direct' | 'namespace' | 'shell';

export interface FileSystemMutationLeaseRelease {
  (): Promise<void>;
  bindEffectProcess(pid: number, windowsJobContained: boolean): Promise<void>;
  finishEffectProcess(): Promise<void>;
  readonly released: Promise<void>;
}

export class FileSystemCleanupAdmissionTimeoutError extends Error {
  constructor() {
    super('Filesystem cleanup could not drain active effects before its deadline.');
    this.name = 'FileSystemCleanupAdmissionTimeoutError';
  }
}

function effectRuntimePath(agentHome: string, name: string): string {
  return path.join(
    agentHome,
    'runtime',
    ...(EFFECT_TEST_SCOPE === undefined ? [] : [`test-filesystem-effects-${EFFECT_TEST_SCOPE}`]),
    name,
  );
}

function captureEffectLeaseStorage(): EffectLeaseStorage {
  const programData = Object.entries(process.env).find(
    ([name, value]) => name.toUpperCase() === 'PROGRAMDATA' && value !== undefined,
  )?.[1];
  const agentHome = process.platform === 'win32'
    ? path.join(
        path.resolve(programData ?? 'C:\\ProgramData'),
        'KodaX',
        'sandbox-runtime',
      )
    : getAgentConfigHome();
  return {
    coordinatorPath: effectRuntimePath(agentHome, EFFECT_COORDINATOR_LOCK),
    statePath: effectRuntimePath(agentHome, EFFECT_STATE_FILE),
  };
}

function isEffectLeaseOwner(value: unknown): value is EffectLeaseOwner {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Number.isInteger(record.pid)
    && typeof record.token === 'string'
    && (record.cleanupTransition === undefined || typeof record.cleanupTransition === 'boolean')
    && (record.effectPid === undefined || Number.isInteger(record.effectPid))
    && (record.effectProcessStartIdentity === undefined
      || typeof record.effectProcessStartIdentity === 'string')
    && (record.effectFinished === undefined || typeof record.effectFinished === 'boolean')
    && (record.processStartIdentity === undefined
      || typeof record.processStartIdentity === 'string')
    && (record.sandboxPolicyKey === undefined || typeof record.sandboxPolicyKey === 'string')
    && (record.posixProcessGroup === undefined || typeof record.posixProcessGroup === 'boolean')
    && (record.windowsJobContained === undefined
      || typeof record.windowsJobContained === 'boolean');
}

async function readEffectLeaseState(storage: EffectLeaseStorage): Promise<EffectLeaseState> {
  let raw: string;
  try {
    raw = await readFile(storage.statePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { direct: [], namespaces: [], shells: [] };
    }
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid filesystem effect lease state.');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.direct) || !record.direct.every(isEffectLeaseOwner)) {
    throw new Error('Invalid direct filesystem effect state.');
  }
  if (!Array.isArray(record.shells) || !record.shells.every(isEffectLeaseOwner)) {
    throw new Error('Invalid shell filesystem effect state.');
  }
  const namespaces = record.namespaces ?? [];
  if (!Array.isArray(namespaces) || !namespaces.every(isEffectLeaseOwner)) {
    throw new Error('Invalid namespace filesystem effect state.');
  }
  return { direct: record.direct, namespaces, shells: record.shells };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isEffectLeaseOwnerAlive(owner: EffectLeaseOwner): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  const currentIdentity = owner.pid === process.pid
    ? getEffectOwnerStartIdentity()
    : readProcessStartIdentity(owner.pid);
  return owner.processStartIdentity === undefined
    || currentIdentity === undefined
    || currentIdentity === owner.processStartIdentity;
}

function modelEffectTreeState(
  owner: EffectLeaseOwner,
  managedCleanupSkipped: boolean,
): 'absent' | 'alive' | 'unknown' {
  if (owner.effectFinished === true) return 'absent';
  if (owner.effectPid === undefined) return managedCleanupSkipped ? 'unknown' : 'absent';
  if (owner.posixProcessGroup === true) {
    try {
      process.kill(-owner.effectPid, 0);
      return 'alive';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown';
    }
  }
  const currentIdentity = readProcessStartIdentity(owner.effectPid);
  if (
    currentIdentity !== undefined
    && (
      owner.effectProcessStartIdentity === undefined
      || currentIdentity === owner.effectProcessStartIdentity
    )
  ) return 'alive';
  if (currentIdentity === undefined && isProcessAlive(owner.effectPid)) return 'unknown';
  if (process.platform !== 'win32') return 'absent';
  if (owner.windowsJobContained === true || !managedCleanupSkipped) return 'absent';
  return 'unknown';
}

function removeStaleEffectLeases(
  state: EffectLeaseState,
  managedCleanupSkipped: boolean,
  releasedTokens: ReadonlySet<string>,
): EffectLeaseState {
  const parentAlive = new Map<EffectLeaseOwner, boolean>();
  for (const owner of [...state.direct, ...state.namespaces, ...state.shells]) {
    parentAlive.set(owner, isEffectLeaseOwnerAlive(owner));
  }
  const hasReleaseProof = (owner: EffectLeaseOwner): boolean => (
    releasedTokens.has(owner.token)
    && (owner.effectPid === undefined || owner.effectFinished === true)
  );
  const keepExternalEffect = (owner: EffectLeaseOwner): boolean => (
    !hasReleaseProof(owner)
    && (parentAlive.get(owner) === true
    || modelEffectTreeState(owner, managedCleanupSkipped) !== 'absent'
    )
  );
  return {
    direct: state.direct.filter((owner) => (
      !hasReleaseProof(owner) && parentAlive.get(owner) === true
    )),
    namespaces: state.namespaces.filter(keepExternalEffect),
    shells: state.shells.filter(keepExternalEffect),
  };
}

function effectReleaseMarkerPath(storage: EffectLeaseStorage, token: string): string {
  return `${storage.statePath}.${Buffer.from(token, 'utf8').toString('base64url')}.released`;
}

async function releasedEffectTokens(
  storage: EffectLeaseStorage,
  state: EffectLeaseState,
): Promise<ReadonlySet<string>> {
  const released = new Set<string>();
  const owners = [...state.direct, ...state.namespaces, ...state.shells];
  await Promise.all(owners.map(async (owner) => {
    try {
      if ((await readFile(effectReleaseMarkerPath(storage, owner.token), 'utf8')).trim() === owner.token) {
        released.add(owner.token);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }));
  return released;
}

async function removeEffectReleaseMarkerBestEffort(
  storage: EffectLeaseStorage,
  token: string,
): Promise<void> {
  try {
    await rm(effectReleaseMarkerPath(storage, token), { force: true });
  } catch (error) {
    emitKodaXDiagnostic({
      source: 'coding.filesystem-effect-coordinator',
      level: 'warn',
      message: 'Failed to remove a settled filesystem-effect release marker.',
      detail: error,
    });
  }
}

async function reconcileAbandonedManagedEffects(
  storage: EffectLeaseStorage,
  acquireTimeoutMs = FILE_SYSTEM_EFFECT_COORDINATOR_TIMEOUT_MS,
): Promise<boolean> {
  const hasAbandonedExternalEffect = await withEffectLeaseCoordinator(storage, async () => {
    const state = await readEffectLeaseState(storage);
    return [...state.namespaces, ...state.shells]
      .some((owner) => !isEffectLeaseOwnerAlive(owner));
  }, acquireTimeoutMs);
  if (!hasAbandonedExternalEffect) return true;
  const cleanup = await cleanupRegisteredManagedChildren({ requireCurrentOwnerCleanup: true });
  return cleanup.skipped > 0;
}

async function writeEffectLeaseState(
  storage: EffectLeaseStorage,
  state: EffectLeaseState,
): Promise<void> {
  const { statePath } = storage;
  if (state.direct.length === 0 && state.namespaces.length === 0 && state.shells.length === 0) {
    await rm(statePath, { force: true });
    return;
  }
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, 'utf8');
  try {
    await rename(temporaryPath, statePath);
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Filesystem effect state update and cleanup both failed.',
      );
    }
    throw error;
  }
}

async function withEffectLeaseCoordinator<T>(
  storage: EffectLeaseStorage,
  operation: () => Promise<T>,
  acquireTimeoutMs = FILE_SYSTEM_EFFECT_COORDINATOR_TIMEOUT_MS,
): Promise<T> {
  const release = await acquireKodaXFileLock(
    storage.coordinatorPath,
    acquireTimeoutMs,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

function namespaceConflictsWithShell(
  namespace: EffectLeaseOwner,
  shellPolicyKey: string | undefined,
): boolean {
  if (namespace.cleanupTransition === true) return true;
  if (namespace.sandboxPolicyKey === undefined) return true;
  // Only an exact, verified sandbox policy may share the ACL transition.
  // Ordinary permission execution still has to wait until path-based ACL
  // grants/revokes finish so it cannot retarget a junction mid-transition.
  if (shellPolicyKey === undefined) return true;
  return namespace.sandboxPolicyKey !== shellPolicyKey;
}

function shellConflictsWithNamespace(
  shell: EffectLeaseOwner,
  namespacePolicyKey: string | undefined,
): boolean {
  if (namespacePolicyKey === undefined) return true;
  if (shell.sandboxPolicyKey === undefined) return true;
  return shell.sandboxPolicyKey !== namespacePolicyKey;
}

async function rollbackQueuedCleanupLease(
  storage: EffectLeaseStorage,
  token: string,
  acquireTimeoutMs = FILE_SYSTEM_EFFECT_COORDINATOR_TIMEOUT_MS,
): Promise<void> {
  await withEffectLeaseCoordinator(storage, async () => {
    const state = await readEffectLeaseState(storage);
    if (!state.namespaces.some((lease) => lease.token === token)) return;
    await writeEffectLeaseState(storage, {
      ...state,
      namespaces: state.namespaces.filter((lease) => lease.token !== token),
    });
    await removeEffectReleaseMarkerBestEffort(storage, token);
  }, acquireTimeoutMs);
}

interface EffectLeaseContext {
  readonly cleanupOwner: EffectLeaseOwner;
  readonly mode: EffectLeaseMode;
  readonly owner: EffectLeaseOwner;
  readonly storage: EffectLeaseStorage;
  readonly token: string;
}

interface EffectLeaseLifecycle {
  backgroundFinishScheduled: boolean;
  backgroundReleaseScheduled: boolean;
  effectFinished: boolean;
  effectProcessBound: boolean;
  releaseRecorded: boolean;
  releaseRequested: boolean;
  released: boolean;
  reportReleased: () => void;
  stateUpdateAttempted: boolean;
}

type EffectLeaseAdmission =
  | true
  | false
  | 'sandbox-acl-transition'
  | 'sandbox-policy-conflict';

function createEffectLeaseContext(
  mode: EffectLeaseMode,
  sandboxPolicyKey?: string,
): EffectLeaseContext {
  const token = randomUUID();
  const ownerStartIdentity = getEffectOwnerStartIdentity();
  const owner: EffectLeaseOwner = {
    pid: process.pid,
    token,
    ...(ownerStartIdentity === undefined
      ? {}
      : { processStartIdentity: ownerStartIdentity }),
    ...(sandboxPolicyKey === undefined ? {} : { sandboxPolicyKey }),
  };
  // Cleanup is deliberately policy-agnostic. Older Runtime readers do not
  // understand `cleanupTransition`, but they already treat an unscoped
  // namespace owner as conflicting with every shell admission.
  return {
    cleanupOwner: {
      pid: owner.pid,
      token: owner.token,
      ...(owner.processStartIdentity === undefined
        ? {}
        : { processStartIdentity: owner.processStartIdentity }),
      cleanupTransition: true,
    },
    mode,
    owner,
    storage: captureEffectLeaseStorage(),
    token,
  };
}

function effectOwners(
  state: EffectLeaseState,
  mode: EffectLeaseMode,
): readonly EffectLeaseOwner[] {
  if (mode === 'direct') return state.direct;
  if (mode === 'shell') return state.shells;
  return state.namespaces;
}

function updateEffectOwners(
  state: EffectLeaseState,
  mode: EffectLeaseMode,
  update: (owners: readonly EffectLeaseOwner[]) => readonly EffectLeaseOwner[],
): EffectLeaseState {
  if (mode === 'direct') return { ...state, direct: update(state.direct) };
  if (mode === 'shell') return { ...state, shells: update(state.shells) };
  return { ...state, namespaces: update(state.namespaces) };
}

function cleanupNamespaceIsBlocked(
  state: EffectLeaseState,
  token: string,
  queuedIndex: number,
): boolean {
  return state.namespaces.some((lease, index) => (
    lease.token !== token
    && (
      lease.cleanupTransition !== true
      || queuedIndex === -1
      || index < queuedIndex
    )
  ));
}

function effectLeaseConflicts(
  state: EffectLeaseState,
  context: EffectLeaseContext,
  queuedCleanupIndex: number,
): boolean {
  const policyKey = context.owner.sandboxPolicyKey;
  if (context.mode === 'cleanup') return state.direct.length > 0
    || cleanupNamespaceIsBlocked(state, context.token, queuedCleanupIndex)
    || state.shells.some((lease) => (
      lease.effectFinished !== true || shellConflictsWithNamespace(lease, policyKey)
    ));
  if (context.mode === 'shell') return state.direct.length > 0
    || state.namespaces.some((lease) => namespaceConflictsWithShell(lease, policyKey));
  if (context.mode === 'direct') return state.shells.length > 0
    || state.namespaces.length > 0;
  return state.direct.length > 0
    || state.namespaces.length > 0
    || state.shells.some((lease) => shellConflictsWithNamespace(lease, policyKey));
}

function hasIncompatibleSandboxPolicy(
  state: EffectLeaseState,
  context: EffectLeaseContext,
): boolean {
  const policyKey = context.owner.sandboxPolicyKey;
  if (context.mode === 'cleanup' || policyKey === undefined) return false;
  if (context.mode === 'namespace') return state.namespaces.some(
    (lease) => lease.sandboxPolicyKey !== policyKey,
  ) || state.shells.some((lease) => shellConflictsWithNamespace(lease, policyKey));
  return context.mode === 'shell' && state.namespaces.some((lease) => (
    lease.sandboxPolicyKey !== undefined && lease.sandboxPolicyKey !== policyKey
  ));
}

function isSandboxAclTransition(
  state: EffectLeaseState,
  context: EffectLeaseContext,
): boolean {
  if (context.mode === 'cleanup') return true;
  if (state.namespaces.some((lease) => lease.cleanupTransition === true)) return true;
  if (state.direct.length > 0) return false;
  const policyKey = context.owner.sandboxPolicyKey;
  if (context.mode === 'namespace') return policyKey !== undefined
    && state.shells.every((lease) => !shellConflictsWithNamespace(lease, policyKey))
    && state.namespaces.length > 0
    && state.namespaces.every((lease) => lease.sandboxPolicyKey === policyKey);
  return context.mode === 'shell'
    && policyKey === undefined
    && state.namespaces.length > 0
    && state.namespaces.every((lease) => lease.sandboxPolicyKey !== undefined);
}

function appendEffectLeaseOwner(
  state: EffectLeaseState,
  context: EffectLeaseContext,
  queuedCleanupIndex: number,
): EffectLeaseState {
  if (context.mode === 'cleanup' && queuedCleanupIndex !== -1) return state;
  const owner = context.mode === 'cleanup' ? context.cleanupOwner : context.owner;
  return updateEffectOwners(state, context.mode, (owners) => [...owners, owner]);
}

async function removeObsoleteReleaseMarkers(
  storage: EffectLeaseStorage,
  releasedTokens: ReadonlySet<string>,
  retainedTokens: ReadonlySet<string>,
): Promise<void> {
  await Promise.all([...releasedTokens]
    .filter((token) => !retainedTokens.has(token))
    .map((token) => removeEffectReleaseMarkerBestEffort(storage, token)));
}

async function tryAcquireEffectLease(
  context: EffectLeaseContext,
  managedCleanupSkipped: boolean,
  onCleanupQueued: () => void,
  acquireTimeoutMs = FILE_SYSTEM_EFFECT_COORDINATOR_TIMEOUT_MS,
): Promise<EffectLeaseAdmission> {
  return withEffectLeaseCoordinator(context.storage, async () => {
    const stored = await readEffectLeaseState(context.storage);
    const releasedTokens = await releasedEffectTokens(context.storage, stored);
    const state = removeStaleEffectLeases(stored, managedCleanupSkipped, releasedTokens);
    const retainedTokens = new Set(
      [...state.direct, ...state.namespaces, ...state.shells].map((lease) => lease.token),
    );
    const queuedIndex = state.namespaces.findIndex((lease) => lease.token === context.token);
    if (queuedIndex !== -1) onCleanupQueued();
    if (effectLeaseConflicts(state, context, queuedIndex)) {
      if (hasIncompatibleSandboxPolicy(state, context)) return 'sandbox-policy-conflict';
      if (context.mode === 'cleanup' && queuedIndex === -1) {
        await writeEffectLeaseState(context.storage, appendEffectLeaseOwner(state, context, -1));
        onCleanupQueued();
      }
      return isSandboxAclTransition(state, context) ? 'sandbox-acl-transition' : false;
    }
    await writeEffectLeaseState(
      context.storage,
      appendEffectLeaseOwner(state, context, queuedIndex),
    );
    if (context.mode === 'cleanup') onCleanupQueued();
    await removeObsoleteReleaseMarkers(context.storage, releasedTokens, retainedTokens);
    return true;
  }, acquireTimeoutMs);
}

function checkEffectLeaseDeadline(
  context: EffectLeaseContext,
  deadline: number,
  cleanupWaitExpired: boolean,
  onCleanupWaitExpired?: (error: Error) => void,
): boolean {
  if (performance.now() < deadline) return cleanupWaitExpired;
  if (context.mode !== 'cleanup') {
    throw new Error('A model filesystem effect is already active; retry after it finishes.');
  }
  if (!cleanupWaitExpired) onCleanupWaitExpired?.(new FileSystemCleanupAdmissionTimeoutError());
  return true;
}

function waitForEffectLeasePoll(delayMs: number, allowProcessExit: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    if (allowProcessExit) timer.unref?.();
  });
}

function effectLeaseCoordinatorTimeout(
  context: EffectLeaseContext,
  cleanupDeadline: number,
): number {
  if (context.mode !== 'cleanup') return FILE_SYSTEM_EFFECT_COORDINATOR_TIMEOUT_MS;
  return Math.max(
    0,
    Math.min(FILE_SYSTEM_EFFECT_COORDINATOR_TIMEOUT_MS, cleanupDeadline - performance.now()),
  );
}

function isCoordinatorLockTimeout(error: unknown): boolean {
  return error instanceof KodaXFileLockTimeoutError
    || (
      error instanceof Error
      && 'code' in error
      && error.code === 'kodax_file_lock_timeout'
    );
}

async function reconcileManagedEffectsBeforeAdmission(
  context: EffectLeaseContext,
  cleanupDeadline: number,
  onCleanupWaitExpired?: (error: Error) => void,
): Promise<{ readonly cleanupWaitExpired: boolean; readonly managedCleanupSkipped: boolean }> {
  let cleanupWaitExpired = false;
  let pollDelayMs = 20;
  while (true) {
    try {
      const managedCleanupSkipped = await reconcileAbandonedManagedEffects(
        context.storage,
        effectLeaseCoordinatorTimeout(context, cleanupDeadline),
      );
      if (context.mode === 'cleanup') {
        cleanupWaitExpired = checkEffectLeaseDeadline(
          context,
          cleanupDeadline,
          cleanupWaitExpired,
          onCleanupWaitExpired,
        );
      }
      return { cleanupWaitExpired, managedCleanupSkipped };
    } catch (error: unknown) {
      const cleanupDeadlineReached = context.mode === 'cleanup'
        && performance.now() >= cleanupDeadline;
      if (!cleanupDeadlineReached) throw error;
      cleanupWaitExpired = checkEffectLeaseDeadline(
        context,
        cleanupDeadline,
        cleanupWaitExpired,
        onCleanupWaitExpired,
      );
      if (!isCoordinatorLockTimeout(error)) throw error;
      await waitForEffectLeasePoll(pollDelayMs, true);
      pollDelayMs = Math.min(pollDelayMs * 2, FILE_SYSTEM_EFFECT_POLL_MAX_MS);
    }
  }
}

async function waitForEffectLeaseAdmission(
  context: EffectLeaseContext,
  onCleanupWaitExpired?: (error: Error) => void,
): Promise<void> {
  const conflictDeadline = performance.now() + FILE_SYSTEM_EFFECT_CONFLICT_TIMEOUT_MS;
  const policyTransitionDeadline = performance.now()
    + FILE_SYSTEM_EFFECT_POLICY_TRANSITION_TIMEOUT_MS;
  const cleanupDeadline = performance.now() + FILE_SYSTEM_EFFECT_CLEANUP_TIMEOUT_MS;
  const reconciliation = await reconcileManagedEffectsBeforeAdmission(
    context,
    cleanupDeadline,
    onCleanupWaitExpired,
  );
  const managedCleanupSkipped = reconciliation.managedCleanupSkipped;
  let cleanupQueued = false;
  let cleanupWaitExpired = reconciliation.cleanupWaitExpired;
  let pollDelayMs = 20;
  try {
    while (true) {
      let acquired: EffectLeaseAdmission;
      try {
        acquired = await tryAcquireEffectLease(
          context,
          managedCleanupSkipped,
          () => { cleanupQueued = true; },
          effectLeaseCoordinatorTimeout(context, cleanupDeadline),
        );
      } catch (error: unknown) {
        const cleanupDeadlineReached = context.mode === 'cleanup'
          && performance.now() >= cleanupDeadline;
        if (cleanupDeadlineReached) {
          cleanupWaitExpired = checkEffectLeaseDeadline(
            context,
            cleanupDeadline,
            cleanupWaitExpired,
            onCleanupWaitExpired,
          );
        }
        if (!cleanupDeadlineReached || !isCoordinatorLockTimeout(error)) throw error;
        await waitForEffectLeasePoll(pollDelayMs, true);
        pollDelayMs = Math.min(pollDelayMs * 2, FILE_SYSTEM_EFFECT_POLL_MAX_MS);
        continue;
      }
      if (context.mode === 'cleanup') {
        cleanupWaitExpired = checkEffectLeaseDeadline(
          context,
          cleanupDeadline,
          cleanupWaitExpired,
          onCleanupWaitExpired,
        );
      }
      if (acquired === true) break;
      if (acquired === 'sandbox-policy-conflict') {
        throw new Error('A different sandbox policy is already active.');
      }
      const deadline = context.mode === 'cleanup'
        ? cleanupDeadline
        : acquired === 'sandbox-acl-transition'
          ? policyTransitionDeadline
          : conflictDeadline;
      if (context.mode !== 'cleanup') {
        cleanupWaitExpired = checkEffectLeaseDeadline(
          context,
          deadline,
          cleanupWaitExpired,
          onCleanupWaitExpired,
        );
      }
      await waitForEffectLeasePoll(pollDelayMs, cleanupWaitExpired);
      pollDelayMs = Math.min(pollDelayMs * 2, FILE_SYSTEM_EFFECT_POLL_MAX_MS);
    }
  } catch (error: unknown) {
    if (!cleanupQueued) throw error;
    try {
      await rollbackQueuedCleanupLease(
        context.storage,
        context.token,
        cleanupWaitExpired || performance.now() >= cleanupDeadline
          ? FILE_SYSTEM_EFFECT_BACKGROUND_LOCK_TIMEOUT_MS
          : FILE_SYSTEM_EFFECT_COORDINATOR_TIMEOUT_MS,
      );
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [error, rollbackError],
        'Filesystem cleanup admission and queued-marker rollback both failed.',
      );
    }
    throw error;
  }
}

function replaceOwnedEffectLease(
  state: EffectLeaseState,
  context: EffectLeaseContext,
  replace: (owner: EffectLeaseOwner) => EffectLeaseOwner,
  missingMessage: string,
): EffectLeaseState {
  const owners = effectOwners(state, context.mode);
  if (!owners.some((lease) => lease.token === context.token)) throw new Error(missingMessage);
  return updateEffectOwners(state, context.mode, (current) => current.map((lease) => (
    lease.token === context.token ? replace(lease) : lease
  )));
}

async function bindEffectLeaseProcess(
  context: EffectLeaseContext,
  lifecycle: EffectLeaseLifecycle,
  effectPid: number,
  windowsJobContained: boolean,
): Promise<void> {
  if (!Number.isInteger(effectPid) || effectPid <= 0) {
    throw new Error(`Invalid filesystem effect process id: ${effectPid}`);
  }
  const effectProcessStartIdentity = readProcessStartIdentity(effectPid);
  const boundOwner: EffectLeaseOwner = {
    ...(context.mode === 'cleanup' ? context.cleanupOwner : context.owner),
    effectPid,
    effectFinished: false,
    ...(effectProcessStartIdentity === undefined ? {} : { effectProcessStartIdentity }),
    posixProcessGroup: process.platform !== 'win32',
    windowsJobContained,
  };
  await withEffectLeaseCoordinator(context.storage, async () => {
    const state = await readEffectLeaseState(context.storage);
    await writeEffectLeaseState(context.storage, replaceOwnedEffectLease(
      state,
      context,
      () => boundOwner,
      'Filesystem effect lease ownership was lost before process binding.',
    ));
  });
  lifecycle.effectProcessBound = true;
  lifecycle.effectFinished = false;
}

async function finishEffectLeaseProcessOnce(
  context: EffectLeaseContext,
  acquireTimeoutMs = FILE_SYSTEM_EFFECT_COORDINATOR_TIMEOUT_MS,
): Promise<void> {
  await withEffectLeaseCoordinator(context.storage, async () => {
    const state = await readEffectLeaseState(context.storage);
    await writeEffectLeaseState(context.storage, replaceOwnedEffectLease(
      state,
      context,
      (owner) => ({ ...owner, effectFinished: true }),
      'Filesystem effect lease ownership was lost before tree completion.',
    ));
  }, acquireTimeoutMs);
}

async function retryEffectLeaseUpdate(operation: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= FILE_SYSTEM_EFFECT_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error: unknown) {
      lastError = error;
      if (attempt < FILE_SYSTEM_EFFECT_RELEASE_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
  }
  throw lastError;
}

export function scheduleUnrefBackgroundRetry(
  operation: () => Promise<void>,
  onSuccess: () => void,
  onRetryFailure: (error: unknown, attempt: number) => void,
): void {
  let attempt = 0;
  const retry = (): void => {
    const delayMs = Math.min(
      250 * (2 ** attempt),
      FILE_SYSTEM_EFFECT_BACKGROUND_RETRY_MAX_MS,
    );
    attempt += 1;
    const timer = setTimeout(() => {
      void operation().then(onSuccess).catch((error: unknown) => {
        onRetryFailure(error, attempt);
        retry();
      });
    }, delayMs);
    timer.unref?.();
  };
  retry();
}

function scheduleBackgroundFinish(
  context: EffectLeaseContext,
  lifecycle: EffectLeaseLifecycle,
): void {
  if (lifecycle.effectFinished || lifecycle.backgroundFinishScheduled) return;
  lifecycle.backgroundFinishScheduled = true;
  scheduleUnrefBackgroundRetry(
    async () => {
      if (lifecycle.released) return;
      await finishEffectLeaseProcessOnce(
        context,
        FILE_SYSTEM_EFFECT_BACKGROUND_LOCK_TIMEOUT_MS,
      );
    },
    () => {
      lifecycle.backgroundFinishScheduled = false;
      if (lifecycle.released) return;
      lifecycle.effectFinished = true;
      if (lifecycle.releaseRequested) scheduleBackgroundRelease(context, lifecycle);
    },
    (error, attempt) => {
      if (attempt % 10 !== 0) return;
      emitKodaXDiagnostic({
        source: 'coding.filesystem-effect-coordinator',
        level: 'warn',
        message: 'Automatic filesystem-effect completion retry is still pending; the durable fence remains closed.',
        detail: error,
      });
    },
  );
}

async function finishEffectLeaseProcessReliably(
  context: EffectLeaseContext,
  lifecycle: EffectLeaseLifecycle,
): Promise<void> {
  try {
    await retryEffectLeaseUpdate(() => finishEffectLeaseProcessOnce(context));
    lifecycle.effectFinished = true;
  } catch (error: unknown) {
    scheduleBackgroundFinish(context, lifecycle);
    throw error;
  }
}

function createEffectProcessControls(
  context: EffectLeaseContext,
  lifecycle: EffectLeaseLifecycle,
): Pick<FileSystemMutationLeaseRelease, 'bindEffectProcess' | 'finishEffectProcess'> {
  let finishAttempt: Promise<void> | undefined;
  return {
    bindEffectProcess: (pid, jobContained) => (
      bindEffectLeaseProcess(context, lifecycle, pid, jobContained)
    ),
    async finishEffectProcess() {
      if (lifecycle.effectFinished) return;
      finishAttempt ??= finishEffectLeaseProcessReliably(context, lifecycle).finally(() => {
        finishAttempt = undefined;
      });
      await finishAttempt;
    },
  };
}

async function releaseEffectLeaseOnce(
  context: EffectLeaseContext,
  lifecycle: EffectLeaseLifecycle,
  acquireTimeoutMs = FILE_SYSTEM_EFFECT_COORDINATOR_TIMEOUT_MS,
): Promise<void> {
  await withEffectLeaseCoordinator(context.storage, async () => {
    const state = await readEffectLeaseState(context.storage);
    const owned = effectOwners(state, context.mode).find(
      (lease) => lease.token === context.token,
    );
    if (owned === undefined) {
      if (!lifecycle.releaseRecorded && !lifecycle.stateUpdateAttempted) {
        throw new Error('Filesystem effect lease ownership was lost.');
      }
      await removeEffectReleaseMarkerBestEffort(context.storage, context.token);
      return;
    }
    if (owned.effectPid !== undefined && owned.effectFinished !== true) {
      throw new Error('Filesystem effect process tree has not been proven drained.');
    }
    lifecycle.stateUpdateAttempted = true;
    await writeEffectLeaseState(context.storage, updateEffectOwners(
      state,
      context.mode,
      (owners) => owners.filter((lease) => lease.token !== context.token),
    ));
    await removeEffectReleaseMarkerBestEffort(context.storage, context.token);
  }, acquireTimeoutMs);
}

async function writeEffectReleaseProof(
  context: EffectLeaseContext,
  lifecycle: EffectLeaseLifecycle,
): Promise<unknown> {
  if (lifecycle.releaseRecorded || (lifecycle.effectProcessBound && !lifecycle.effectFinished)) {
    return undefined;
  }
  try {
    await writeFile(
      effectReleaseMarkerPath(context.storage, context.token),
      `${context.token}\n`,
      'utf8',
    );
    lifecycle.releaseRecorded = true;
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

function scheduleBackgroundRelease(
  context: EffectLeaseContext,
  lifecycle: EffectLeaseLifecycle,
): void {
  if (lifecycle.released || lifecycle.backgroundReleaseScheduled) return;
  lifecycle.backgroundReleaseScheduled = true;
  scheduleUnrefBackgroundRetry(
    () => releaseEffectLeaseOnce(
      context,
      lifecycle,
      FILE_SYSTEM_EFFECT_BACKGROUND_LOCK_TIMEOUT_MS,
    ),
    () => {
      lifecycle.backgroundReleaseScheduled = false;
      markEffectLeaseReleased(lifecycle);
    },
    (error, attempt) => {
      if (attempt % 10 !== 0) return;
      emitKodaXDiagnostic({
        source: 'coding.filesystem-effect-coordinator',
        level: 'warn',
        message: 'Automatic filesystem-effect release retry is still pending; the durable fence remains closed.',
        detail: error,
      });
    },
  );
}

function markEffectLeaseReleased(lifecycle: EffectLeaseLifecycle): void {
  if (lifecycle.released) return;
  lifecycle.released = true;
  lifecycle.reportReleased();
}

async function releaseEffectLeaseReliably(
  context: EffectLeaseContext,
  lifecycle: EffectLeaseLifecycle,
): Promise<void> {
  lifecycle.releaseRequested = true;
  const releaseProofError = await writeEffectReleaseProof(context, lifecycle);
  let releaseError: unknown;
  try {
    await retryEffectLeaseUpdate(() => releaseEffectLeaseOnce(context, lifecycle));
  } catch (error: unknown) {
    releaseError = error;
  }
  if (releaseError === undefined) {
    if (releaseProofError !== undefined) emitKodaXDiagnostic({
      source: 'coding.filesystem-effect-coordinator',
      level: 'warn',
      message: 'Filesystem-effect release converged without a durable release marker.',
      detail: releaseProofError,
    });
    return;
  }
  scheduleBackgroundRelease(context, lifecycle);
  throw releaseProofError === undefined
    ? releaseError
    : new AggregateError(
        [releaseProofError, releaseError],
        'Filesystem-effect release marker and coordinator cleanup both failed.',
      );
}

function createEffectLeaseRelease(
  context: EffectLeaseContext,
  lifecycle: EffectLeaseLifecycle,
): () => Promise<void> {
  let releaseAttempt: Promise<void> | undefined;
  return async () => {
    if (lifecycle.released) return;
    releaseAttempt ??= releaseEffectLeaseReliably(context, lifecycle).then(() => {
      markEffectLeaseReleased(lifecycle);
    }).finally(() => {
      releaseAttempt = undefined;
    });
    await releaseAttempt;
  };
}

async function acquireEffectLease(
  mode: EffectLeaseMode,
  sandboxPolicyKey?: string,
  onCleanupWaitExpired?: (error: Error) => void,
): Promise<FileSystemMutationLeaseRelease> {
  const context = createEffectLeaseContext(mode, sandboxPolicyKey);
  await waitForEffectLeaseAdmission(context, onCleanupWaitExpired);
  let reportReleased!: () => void;
  const released = new Promise<void>((resolve) => { reportReleased = resolve; });
  const lifecycle: EffectLeaseLifecycle = {
    backgroundFinishScheduled: false,
    backgroundReleaseScheduled: false,
    effectFinished: false,
    effectProcessBound: false,
    releaseRecorded: false,
    releaseRequested: false,
    released: false,
    reportReleased,
    stateUpdateAttempted: false,
  };
  const release = createEffectLeaseRelease(context, lifecycle);
  return Object.assign(release, createEffectProcessControls(context, lifecycle), { released });
}

/**
 * Serializes host-privileged file sinks with model-started mutating shells.
 * This closes the symlink/junction retarget window between canonical policy
 * checks and the actual filesystem operation.
 */
export function acquireFileSystemMutationLease(
  sandboxPolicyKey?: string,
): Promise<FileSystemMutationLeaseRelease> {
  return acquireEffectLease('shell', sandboxPolicyKey);
}

/** Excludes every model-started shell while a temporary host namespace is visible. */
export function acquireExclusiveFileSystemEffectLease(
  sandboxPolicyKey?: string,
): Promise<FileSystemMutationLeaseRelease> {
  return acquireEffectLease('namespace', sandboxPolicyKey);
}

export async function finishAndReleaseFileSystemEffectLease(
  lease: FileSystemMutationLeaseRelease,
): Promise<void> {
  let finishError: unknown;
  try {
    await lease.finishEffectProcess();
  } catch (error: unknown) {
    finishError = error;
  }
  try {
    await lease();
  } catch (releaseError: unknown) {
    throw finishError === undefined
      ? releaseError
      : new AggregateError(
          [finishError, releaseError],
          'Filesystem cleanup completion and lease release both failed.',
        );
  }
  if (finishError !== undefined) throw finishError;
}

/**
 * Internal cleanup transaction. The action must prove its process tree and ACL
 * reset before resolving; admission may time out for its caller but keeps converging.
 */
interface CleanupAdmissionDeadline {
  readonly clear: () => void;
  readonly expire: (error: Error) => void;
  readonly expired: () => boolean;
  readonly waitExpired: Promise<never>;
}

function createCleanupAdmissionDeadline(): CleanupAdmissionDeadline {
  let callerTimedOut = false;
  let rejectWaitExpired: ((error: Error) => void) | undefined;
  const waitExpired = new Promise<never>((_resolve, reject) => {
    rejectWaitExpired = reject;
  });
  const timer = setTimeout(() => {
    if (callerTimedOut) return;
    callerTimedOut = true;
    rejectWaitExpired?.(new FileSystemCleanupAdmissionTimeoutError());
  }, FILE_SYSTEM_EFFECT_CLEANUP_TIMEOUT_MS);
  timer.unref?.();
  return {
    clear: () => clearTimeout(timer),
    expire: (error) => {
      if (callerTimedOut) return;
      callerTimedOut = true;
      rejectWaitExpired?.(error);
    },
    expired: () => callerTimedOut,
    waitExpired,
  };
}

function observeCleanupLeaseRelease(
  lease: FileSystemMutationLeaseRelease,
  onLeaseReleased: ((lease: FileSystemMutationLeaseRelease) => void) | undefined,
): void {
  if (onLeaseReleased === undefined) return;
  void lease.released.then(() => onLeaseReleased(lease)).catch((error: unknown) => {
    emitKodaXDiagnostic({
      source: 'coding.filesystem-effect-coordinator',
      level: 'error',
      message: 'Filesystem cleanup release observer failed.',
      detail: error,
    });
  });
}

async function runCleanupLeaseWorkflow<T>(
  sandboxPolicyKey: string,
  cleanupProcess: { readonly pid: number; readonly windowsJobContained: boolean },
  action: () => Promise<T>,
  deadline: CleanupAdmissionDeadline,
  markActionCompleted: () => void,
  onLeaseAcquired?: (lease: FileSystemMutationLeaseRelease) => void,
  onLeaseReleased?: (lease: FileSystemMutationLeaseRelease) => void,
): Promise<T> {
  const lease = await acquireEffectLease('cleanup', sandboxPolicyKey, deadline.expire);
  try {
    // Publish the durable lease before binding, because bind may fail after the
    // coordinator has recorded an owner that only the Job-backed janitor can settle.
    onLeaseAcquired?.(lease);
    observeCleanupLeaseRelease(lease, onLeaseReleased);
    await lease.bindEffectProcess(cleanupProcess.pid, cleanupProcess.windowsJobContained);
  } catch (error) {
    // A lease that was acquired but never bound must not stay published: a
    // live daemon would never see it reclaimed as stale, and every later
    // filesystem effect would queue behind it. Release best-effort before
    // surfacing the failure; the cleanup action never started, so there is
    // no partially applied ACL state to recover.
    await lease().catch(() => undefined);
    throw error;
  }
  const result = await action();
  markActionCompleted();
  await finishAndReleaseFileSystemEffectLease(lease);
  return result;
}

function observeDeferredCleanupFailure<T>(
  workflow: Promise<T>,
  deadline: CleanupAdmissionDeadline,
  actionStarted: () => boolean,
  actionCompleted: () => boolean,
  onDeferredFailure: ((error: unknown) => Promise<void>) | undefined,
): void {
  void workflow.catch(async (error: unknown) => {
    if (!deadline.expired()) return;
    emitKodaXDiagnostic({
      source: 'coding.filesystem-effect-coordinator',
      level: 'warn',
      message: 'Filesystem cleanup failed after its caller deadline; the durable fence remains closed.',
      detail: error,
    });
    // Only an action that actually started can leave partially applied ACL
    // state behind. Admission or bind failures leave the owner untouched, so
    // they must not escalate to durable ACL recovery.
    if (!actionStarted() || actionCompleted() || onDeferredFailure === undefined) return;
    try {
      await onDeferredFailure(error);
    } catch (handlerError: unknown) {
      emitKodaXDiagnostic({
        source: 'coding.filesystem-effect-coordinator',
        level: 'error',
        message: 'Deferred filesystem cleanup failure could not be persisted.',
        detail: new AggregateError([error, handlerError]),
      });
    }
  });
}

export function withExclusiveFileSystemCleanupLease<T>(
  sandboxPolicyKey: string,
  cleanupProcess: {
    readonly pid: number;
    readonly windowsJobContained: boolean;
  },
  action: () => Promise<T>,
  onDeferredFailure?: (error: unknown) => Promise<void>,
  onLeaseAcquired?: (lease: FileSystemMutationLeaseRelease) => void,
  onLeaseReleased?: (lease: FileSystemMutationLeaseRelease) => void,
): Promise<T> {
  let cleanupActionStarted = false;
  let cleanupActionCompleted = false;
  const deadline = createCleanupAdmissionDeadline();
  const workflow = runCleanupLeaseWorkflow(
    sandboxPolicyKey,
    cleanupProcess,
    async () => {
      cleanupActionStarted = true;
      return action();
    },
    deadline,
    () => { cleanupActionCompleted = true; },
    onLeaseAcquired,
    onLeaseReleased,
  );
  observeDeferredCleanupFailure(
    workflow,
    deadline,
    () => cleanupActionStarted,
    () => cleanupActionCompleted,
    onDeferredFailure,
  );
  return Promise.race([workflow, deadline.waitExpired]).finally(deadline.clear);
}

/** Degraded host fallback only; sandboxed text mutations do not acquire this lease. */
export function acquireHostFileSystemMutationLease(): Promise<FileSystemMutationLeaseRelease> {
  return acquireEffectLease('direct');
}

async function runWithEffectLeaseRelease<T>(
  operation: () => Promise<T>,
  releaseLease: FileSystemMutationLeaseRelease,
): Promise<T> {
  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error: unknown) {
    outcome = { ok: false, error };
  }
  try {
    await releaseLease();
  } catch (releaseError: unknown) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, releaseError],
        `Filesystem operation failed and lease release also failed: ${
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        }`,
      );
    }
    throw releaseError;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Keep a degraded host-side sink disjoint from model-started shell effects. */
export async function withHostFileSystemMutation<T>(operation: () => Promise<T>): Promise<T> {
  const releaseLease = await acquireHostFileSystemMutationLease();
  return runWithEffectLeaseRelease(operation, releaseLease);
}

/** Serialize a host operation that can materialize or remove path aliases. */
export async function withHostFileSystemNamespaceMutation<T>(
  operation: (
    bindEffectProcess: FileSystemMutationLeaseRelease['bindEffectProcess'],
    finishEffectProcess: FileSystemMutationLeaseRelease['finishEffectProcess'],
  ) => Promise<T>,
): Promise<T> {
  const releaseLease = await acquireEffectLease('namespace');
  return runWithEffectLeaseRelease(
    () => operation(
      releaseLease.bindEffectProcess,
      releaseLease.finishEffectProcess,
    ),
    releaseLease,
  );
}

/** Capture a stable canonical backup key before a concurrent sink commits. */
export function resolveFileBackupPath(filePath: string): string {
  const backupPath = canonicalizeAgentHomePolicyPath(filePath);
  if (backupPath === undefined) throw new Error(`Cannot identify backup path: ${filePath}`);
  return backupPath;
}

/** Record against a canonical key captured before the corresponding commit. */
export function recordResolvedFileBackup(
  backups: Map<string, string>,
  backupPath: string,
  content: string,
): void {
  backups.delete(backupPath);
  backups.set(backupPath, content);
}

/**
 * Normalize a path so equivalent variants collide on the same queue
 * key. Cross-platform parity per design §FEATURE_131 acceptance #9.
 *
 * On Windows the filesystem is case-insensitive across the entire
 * path, so we lowercase everything once we know we're on win32.
 * POSIX paths are case-sensitive and stay as-is. Detection is via
 * `process.platform`, with `KODAX_PATH_KEY_PLATFORM` as a test-only
 * override so unit tests can exercise both branches regardless of
 * the host OS.
 */
function isWindowsPathPlatform(): boolean {
  const override = process.env.KODAX_PATH_KEY_PLATFORM;
  if (override === 'win32') return true;
  if (override === 'posix') return false;
  return process.platform === 'win32';
}

export function normalizePathForKey(absolutePath: string): string {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
    return '';
  }
  let normalized = absolutePath.replace(/\\/g, '/');
  // Collapse repeated separators ("a//b" → "a/b") but not the leading
  // double-slash on UNC paths.
  if (normalized.startsWith('//')) {
    normalized = '//' + normalized.slice(2).replace(/\/+/g, '/');
  } else {
    normalized = normalized.replace(/\/+/g, '/');
  }
  if (isWindowsPathPlatform()) {
    // Windows filesystem is case-insensitive end-to-end — lowercase
    // the entire path so any spelling collides on the same key.
    normalized = normalized.toLowerCase();
  } else if (normalized.length >= 2 && /^[A-Za-z]:/.test(normalized)) {
    // POSIX host but a Windows-style path snuck in (cross-platform
    // tests, mock data) — at minimum align the drive letter so the
    // common case of `C:` vs `c:` doesn't split the queue.
    normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  }
  // Trim trailing slash unless it's the root marker.
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.replace(/\/+$/g, '');
  }
  return normalized;
}

/**
 * Run `fn` serialized against any other in-flight mutations targeting
 * the same `absolutePath`. Returns whatever `fn` returns. The queue
 * tail entry is cleared when this call's work is the current tail —
 * so steady-state behavior is "queue size === count of paths with
 * mutations actively in flight", never growing unboundedly.
 *
 * Errors propagate: if `fn` throws/rejects, the queue still moves on
 * to the next caller (it chains off `previous` not off the failure),
 * but the rejected promise is what `withFileMutation` returns to the
 * caller. Subsequent enqueues see a settled prior tail and proceed.
 */
export async function withPathMutation<T>(
  absolutePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = normalizePathForKey(absolutePath);
  const previous = fileMutationQueue.get(key) ?? Promise.resolve();
  // Wrap `fn` so a failure on the prior tail does not poison this
  // call's chain. We always advance the queue regardless of whether
  // the prior caller succeeded.
  const next: Promise<T> = previous
    .catch(() => undefined)
    .then(fn);
  // Track a sibling promise for tail-eviction so `next`'s consumer
  // sees its real result (success or rejection) without our cleanup
  // accidentally swallowing it.
  const trackable: Promise<unknown> = next.catch(() => undefined).finally(() => {
    if (fileMutationQueue.get(key) === trackable) {
      fileMutationQueue.delete(key);
    }
  });
  fileMutationQueue.set(key, trackable);
  return next;
}

/** Path-local queue plus the ordinary direct-file Agent Home hard boundary. */
export function withFileMutation<T>(
  absolutePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withPathMutation(absolutePath, async () => {
    return withHostFileSystemMutation(async () => {
      if (isAgentHomeHardMutationTarget(absolutePath)) {
        throw new Error(`Mutation targets protected KodaX state: ${absolutePath}`);
      }
      return fn();
    });
  });
}

/** Path-local direct mutation whose actual filesystem sink runs inside the OS sandbox. */
export function withSandboxedFileMutation<T>(
  absolutePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withPathMutation(absolutePath, async () => {
    if (isAgentHomeHardMutationTarget(absolutePath)) {
      throw new Error(`Mutation targets protected KodaX state: ${absolutePath}`);
    }
    return fn();
  });
}

/**
 * Test-only helper: snapshot the live queue size. Used by the unit
 * tests to assert "no leak after settle". Production code should not
 * read this — it only exists for verification.
 */
export function _peekFileMutationQueueSizeForTests(): number {
  return fileMutationQueue.size;
}

/**
 * Test-only helper: clear the queue between tests. Production code
 * should never call this — it would orphan in-flight mutations.
 */
export function _resetFileMutationQueueForTests(): void {
  fileMutationQueue.clear();
}

export async function _resetFileSystemEffectLeasesForTests(): Promise<void> {
  if (process.env.VITEST_WORKER_ID === undefined) {
    throw new Error('Filesystem-effect lease reset is only available under Vitest.');
  }
  const storage = captureEffectLeaseStorage();
  await rm(storage.statePath, { force: true });
}
