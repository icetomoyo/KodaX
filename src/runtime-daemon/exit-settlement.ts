import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

import { killPidTree, readProcessStartIdentity, withKodaXFileLock } from '@kodax-ai/agent';

import { readWindowsSandboxBootIdentity } from '../sandbox-runtime.js';
import { isRuntimeDaemonPidAlive } from './lifecycle.js';
import {
  enableRuntimeDaemonOwner,
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonShutdownOutcome,
  readRuntimeDaemonState,
  readRuntimeOwnerPolicy,
  removeRuntimeDaemonOwnershipIfUnchanged,
  resolveRuntimeDaemonPathsFromConfigHome,
  type RuntimeDaemonLockOwner,
  type RuntimeDaemonPaths,
} from './state.js';

export type RuntimeExitSettlementBlockReason =
  | 'active_work'
  | 'cleanup_failed'
  | 'cleanup_unverified'
  | 'containment_active'
  | 'containment_unavailable'
  | 'owner_changed'
  | 'owner_identity_mismatch'
  | 'owner_unverified'
  | 'stop_not_accepted';

export type RuntimeExitSettlement =
  | {
      readonly status: 'clean' | 'recovered';
      readonly repairs: readonly ('windows_process_tree' | 'windows_sandbox_acl')[];
    }
  | {
      readonly status: 'blocked';
      readonly reason: RuntimeExitSettlementBlockReason;
      readonly nextAction:
        | 'keep-open'
        | 'relaunch-space'
        | 'retry-automatically'
        | 'restart-system'
        | 'manual-recovery';
      readonly message: string;
    };

export interface RuntimeExitSettlementOwnerPolicy {
  readonly mode: 'daemon' | 'inline';
  readonly revision: number;
  readonly updatedAt: string;
}

export interface RuntimeExitSettlementRuntime {
  readonly identity: {
    readonly runtimeId: string;
    readonly mode: string;
  };
  readonly daemon: {
    inspect(): Promise<{
      readonly runtimeId: string;
      readonly revision: number;
      readonly ownerPolicy: RuntimeExitSettlementOwnerPolicy;
      readonly owner: RuntimeDaemonLockOwner;
      readonly preflight: {
        readonly blockers: readonly string[];
        readonly canStop: boolean;
      };
    }>;
    stopForInline(input: {
      readonly expectedRuntimeId: string;
      readonly expectedRevision: number;
      readonly expectedOwnerPolicyRevision: number;
      readonly operation?: { readonly operationId: string };
    }): Promise<{ readonly accepted: true }>;
  };
  close(): Promise<void>;
}

export interface RuntimeExitSettlementInput {
  readonly configHome: string;
  readonly profile?: string;
  readonly runtime?: RuntimeExitSettlementRuntime;
}

interface RuntimeExitSettlementTestInput extends RuntimeExitSettlementInput {
  readonly timeoutMs?: number;
  readonly managementPhaseTimeoutMs?: number;
  readonly runtimeCloseTimeoutMs?: number;
}

interface RuntimeExitSettlementTimeouts {
  readonly transactionMs: number;
  readonly managementPhaseMs: number;
  readonly runtimeCloseMs: number;
}

export interface RuntimeExitSettlementDependencies {
  readonly platform: NodeJS.Platform;
  readonly readWindowsBootIdentity: () => string | undefined;
  readonly readSystemBootIdentity: () => string | undefined;
  readonly isPidAlive: (pid: number) => boolean;
  readonly readProcessStartIdentity: (pid: number) => string | undefined;
  readonly waitForProcessExit: (
    pid: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  readonly killPidTree: (
    pid: number,
    expectedProcessStartIdentity: string,
    timeoutMs: number,
  ) => Promise<'already-exited' | 'terminated' | 'unknown'>;
  readonly removeRuntimeExitIntentFile: (intentPath: string, rootDir: string) => void;
}

export interface RuntimeExitSettlementIntent {
  readonly version: 1;
  readonly settlementId: string;
  readonly owner: RuntimeDaemonLockOwner;
  readonly windowsBootIdentity?: string;
  readonly systemBootIdentity?: string;
  readonly phase: 'prepared' | 'stop_accepted' | 'recovered';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastError?: string;
  readonly repairs?: readonly ('windows_process_tree' | 'windows_sandbox_acl')[];
  readonly windowsAclRecoveryScope?: 'exact-owner' | 'previous-boot';
  readonly windowsAclRecoveredOnBootIdentity?: string;
}

// The daemon's orderly cleanup contract includes memory-review durability and
// bounded child-process cleanup. Sandbox commands own only per-command state.
const ORDERLY_DAEMON_EXIT_TIMEOUT_MS = 170_000;
const PUBLIC_EXIT_TRANSACTION_TIMEOUT_MS = 480_000;
const MANAGEMENT_PHASE_TIMEOUT_MS = 10_000;
const RUNTIME_CLOSE_TIMEOUT_MS = 5_000;
const WINDOWS_JOB_EXIT_RESERVE_MS = 10_000;
const WINDOWS_SUPERVISOR_GENERATION_POLL_MS = 250;
const WINDOWS_PROCESS_TREE_RECOVERY_TIMEOUT_MS = 80_000;

const defaultDependencies: RuntimeExitSettlementDependencies = {
  platform: process.platform,
  readWindowsBootIdentity: readWindowsSandboxBootIdentity,
  readSystemBootIdentity: readPosixBootIdentity,
  isPidAlive: isRuntimeDaemonPidAlive,
  readProcessStartIdentity,
  waitForProcessExit,
  async killPidTree(pid, expectedProcessStartIdentity, timeoutMs) {
    const phaseMs = Math.max(1, Math.floor(timeoutMs / 4));
    const result = await killPidTree(pid, {
      expectedProcessStartIdentity,
      taskkillMs: Math.min(5_000, phaseMs),
      forceMs: Math.min(2_000, phaseMs),
    });
    return result.status;
  },
  removeRuntimeExitIntentFile(intentPath, rootDir) {
    fs.rmSync(intentPath, { force: true });
    fsyncDirectory(rootDir);
  },
};

/** @internal Exported only for platform evidence tests. */
export function parseLinuxBootIdentity(raw: string): string | undefined {
  const bootId = raw.trim();
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootId)
    ? `linux-boot-${bootId.toLowerCase()}`
    : undefined;
}

