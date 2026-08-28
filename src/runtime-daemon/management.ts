import type {
  KodaXRuntime,
  RuntimeDaemonClientSnapshot,
  RuntimeDaemonManagementState,
  RuntimeDaemonPreflight,
  RuntimeDaemonRollbackInput,
  RuntimeDaemonRollbackResult,
  RuntimeIntegrationDomainStatus,
} from '../sdk-runtime.js';
import type { RuntimeDaemonMethod } from './protocol.js';
import {
  appendRuntimeDaemonLog,
  commitRuntimeDaemonRollbackPolicy,
  readRuntimeDaemonLockOwner,
  readRuntimeOwnerPolicy,
  type RuntimeDaemonPaths,
} from './state.js';

export interface RuntimeDaemonManagementController {
  armOrphanExitAfterReady(): void;
  attachClient(client: RuntimeDaemonClientSnapshot): void;
  detachClient(connectionId: string): void;
  runMutation<T>(method: RuntimeDaemonMethod, effect: () => Promise<T>): Promise<T>;
  preflight(): Promise<RuntimeDaemonPreflight>;
  inspect(): Promise<RuntimeDaemonManagementState>;
  stop(): Promise<{ readonly ok: true }>;
  rollbackToInline(input: RuntimeDaemonRollbackInput): Promise<RuntimeDaemonRollbackResult>;
  close(): void;
}

export function createRuntimeDaemonManagementController(input: {
  readonly runtime: KodaXRuntime;
  readonly paths: RuntimeDaemonPaths;
  readonly requestStop: () => void;
  /**
   * When set, a daemon that has observed at least one logical client stops
   * itself after the final client disconnects and all governed work is idle.
   * Omitted for ordinary CLI-owned daemons, which remain persistent.
   */
  readonly orphanExitMs?: number;
  readonly integrationStatuses?: () => readonly RuntimeIntegrationDomainStatus[];
}): RuntimeDaemonManagementController {
  return new DaemonManagementController(input);
}

class DaemonManagementController implements RuntimeDaemonManagementController {
  private readonly clients = new Map<string, RuntimeDaemonClientSnapshot>();
  private revision = 0;
  private activeMutations = 0;
  private readonly activeMutationMethods = new Map<RuntimeDaemonMethod, number>();
  private draining = false;
  private closed = false;
  private preflightFingerprint: string | undefined;
  private orphanExitArmed = false;
  private clientGeneration = 0;
  private orphanExitTimer: ReturnType<typeof setTimeout> | undefined;
  private orphanExitCheckRunning = false;
  private orphanBlockerFingerprint: string | undefined;

  constructor(private readonly input: {
    readonly runtime: KodaXRuntime;
    readonly paths: RuntimeDaemonPaths;
    readonly requestStop: () => void;
    readonly orphanExitMs?: number;
    readonly integrationStatuses?: () => readonly RuntimeIntegrationDomainStatus[];
  }) {
  }

  armOrphanExitAfterReady(): void {
    if (this.input.orphanExitMs === undefined || this.closed || this.draining) return;
    this.orphanExitArmed = true;
    this.scheduleOrphanExitCheck(this.input.orphanExitMs);
  }

  attachClient(client: RuntimeDaemonClientSnapshot): void {
    if (this.draining || this.closed) {
      throw managementError('conflict', 'Runtime daemon is draining and cannot attach another client.');
    }
    if (this.clients.has(client.daemonConnectionId)) return;
    this.clients.set(client.daemonConnectionId, { ...client });
    this.orphanExitArmed = true;
    this.clientGeneration += 1;
    this.cancelOrphanExitCheck();
    this.orphanBlockerFingerprint = undefined;
    this.revision += 1;
  }

  detachClient(connectionId: string): void {
    if (!this.clients.delete(connectionId)) return;
    this.clientGeneration += 1;
    this.revision += 1;
    if (this.clients.size === 0) this.scheduleOrphanExitCheck(this.input.orphanExitMs);
  }

  async runMutation<T>(method: RuntimeDaemonMethod, effect: () => Promise<T>): Promise<T> {
    if (this.draining || this.closed) {
      throw managementError('conflict', 'Runtime daemon is draining and rejects new mutations.');
    }
    this.activeMutations += 1;
    this.activeMutationMethods.set(method, (this.activeMutationMethods.get(method) ?? 0) + 1);
    this.revision += 1;
    try {
      return await effect();
    } finally {
      this.activeMutations -= 1;
      const remaining = (this.activeMutationMethods.get(method) ?? 1) - 1;
      if (remaining === 0) this.activeMutationMethods.delete(method);
      else this.activeMutationMethods.set(method, remaining);
    }
  }