/** @internal Exported only for platform evidence tests. */
export function parseDarwinBootIdentity(raw: string, status: number | null): string | undefined {
  const seconds = /(?:^|[,{]\s*)sec\s*=\s*(\d+)/.exec(raw)?.[1];
  return status === 0 && seconds !== undefined ? `darwin-boot-${seconds}` : undefined;
}

/** @internal Exported only for platform evidence tests. */
export function readPosixBootIdentity(): string | undefined {
  try {
    if (process.platform === 'linux') {
      return parseLinuxBootIdentity(fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'));
    }
    if (process.platform === 'darwin') {
      const result = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
        encoding: 'utf8',
        timeout: 2_000,
        windowsHide: true,
      });
      return parseDarwinBootIdentity(result.stdout ?? '', result.status);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function settleRuntimeDaemonExit(
  input: RuntimeExitSettlementInput,
): Promise<RuntimeExitSettlement> {
  return settleRuntimeDaemonExitInternal(
    input,
    {
      transactionMs: PUBLIC_EXIT_TRANSACTION_TIMEOUT_MS,
      managementPhaseMs: MANAGEMENT_PHASE_TIMEOUT_MS,
      runtimeCloseMs: RUNTIME_CLOSE_TIMEOUT_MS,
    },
    defaultDependencies,
  );
}

/** @internal Dependency seam for deterministic lifecycle proof tests. */
export async function settleRuntimeDaemonExitForTest(
  input: RuntimeExitSettlementTestInput,
  dependencies: RuntimeExitSettlementDependencies,
): Promise<RuntimeExitSettlement> {
  return settleRuntimeDaemonExitInternal(
    input,
    {
      transactionMs: input.timeoutMs ?? PUBLIC_EXIT_TRANSACTION_TIMEOUT_MS,
      managementPhaseMs: input.managementPhaseTimeoutMs ?? MANAGEMENT_PHASE_TIMEOUT_MS,
      runtimeCloseMs: input.runtimeCloseTimeoutMs ?? RUNTIME_CLOSE_TIMEOUT_MS,
    },
    dependencies,
  );
}

async function settleRuntimeDaemonExitInternal(
  input: RuntimeExitSettlementInput,
  timeouts: RuntimeExitSettlementTimeouts,
  dependencies: RuntimeExitSettlementDependencies,
): Promise<RuntimeExitSettlement> {
  assertSettlementInput(input.configHome, timeouts);
  const paths = resolveRuntimeDaemonPathsFromConfigHome(
    input.configHome,
    input.profile ?? 'default',
  );
  let lifecycleMutationStarted = false;
  try {
    assertRuntimeExitPathBeforeCreate(paths);
    fs.mkdirSync(paths.rootDir, { recursive: true, mode: 0o700 });
    assertRuntimeExitIntentRoot(paths);
    const deadline = Date.now() + timeouts.transactionMs;
    return await withKodaXFileLock(
      path.join(paths.rootDir, 'exit-settlement.lock'),
      async () => {
        if (Date.now() >= deadline) {
          return blocked(
            'cleanup_unverified',
            'keep-open',
            'Runtime exit settlement coordinator timed out before any new mutation.',
          );
        }
        const intent = input.runtime === undefined
          ? resumeRuntimeExitIntent(paths, dependencies)
          : await requestRuntimeExit(paths, input.runtime, deadline, timeouts, dependencies);
        if (isSettlement(intent)) return intent;
        if (intent.phase === 'prepared') {
          return blocked(
            'stop_not_accepted',
            'relaunch-space',
            'Runtime exit was prepared, but daemon stop acceptance is still ambiguous. '
              + 'Reconnect management with the retained settlement identity before startup.',
          );
        }
        lifecycleMutationStarted = true;
        return settleAcceptedRuntimeExit(paths, intent, deadline, dependencies);
      },
      timeouts.transactionMs,
    );
  } catch (error: unknown) {
    return settlementFailure(paths, error, lifecycleMutationStarted);
  }
}

function settlementFailure(
  paths: RuntimeDaemonPaths,
  error: unknown,
  lifecycleMutationStarted: boolean,
): RuntimeExitSettlement {
  const message = errorMessage(error);
  try {
    assertRuntimeExitIntentRoot(paths);
    const intent = readSingleRuntimeExitIntent(paths);
    const inlinePolicy = readRuntimeOwnerPolicy(paths).mode === 'inline';
    return blocked(
      'cleanup_unverified',
      lifecycleMutationStarted || intent !== undefined || inlinePolicy ? 'relaunch-space' : 'keep-open',
      `Runtime exit settlement failed at a durable lifecycle boundary: ${message}`,
    );
  } catch (ticketError: unknown) {
    return blocked(
      'owner_unverified',
      'manual-recovery',
      `Runtime exit settlement state is unreadable: ${errorMessage(ticketError)} (${message})`,
    );
  }
}

export function readRuntimeExitSettlementIntent(
  configHome: string,
  profile = 'default',
): RuntimeExitSettlementIntent | undefined {
  return readSingleRuntimeExitIntent(
    resolveRuntimeDaemonPathsFromConfigHome(configHome, profile),
  );
}

async function requestRuntimeExit(
  paths: RuntimeDaemonPaths,
  runtime: RuntimeExitSettlementRuntime,
  deadline: number,
  timeouts: RuntimeExitSettlementTimeouts,
  dependencies: RuntimeExitSettlementDependencies,
): Promise<RuntimeExitSettlementIntent | RuntimeExitSettlement> {
  const inspected = await runBounded(
    () => runtime.daemon.inspect(),
    deadline,
    timeouts.managementPhaseMs,
  );
  if (inspected.status !== 'fulfilled') {
    return blocked(
      'cleanup_unverified',
      'keep-open',
      inspected.status === 'timed_out'
        ? 'Runtime daemon inspection timed out before any exit mutation.'
        : `Runtime daemon inspection failed: ${errorMessage(inspected.error)}`,
    );
  }
  const management = inspected.value;
  if (!management.preflight.canStop) {
    return blocked(
      'active_work',
      'keep-open',
      `Runtime daemon cannot stop safely: ${management.preflight.blockers.join(', ') || 'active work'}.`,
    );
  }
  assertManagedOwner(runtime, management.runtimeId, management.owner);
  const currentOwner = readRuntimeDaemonLockOwner(paths.lockFile);
  if (!sameOwner(currentOwner, management.owner)) {
    return blocked(
      'owner_changed',
      'keep-open',
      'Runtime daemon owner changed before exit settlement could be prepared.',
    );
  }
  const currentState = readRuntimeDaemonState(paths);
  if (currentState === undefined) {
    return blocked(
      'owner_unverified',
      'keep-open',
      fs.existsSync(paths.stateFile)
        ? 'Runtime daemon state is unreadable before exit settlement.'
        : 'Runtime daemon state is missing before exit settlement.',
    );
  }
  if (
    currentState !== undefined
    && (currentState.runtimeId !== management.owner.runtimeId
      || currentState.pid !== management.owner.pid)
  ) {
    return blocked(
      'owner_changed',
      'keep-open',
      'Runtime daemon state changed before exit settlement could be prepared.',
    );
  }
  const existingIntent = readSingleRuntimeExitIntent(paths);
  if (existingIntent !== undefined) {
    if (!sameOwner(existingIntent.owner, management.owner)) {
      if (existingIntent.phase !== 'prepared' || readRuntimeOwnerPolicy(paths).mode !== 'daemon') {
        return blocked(
          'owner_changed',
          'keep-open',
          'A different accepted Runtime exit settlement is pending for this profile.',
        );
      }
      clearRuntimeExitIntent(paths, existingIntent, dependencies);
    } else if (existingIntent.phase !== 'prepared') {
      await closeRuntimeBounded(runtime, existingIntent, paths, deadline, timeouts.runtimeCloseMs);
      return existingIntent;
    } else if (readRuntimeOwnerPolicy(paths).mode === 'inline') {
      const accepted = writeRuntimeExitIntent(paths, {
        ...existingIntent,
        phase: 'stop_accepted',
        updatedAt: new Date().toISOString(),
      });
      await closeRuntimeBounded(runtime, accepted, paths, deadline, timeouts.runtimeCloseMs);
      return accepted;
    }
  }

  const windowsBootIdentity = dependencies.platform === 'win32'
    ? dependencies.readWindowsBootIdentity()
    : undefined;
  const systemBootIdentity = dependencies.platform === 'linux' || dependencies.platform === 'darwin'
    ? dependencies.readSystemBootIdentity()
    : undefined;
  if (dependencies.platform === 'win32') {
    const validation = validateWindowsOwner({
      version: 1,
      settlementId: existingIntent?.settlementId ?? randomUUID(),
      owner: management.owner,
      ...(windowsBootIdentity === undefined ? {} : { windowsBootIdentity }),
      phase: 'prepared',
      createdAt: existingIntent?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, 'keep-open');
    if (validation !== undefined) return validation;
  }
  if (
    (dependencies.platform === 'linux' || dependencies.platform === 'darwin')
    && systemBootIdentity === undefined
  ) {
    return blocked(
      'containment_unavailable',
      'keep-open',
      'POSIX exit recovery requires a durable operating-system boot identity.',
    );
  }

  let intent = writeRuntimeExitIntent(paths, {
    version: 1,
    settlementId: existingIntent?.settlementId ?? randomUUID(),
    owner: management.owner,
    ...(windowsBootIdentity === undefined ? {} : { windowsBootIdentity }),
    ...(systemBootIdentity === undefined ? {} : { systemBootIdentity }),
    phase: 'prepared',
    createdAt: existingIntent?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // The settlement ID identifies the durable lifecycle ticket. Each transport
  // attempt needs its own control-journal identity because reconnecting changes
  // the management revision and therefore the request digest.
  const stopOperationId = randomUUID();
  const stopped = await runBounded(() => runtime.daemon.stopForInline({
      expectedRuntimeId: management.runtimeId,
      expectedRevision: management.revision,
      expectedOwnerPolicyRevision: management.ownerPolicy.revision,
      operation: { operationId: stopOperationId },
    }), deadline, timeouts.managementPhaseMs);
  let stopWarning: string | undefined;
  if (stopped.status !== 'fulfilled') {
    const policy = readRuntimeOwnerPolicy(paths);
    const owner = readRuntimeDaemonLockOwner(paths.lockFile);
    if (policy.mode !== 'inline' || !sameOwner(owner, management.owner)) {
      await closeRuntimeBounded(runtime, intent, paths, deadline, timeouts.runtimeCloseMs);
      return blocked(
        'stop_not_accepted',
        'relaunch-space',
        stopped.status === 'timed_out'
          ? 'Runtime stop acceptance was ambiguous; relaunch is required to resume the durable intent.'
          : `Runtime stop could not be confirmed: ${errorMessage(stopped.error)}`,
      );
    }
    stopWarning = stopped.status === 'timed_out'
      ? 'Runtime stop response timed out after the inline policy was durably committed.'
      : errorMessage(stopped.error);
  }
  intent = writeRuntimeExitIntent(paths, {
    ...intent,
    phase: 'stop_accepted',
    updatedAt: new Date().toISOString(),
    ...(stopWarning === undefined ? {} : { lastError: stopWarning }),
  });
  return closeRuntimeBounded(runtime, intent, paths, deadline, timeouts.runtimeCloseMs);
}

async function closeRuntimeBounded(
  runtime: RuntimeExitSettlementRuntime,
  intent: RuntimeExitSettlementIntent,
  paths: RuntimeDaemonPaths,
  deadline: number,
  closeTimeoutMs: number,
): Promise<RuntimeExitSettlementIntent> {
  const closed = await runBounded(
    () => runtime.close(),
    deadline,
    closeTimeoutMs,
  );
  if (closed.status === 'fulfilled') return intent;
  return writeRuntimeExitIntent(paths, {
    ...intent,
    updatedAt: new Date().toISOString(),
    lastError: closed.status === 'timed_out'
      ? 'Runtime transport close timed out; durable daemon settlement continued.'
      : errorMessage(closed.error),
  });
}

type BoundedResult<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'timed_out' };

async function runBounded<T>(
  operation: () => Promise<T>,
  deadline: number,
  phaseTimeoutMs: number,
): Promise<BoundedResult<T>> {
  const timeoutMs = Math.max(1, Math.min(phaseTimeoutMs, remainingTimeoutMs(deadline)));
  let timer: NodeJS.Timeout | undefined;
  const operationResult = Promise.resolve()
    .then(operation)
    .then<BoundedResult<T>>(
      (value) => ({ status: 'fulfilled', value }),
      (error: unknown) => ({ status: 'rejected', error }),
    );
  const timedOut = new Promise<BoundedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timed_out' }), timeoutMs);
  });
  try {
    return await Promise.race([operationResult, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resumeRuntimeExitIntent(
  paths: RuntimeDaemonPaths,
  dependencies: RuntimeExitSettlementDependencies,
): RuntimeExitSettlementIntent | RuntimeExitSettlement {
  const existing = readSingleRuntimeExitIntent(paths);
  if (existing !== undefined) {
    if (existing.phase !== 'prepared') return existing;
    const policy = readRuntimeOwnerPolicy(paths);
    const currentOwner = readRuntimeDaemonLockOwner(paths.lockFile);
    if (policy.mode === 'inline') {
      if (!sameOwner(currentOwner, existing.owner)) {
        return blocked(
          'owner_changed',
          'manual-recovery',
          'An inline Runtime exit intent no longer matches the durable owner.',
        );
      }
      return writeRuntimeExitIntent(paths, {
        ...existing,
        phase: 'stop_accepted',
        updatedAt: new Date().toISOString(),
      });
    }
    if (currentOwner === undefined) {
      if (fs.existsSync(paths.lockFile)) {
        return blocked('owner_unverified', 'manual-recovery', 'Runtime owner lock is unreadable.');
      }
      clearRuntimeExitIntent(paths, existing, dependencies);
      return blocked(
        'stop_not_accepted',
        'keep-open',
        'The unaccepted Runtime exit intent was stale and has been cleared.',
      );
    }
    if (!sameOwner(currentOwner, existing.owner)) {
      clearRuntimeExitIntent(paths, existing, dependencies);
      return blocked(
        'owner_changed',
        'keep-open',
        'A replacement Runtime owner is active; the stale prepared intent was cleared.',
      );
    }
    return existing;
  }

  const owner = readRuntimeDaemonLockOwner(paths.lockFile);
  const state = readRuntimeDaemonState(paths);
  const policy = readRuntimeOwnerPolicy(paths);
  if (owner === undefined) {
    if (fs.existsSync(paths.lockFile)) {
      return blocked('owner_unverified', 'manual-recovery', 'Runtime owner lock is unreadable.');
    }
    if (fs.existsSync(paths.stateFile)) {
      return blocked('owner_unverified', 'keep-open', 'Runtime daemon state has no verified owner.');
    }
    if (policy.mode === 'daemon') {
      return { status: 'clean', repairs: [] };
    }
    return blocked(
      'stop_not_accepted',
      'keep-open',
      'Runtime owner policy is inline without a daemon exit intent or retained owner.',
    );
  }
  const legacyAccepted = policy.mode === 'inline'
    && owner.kind === 'daemon'
    && state?.runtimeId === owner.runtimeId
    && state.pid === owner.pid;
  if (!legacyAccepted) {
    return blocked(
      'stop_not_accepted',
      'keep-open',
      'No SDK exit intent or legacy accepted rollback was found.',
    );
  }
  const now = new Date().toISOString();
  const candidate: RuntimeExitSettlementIntent = {
    version: 1,
    settlementId: randomUUID(),
    owner,
    ...(dependencies.platform === 'win32'
      ? { windowsBootIdentity: dependencies.readWindowsBootIdentity() }
      : {}),
    ...((dependencies.platform === 'linux' || dependencies.platform === 'darwin')
      ? { systemBootIdentity: dependencies.readSystemBootIdentity() }
      : {}),
    phase: 'stop_accepted',
    createdAt: now,
    updatedAt: now,
  };
  if (dependencies.platform === 'win32') {
    const validation = validateWindowsOwner(candidate, 'retry-automatically');
    if (validation !== undefined) return validation;
  }
  if (
    (dependencies.platform === 'linux' || dependencies.platform === 'darwin')
    && candidate.systemBootIdentity === undefined
  ) {
    return blocked(
      'containment_unavailable',
      'manual-recovery',
      'The retained POSIX owner has no verifiable operating-system boot identity.',
    );
  }
  return writeRuntimeExitIntent(paths, candidate);
}

async function settleAcceptedRuntimeExit(
  paths: RuntimeDaemonPaths,
  intent: RuntimeExitSettlementIntent,
  deadline: number,
  dependencies: RuntimeExitSettlementDependencies,
): Promise<RuntimeExitSettlement> {
  const owner = intent.owner;
  if (intent.phase === 'recovered') {
    if (dependencies.platform !== 'win32') {
      return blocked(
        'owner_unverified',
        'manual-recovery',
        'A Windows Runtime recovery ticket cannot authorize POSIX owner cleanup.',
      );
    }
    const ownerValidation = validateWindowsOwner(intent, 'retry-automatically');
    if (ownerValidation !== undefined) return ownerValidation;
    return finalizeRecoveredExit(paths, intent, dependencies);
  }

  if (dependencies.platform === 'win32') {
    const ownerValidation = validateWindowsOwner(intent, 'retry-automatically');
    if (ownerValidation !== undefined) return ownerValidation;
  }
  const currentOwner = readRuntimeDaemonLockOwner(paths.lockFile);
  if (currentOwner !== undefined && !sameOwner(currentOwner, owner)) {
    return blocked('owner_changed', 'relaunch-space', 'A replacement Runtime owner is active.');
  }

  const currentBootIdentity = dependencies.platform === 'win32'
    ? dependencies.readWindowsBootIdentity()
    : undefined;
  if (dependencies.platform === 'win32' && currentBootIdentity === undefined) {
    return blocked(
      'containment_unavailable',
      'retry-automatically',
      'The current Windows boot identity could not be verified.',
    );
  }
  const previousWindowsBoot = dependencies.platform === 'win32'
    && intent.windowsBootIdentity !== undefined
    && currentBootIdentity !== undefined
    && intent.windowsBootIdentity !== currentBootIdentity;
  const currentSystemBootIdentity = dependencies.platform === 'linux'
    || dependencies.platform === 'darwin'
    ? dependencies.readSystemBootIdentity()
    : undefined;
  if (
    (dependencies.platform === 'linux' || dependencies.platform === 'darwin')
    && currentSystemBootIdentity === undefined
  ) {
    return blocked(
      'containment_unavailable',
      'manual-recovery',
      'The current POSIX operating-system boot identity could not be verified.',
    );
  }
  const previousSystemBoot = currentSystemBootIdentity !== undefined
    && intent.systemBootIdentity !== undefined
    && intent.systemBootIdentity !== currentSystemBootIdentity;
  const previousBoot = previousWindowsBoot || previousSystemBoot;
  if (remainingTimeoutMs(deadline) <= 0) {
    return settlementDeadlineBlocked(dependencies.platform);
  }
  const gracefullyExited = previousBoot
    || await waitForOrderlyDaemonExit(
      paths,
      owner,
      Math.min(
        ORDERLY_DAEMON_EXIT_TIMEOUT_MS,
        daemonExitBudgetMs(deadline, dependencies.platform),
      ),
      dependencies,
    );
  const repairs: Array<'windows_process_tree' | 'windows_sandbox_acl'> = [];
  let retainedOwnerAlive = !previousBoot
    && !gracefullyExited
    && dependencies.isPidAlive(owner.pid);
  if (retainedOwnerAlive) {
    if (dependencies.platform !== 'win32') {
      return blocked(
        'cleanup_unverified',
        'manual-recovery',
        posixManualRecoveryMessage(paths),
      );
    }
    const currentIdentity = dependencies.readProcessStartIdentity(owner.pid);
    if (currentIdentity === undefined) {
      if (dependencies.isPidAlive(owner.pid)) {
        return blocked(
          'owner_identity_mismatch',
          'retry-automatically',
          'The retained daemon PID process identity could not be verified.',
        );
      }
      retainedOwnerAlive = false;
    }
    if (retainedOwnerAlive && currentIdentity !== owner.processStartIdentity) {
      // A readable different generation proves the retained owner exited.
      // Never signal the replacement process that reused its numeric PID.
      retainedOwnerAlive = false;
    } else if (retainedOwnerAlive) {
      if (remainingTimeoutMs(deadline) < WINDOWS_PROCESS_TREE_RECOVERY_TIMEOUT_MS) {
        return settlementDeadlineBlocked(dependencies.platform);
      }
      const killed = await dependencies.killPidTree(
        owner.pid,
        owner.processStartIdentity!,
        WINDOWS_PROCESS_TREE_RECOVERY_TIMEOUT_MS,
      );
      if (
        killed === 'unknown'
        || !await dependencies.waitForProcessExit(
          owner.pid,
          Math.min(1_000, remainingTimeoutMs(deadline)),
        )
      ) {
        return blocked(
          'cleanup_unverified',
          'retry-automatically',
          'The exact Windows daemon process tree did not prove that it exited.',
        );
      }
      retainedOwnerAlive = false;
      repairs.push('windows_process_tree');
    }
  }

  // Every retained-owner path above either blocks or proves the exact process
  // generation exited before recovery continues.
  if (
    dependencies.platform === 'win32'
    && !previousWindowsBoot
    && !await waitForWindowsSupervisorGenerationExit(
      owner,
      Math.min(WINDOWS_JOB_EXIT_RESERVE_MS, remainingTimeoutMs(deadline)),
      dependencies,
    )
  ) {
    return blocked(
      'containment_active',
      'retry-automatically',
      'Windows Job containment has not proved that the Runtime process tree is empty.',
    );
  }

  const replacement = readRuntimeDaemonLockOwner(paths.lockFile);
  if (replacement !== undefined && !sameOwner(replacement, owner)) {
    return blocked('owner_changed', 'relaunch-space', 'A replacement Runtime owner became active.');
  }
  const outcome = readRuntimeDaemonShutdownOutcome(paths, owner);
  if (outcome?.status === 'succeeded') {
    if (!removeExactOwnership(paths, owner)) {
      return blocked('owner_changed', 'relaunch-space', 'Runtime ownership changed during cleanup.');
    }
    restoreDaemonPolicy(paths);
    clearRuntimeExitIntent(paths, intent, dependencies);
    return { status: 'clean', repairs };
  }
  if (dependencies.platform !== 'win32') {
    if (previousSystemBoot) {
      if (!removeExactOwnership(paths, owner)) {
        return blocked('owner_changed', 'relaunch-space', 'Runtime ownership changed during recovery.');
      }
      restoreDaemonPolicy(paths);
      clearRuntimeExitIntent(paths, intent, dependencies);
      return { status: 'recovered', repairs };
    }
    return blocked(
      outcome?.status === 'failed' ? 'cleanup_failed' : 'cleanup_unverified',
      'manual-recovery',
      `${outcome?.error ?? 'Runtime exited without a successful durable cleanup outcome.'} `
        + posixManualRecoveryMessage(paths),
    );
  }

  // Windows v2 grants filesystem authority only through each target's
  // restricted token/capability SID. Pre-v2 ACL owner and poison records are
  // historical diagnostics and never authorize, block, repair, or clear a v2
  // Runtime exit. Exact process-generation and Job-drain evidence above remain
  // the authoritative crash-recovery boundary.
  const recovered = writeRuntimeExitIntent(paths, {
    ...intent,
    phase: 'recovered',
    updatedAt: new Date().toISOString(),
    repairs,
  });
  return finalizeRecoveredExit(paths, recovered, dependencies, repairs);
}

async function waitForWindowsSupervisorGenerationExit(
  owner: RuntimeDaemonLockOwner,
  timeoutMs: number,
  dependencies: RuntimeExitSettlementDependencies,
): Promise<boolean> {
  const supervisorPid = owner.supervisorPid!;
  const expectedIdentity = owner.supervisorProcessStartIdentity;
  if (expectedIdentity === undefined) {
    // Legacy owner/ticket compatibility: PID-only evidence may delay recovery,
    // but it never authorizes signalling or assumes that a replacement exited.
    return dependencies.waitForProcessExit(supervisorPid, timeoutMs);
  }
  let remainingMs = timeoutMs;
  while (remainingMs > 0) {
    if (supervisorGenerationExited(supervisorPid, expectedIdentity, dependencies)) return true;
    const pollMs = Math.min(WINDOWS_SUPERVISOR_GENERATION_POLL_MS, remainingMs);
    if (await dependencies.waitForProcessExit(supervisorPid, pollMs)) return true;
    remainingMs -= pollMs;
  }
  return supervisorGenerationExited(supervisorPid, expectedIdentity, dependencies);
}

function supervisorGenerationExited(
  supervisorPid: number,
  expectedIdentity: string,
  dependencies: RuntimeExitSettlementDependencies,
): boolean {
  const currentIdentity = dependencies.readProcessStartIdentity(supervisorPid);
  if (currentIdentity !== undefined) return currentIdentity !== expectedIdentity;
  return !dependencies.isPidAlive(supervisorPid);
}

function posixManualRecoveryMessage(paths: RuntimeDaemonPaths): string {
  return 'The retained POSIX process tree cannot be settled safely without its original '
    + 'kernel-backed supervisor. Keep the retained settlement ticket, restart the operating '
    + 'system, then launch Space normally so the SDK can verify the changed boot identity and '
    + `settle "${runtimeExitIntentPath(paths)}". Do not delete the profile or Session data.`;
}

function daemonExitBudgetMs(deadline: number, platform: NodeJS.Platform): number {
  const remaining = remainingTimeoutMs(deadline);
  if (platform !== 'win32') return remaining;
  const recoveryReserveMs = WINDOWS_JOB_EXIT_RESERVE_MS
    + WINDOWS_PROCESS_TREE_RECOVERY_TIMEOUT_MS;
  return Math.max(1, remaining - Math.min(recoveryReserveMs, Math.max(0, remaining - 1)));
}

function remainingTimeoutMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function finalizeRecoveredExit(
  paths: RuntimeDaemonPaths,
  intent: RuntimeExitSettlementIntent,
  dependencies: RuntimeExitSettlementDependencies,
  repairs: readonly ('windows_process_tree' | 'windows_sandbox_acl')[] = intent.repairs ?? [],
): Promise<RuntimeExitSettlement> {
  if (!removeExactOwnership(paths, intent.owner)) {
    return blocked('owner_changed', 'relaunch-space', 'Runtime ownership changed during recovery.');
  }
  try {
    restoreDaemonPolicy(paths);
  } catch (error: unknown) {
    return blocked(
      'owner_unverified',
      'manual-recovery',
      error instanceof Error ? error.message : String(error),
    );
  }
  clearRuntimeExitIntent(paths, intent, dependencies);
  return { status: 'recovered', repairs };
}

function removeExactOwnership(paths: RuntimeDaemonPaths, owner: RuntimeDaemonLockOwner): boolean {
  const currentOwner = readRuntimeDaemonLockOwner(paths.lockFile);
  const currentState = readRuntimeDaemonState(paths);
  if (currentOwner === undefined && currentState === undefined) {
    return !fs.existsSync(paths.lockFile) && !fs.existsSync(paths.stateFile);
  }
  if (!sameOwner(currentOwner, owner)) return false;
  if (
    currentState !== undefined
    && (currentState.runtimeId !== owner.runtimeId || currentState.pid !== owner.pid)
  ) return false;
  return removeRuntimeDaemonOwnershipIfUnchanged(paths, {
    ...(currentState === undefined ? {} : { state: currentState }),
    lockOwner: owner,
  });
}

function restoreDaemonPolicy(paths: RuntimeDaemonPaths): void {
  if (readRuntimeOwnerPolicy(paths).mode === 'inline') enableRuntimeDaemonOwner(paths);
}

function validateWindowsOwner(
  intent: RuntimeExitSettlementIntent,
  nextAction: Extract<RuntimeExitSettlement, { status: 'blocked' }>['nextAction'],
): RuntimeExitSettlement | undefined {
  const owner = intent.owner;
  if (
    intent.windowsBootIdentity === undefined
    || owner.processStartIdentity === undefined
    || owner.processContainment !== 'windows-job'
    || !Number.isSafeInteger(owner.supervisorPid)
    || owner.supervisorPid! <= 0
  ) {
    return blocked(
      'containment_unavailable',
      nextAction,
      'Windows exit recovery requires exact daemon identity and Job containment metadata.',
    );
  }
  return undefined;
}

function assertManagedOwner(
  runtime: RuntimeExitSettlementRuntime,
  runtimeId: string,
  owner: RuntimeDaemonLockOwner,
): void {
  if (
    runtime.identity.mode !== 'daemon'
    || runtime.identity.runtimeId !== runtimeId
    || owner.kind !== 'daemon'
    || owner.runtimeId !== runtimeId
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
  ) {
    throw new Error('Runtime exit settlement received an invalid daemon owner identity.');
  }
}

function runtimeExitIntentPath(paths: RuntimeDaemonPaths): string {
  return path.join(paths.rootDir, 'exit-settlement.json');
}

function writeRuntimeExitIntent(
  paths: RuntimeDaemonPaths,
  intent: RuntimeExitSettlementIntent,
): RuntimeExitSettlementIntent {
  fs.mkdirSync(paths.rootDir, { recursive: true, mode: 0o700 });
  assertRuntimeExitIntentRoot(paths);
  const target = runtimeExitIntentPath(paths);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    fsyncDirectory(paths.rootDir);
    return intent;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readSingleRuntimeExitIntent(
  paths: RuntimeDaemonPaths,
): RuntimeExitSettlementIntent | undefined {
  const file = runtimeExitIntentPath(paths);
  if (!fs.existsSync(file)) return undefined;
  try {
    assertRuntimeExitIntentRoot(paths);
    const beforeOpen = fs.lstatSync(file);
    assertRegularSettlementFile(beforeOpen);
    if (normalizeComparablePath(fs.realpathSync(file)) !== normalizeComparablePath(file)) {
      throw new Error('Runtime exit settlement intent crosses a symbolic link.');
    }
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const fileStat = fs.fstatSync(fd);
      const afterOpen = fs.lstatSync(file);
      assertRegularSettlementFile(fileStat);
      assertRegularSettlementFile(afterOpen);
      if (!sameFileIdentity(beforeOpen, fileStat) || !sameFileIdentity(fileStat, afterOpen)) {
        throw new Error('Runtime exit settlement intent changed while it was opened.');
      }
      const parsed: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (!isRuntimeExitSettlementIntent(parsed)) {
        throw new Error('Runtime exit settlement intent is corrupt.');
      }
      return parsed;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error: unknown) {
    throw new Error('Runtime exit settlement intent is unreadable.', { cause: error });
  }
}

function assertRegularSettlementFile(stat: fs.Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('Runtime exit settlement intent is not a private regular file.');
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRuntimeExitIntentRoot(paths: RuntimeDaemonPaths): void {
  const rootStat = fs.lstatSync(paths.rootDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Runtime exit settlement directory is not a regular directory.');
  }
  const lexicalRoot = normalizeComparablePath(path.resolve(paths.rootDir));
  const physicalRoot = normalizeComparablePath(fs.realpathSync(paths.rootDir));
  if (lexicalRoot !== physicalRoot) {
    throw new Error('Runtime exit settlement directory crosses a symbolic-link ancestor.');
  }
}

function assertRuntimeExitPathBeforeCreate(paths: RuntimeDaemonPaths): void {
  const configHome = path.resolve(paths.configHome);
  const relativeRoot = path.relative(configHome, path.resolve(paths.rootDir));
  if (relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot)) {
    throw new Error('Runtime exit settlement directory escapes configHome.');
  }
  let current = configHome;
  for (const segment of ['', ...relativeRoot.split(path.sep).filter(Boolean)]) {
    if (segment !== '') current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (segment === '' && !stat.isDirectory())) {
      throw new Error('Runtime exit settlement path contains a symbolic link.');
    }
    if (normalizeComparablePath(fs.realpathSync(current)) !== normalizeComparablePath(current)) {
      throw new Error('Runtime exit settlement path crosses a symbolic-link ancestor.');
    }
  }
}

function normalizeComparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function clearRuntimeExitIntent(
  paths: RuntimeDaemonPaths,
  intent: RuntimeExitSettlementIntent,
  dependencies: RuntimeExitSettlementDependencies,
): void {
  const current = readSingleRuntimeExitIntent(paths);
  if (current?.settlementId !== intent.settlementId) {
    throw new Error('Runtime exit settlement intent changed before completion.');
  }
  dependencies.removeRuntimeExitIntentFile(runtimeExitIntentPath(paths), paths.rootDir);
}

function isRuntimeExitSettlementIntent(value: unknown): value is RuntimeExitSettlementIntent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as Readonly<Record<string, unknown>>;
  return intent.version === 1
    && typeof intent.settlementId === 'string'
    && isRuntimeDaemonOwner(intent.owner)
    && intent.owner.kind === 'daemon'
    && (intent.windowsBootIdentity === undefined
      || (typeof intent.windowsBootIdentity === 'string'
        && /^windows-boot-\d+$/.test(intent.windowsBootIdentity)))
    && (intent.systemBootIdentity === undefined
      || (typeof intent.systemBootIdentity === 'string'
        && (/^linux-boot-[0-9a-f-]{36}$/i.test(intent.systemBootIdentity)
          || /^darwin-boot-\d+$/.test(intent.systemBootIdentity))))
    && (intent.phase === 'prepared'
      || intent.phase === 'stop_accepted'
      || intent.phase === 'recovered')
    && typeof intent.createdAt === 'string'
    && typeof intent.updatedAt === 'string'
    && (intent.lastError === undefined || typeof intent.lastError === 'string')
    && (intent.windowsAclRecoveryScope === undefined
      || intent.windowsAclRecoveryScope === 'exact-owner'
      || intent.windowsAclRecoveryScope === 'previous-boot')
    && (intent.windowsAclRecoveredOnBootIdentity === undefined
      || (typeof intent.windowsAclRecoveredOnBootIdentity === 'string'
        && /^windows-boot-\d+$/.test(intent.windowsAclRecoveredOnBootIdentity)))
    && (intent.windowsAclRecoveryScope !== 'previous-boot'
      || typeof intent.windowsAclRecoveredOnBootIdentity === 'string')
    && (intent.repairs === undefined || (
      Array.isArray(intent.repairs)
      && intent.repairs.every((repair) => (
        repair === 'windows_process_tree' || repair === 'windows_sandbox_acl'
      ))
    ));
}

function isRuntimeDaemonOwner(value: unknown): value is RuntimeDaemonLockOwner {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Readonly<Record<string, unknown>>;
  return typeof owner.runtimeId === 'string'
    && Number.isSafeInteger(owner.pid)
    && Number(owner.pid) > 0
    && typeof owner.createdAt === 'string'
    && (owner.kind === undefined || owner.kind === 'daemon' || owner.kind === 'inline')
    && (owner.processStartIdentity === undefined || typeof owner.processStartIdentity === 'string')
    && (owner.processContainment === undefined || owner.processContainment === 'windows-job')
    && (owner.supervisorPid === undefined || (
      Number.isSafeInteger(owner.supervisorPid) && Number(owner.supervisorPid) > 0
    ))
    && (owner.supervisorProcessStartIdentity === undefined
      || (typeof owner.supervisorProcessStartIdentity === 'string'
        && owner.supervisorProcessStartIdentity.length > 0))
    && (owner.processContainment === 'windows-job'
      || owner.supervisorProcessStartIdentity === undefined);
}

function sameOwner(
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

function blocked(
  reason: RuntimeExitSettlementBlockReason,
  nextAction: Extract<RuntimeExitSettlement, { status: 'blocked' }>['nextAction'],
  message: string,
): RuntimeExitSettlement {
  return { status: 'blocked', reason, nextAction, message };
}

function settlementDeadlineBlocked(platform: NodeJS.Platform): RuntimeExitSettlement {
  return blocked(
    'cleanup_unverified',
    platform === 'win32' ? 'retry-automatically' : 'manual-recovery',
    'Runtime exit settlement reached its fixed transaction deadline before cleanup was proved.',
  );
}

function isSettlement(
  value: RuntimeExitSettlementIntent | RuntimeExitSettlement,
): value is RuntimeExitSettlement {
  return 'status' in value;
}

function assertSettlementInput(
  configHome: string,
  timeouts: RuntimeExitSettlementTimeouts,
): void {
  if (!path.isAbsolute(configHome)) {
    throw new Error('Runtime exit settlement requires an absolute configHome.');
  }
  if (Object.values(timeouts).some((timeoutMs) => (
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
  ))) {
    throw new Error('Runtime exit settlement timeouts must be positive integers.');
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isRuntimeDaemonPidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    if (signal?.aborted) return false;
    await waitForExitPoll(signal);
  }
  return true;
}

async function waitForExitPoll(signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, 25);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function waitForOrderlyDaemonExit(
  paths: RuntimeDaemonPaths,
  owner: RuntimeDaemonLockOwner,
  timeoutMs: number,
  dependencies: RuntimeExitSettlementDependencies,
): Promise<boolean> {
  if (dependencies.platform !== 'win32') {
    return dependencies.waitForProcessExit(owner.pid, timeoutMs);
  }
  if (readRuntimeDaemonShutdownOutcome(paths, owner)?.status === 'failed') return false;

  const processExitController = new AbortController();
  let stopWatchingOutcome = false;
  const processExit = dependencies.waitForProcessExit(
    owner.pid,
    timeoutMs,
    processExitController.signal,
  ).then(
    (exited) => ({ kind: 'process-exit' as const, exited }),
  );
  const cleanupFailure = waitForDurableCleanupFailure(
    paths,
    owner,
    timeoutMs,
    () => stopWatchingOutcome,
  ).then((failed) => ({ kind: 'cleanup-failure' as const, failed }));
  try {
    const observation = await Promise.race([processExit, cleanupFailure]);
    return observation.kind === 'process-exit' ? observation.exited : false;
  } finally {
    stopWatchingOutcome = true;
    processExitController.abort();
  }
}

async function waitForDurableCleanupFailure(
  paths: RuntimeDaemonPaths,
  owner: RuntimeDaemonLockOwner,
  timeoutMs: number,
  isCancelled: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!isCancelled()) {
    if (readRuntimeDaemonShutdownOutcome(paths, owner)?.status === 'failed') return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