  async preflight(): Promise<RuntimeDaemonPreflight> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = this.revision;
      const current = await this.input.runtime.status.preflight();
      this.observePreflight(current);
      if (before === this.revision && this.activeMutations === 0) {
        return withLogicalClients(
          current,
          [...this.clients.values()].map((client) => ({ ...client })),
        );
      }
    }
    throw managementError('conflict', 'Runtime state changed while daemon preflight was being read.');
  }

  async inspect(): Promise<RuntimeDaemonManagementState> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const revision = this.revision;
      const current = await this.preflight();
      if (revision !== this.revision) continue;
      const owner = readRuntimeDaemonLockOwner(this.input.paths.lockFile);
      if (
        owner === undefined
        || owner.runtimeId !== this.input.runtime.identity.runtimeId
        || owner.kind !== 'daemon'
      ) {
        throw managementError('conflict', 'Runtime daemon owner fence changed during inspection.');
      }
      return {
        runtimeId: this.input.runtime.identity.runtimeId,
        revision,
        ownerPolicy: readRuntimeOwnerPolicy(this.input.paths),
        owner,
        preflight: current,
        ...(this.input.integrationStatuses
          ? { integrations: integrationHealth(this.input.integrationStatuses()) }
          : {}),
      };
    }
    throw managementError('conflict', 'Runtime state changed while daemon management was inspected.');
  }

  async stop(): Promise<{ readonly ok: true }> {
    this.beginDraining();
    try {
      await this.assertStoppable();
      this.input.requestStop();
      return { ok: true };
    } catch (error: unknown) {
      this.draining = false;
      throw error;
    }
  }

  async rollbackToInline(rollback: RuntimeDaemonRollbackInput): Promise<RuntimeDaemonRollbackResult> {
    if (rollback.expectedRuntimeId !== this.input.runtime.identity.runtimeId) {
      throw managementError('conflict', 'Runtime daemon instance changed before rollback commit.');
    }
    this.beginDraining(rollback.expectedRevision);
    try {
      await this.assertStoppable(rollback.expectedRevision);
      const ownerPolicy = commitRuntimeDaemonRollbackPolicy(
        this.input.paths,
        rollback.expectedRuntimeId,
        rollback.expectedOwnerPolicyRevision,
      );
      if (ownerPolicy.mode !== 'inline') {
        throw managementError('internal_error', 'Runtime owner rollback did not commit inline mode.');
      }
      this.revision += 1;
      this.input.requestStop();
      return {
        accepted: true,
        runtimeId: this.input.runtime.identity.runtimeId,
        revision: this.revision,
        ownerPolicy: { ...ownerPolicy, mode: 'inline' },
      };
    } catch (error: unknown) {
      this.draining = false;
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelOrphanExitCheck();
    this.clients.clear();
  }

  private beginDraining(expectedRevision?: number): void {
    if (this.closed) throw managementError('conflict', 'Runtime daemon management is closed.');
    if (this.draining) throw managementError('conflict', 'Runtime daemon is already draining.');
    if (expectedRevision !== undefined && this.revision !== expectedRevision) {
      throw managementError(
        'conflict',
        `Runtime daemon management revision changed: expected ${expectedRevision}, current ${this.revision}.`,
      );
    }
    if (this.activeMutations > 0) {
      throw managementError(
        'conflict',
        `Runtime daemon has in-flight mutations: ${[...this.activeMutationMethods]
          .map(([method, count]) => `${method} (${count})`)
          .join(', ')}.`,
      );
    }
    this.draining = true;
    this.cancelOrphanExitCheck();
  }

  private async assertStoppable(expectedRevision?: number): Promise<void> {
    const current = await this.preflight();
    if (expectedRevision !== undefined && this.revision !== expectedRevision) {
      throw managementError(
        'conflict',
        `Runtime daemon state changed before stop commit: expected ${expectedRevision}, current ${this.revision}.`,
      );
    }
    if (!current.canStop) {
      throw managementError(
        'conflict',
        `Runtime daemon cannot stop safely: ${current.blockers.join(', ')}.`,
        { preflight: current },
      );
    }
  }

  private observePreflight(current: RuntimeDaemonPreflight): void {
    const fingerprint = JSON.stringify(current);
    if (this.preflightFingerprint === undefined) {
      this.preflightFingerprint = fingerprint;
      return;
    }
    if (fingerprint === this.preflightFingerprint) return;
    this.preflightFingerprint = fingerprint;
    this.revision += 1;
  }

  private scheduleOrphanExitCheck(delayMs: number | undefined): void {
    if (
      delayMs === undefined
      || !this.orphanExitArmed
      || this.closed
      || this.draining
      || this.clients.size > 0
      || this.orphanExitCheckRunning
    ) {
      return;
    }
    this.cancelOrphanExitCheck();
    this.orphanExitTimer = setTimeout(() => {
      this.orphanExitTimer = undefined;
      void this.tryOrphanExit();
    }, delayMs);
    this.orphanExitTimer.unref?.();
  }

  private cancelOrphanExitCheck(): void {
    if (this.orphanExitTimer === undefined) return;
    clearTimeout(this.orphanExitTimer);
    this.orphanExitTimer = undefined;
  }

  private async tryOrphanExit(): Promise<void> {
    if (
      this.closed
      || this.draining
      || this.clients.size > 0
      || this.input.orphanExitMs === undefined
    ) {
      return;
    }
    this.orphanExitCheckRunning = true;
    const clientGeneration = this.clientGeneration;
    let stopped = false;
    let retryDelayMs = Math.min(this.input.orphanExitMs, 5_000);
    try {
      const current = await this.preflight();
      if (this.clients.size > 0 || this.closed || this.draining) return;
      if (this.clientGeneration !== clientGeneration) {
        // A client attached and detached while preflight was in flight. Give
        // that newest detach a complete grace period instead of stopping on
        // the stale timer's deadline.
        retryDelayMs = this.input.orphanExitMs;
        return;
      }
      if (current.canStop) {
        this.appendOrphanExitLog(
          'info',
          'Runtime daemon orphan exit accepted after the final client disconnected.',
        );
        await this.stop();
        stopped = true;
        return;
      }
      const fingerprint = current.blockers.join(',');
      if (fingerprint !== this.orphanBlockerFingerprint) {
        this.orphanBlockerFingerprint = fingerprint;
        this.appendOrphanExitLog(
          'info',
          'Runtime daemon orphan exit deferred until governed work becomes idle.',
          { blockers: current.blockers },
        );
      }
    } catch (error: unknown) {
      this.appendOrphanExitLog(
        'warn',
        'Runtime daemon orphan exit inspection failed; it will retry.',
        { error: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      this.orphanExitCheckRunning = false;
      if (!stopped) {
        this.scheduleOrphanExitCheck(retryDelayMs);
      }
    }
  }

  private appendOrphanExitLog(
    level: 'info' | 'warn',
    message: string,
    detail?: Record<string, unknown>,
  ): void {
    try {
      appendRuntimeDaemonLog(this.input.paths, level, message, detail);
    } catch {
      // Orphan recovery is a lifecycle guarantee; diagnostic I/O is best-effort.
    }
  }
}

function integrationHealth(
  domains: readonly RuntimeIntegrationDomainStatus[],
): NonNullable<RuntimeDaemonManagementState['integrations']> {
  const snapshot = structuredClone(domains);
  return {
    state: snapshot.some((domain) => domain.diagnostic !== undefined)
      ? 'degraded'
      : 'healthy',
    domains: snapshot,
  };
}

function withLogicalClients(
  current: RuntimeDaemonPreflight,
  clients: readonly RuntimeDaemonClientSnapshot[],
): RuntimeDaemonPreflight {
  const blockers: Array<RuntimeDaemonPreflight['blockers'][number]> = current.blockers
    .filter((blocker) => blocker !== 'connected_clients');
  if (clients.length > 1) blockers.push('connected_clients');
  return {
    ...current,
    clientCount: clients.length,
    clients,
    blockers,
    canStop: blockers.length === 0,
  };
}

function managementError(
  code: 'conflict' | 'internal_error',
  message: string,
  data?: unknown,
): Error & { readonly code: 'conflict' | 'internal_error'; readonly data?: unknown } {
  const error = new Error(message) as Error & {
    code: 'conflict' | 'internal_error';
    data?: unknown;
  };
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}
