import type {
  KodaXRuntime,
  RuntimeDaemonClientSnapshot,
  RuntimeDaemonManagementState,
  RuntimeDaemonPreflight,
  RuntimeIntegrationDomainStatus,
} from '../sdk-runtime.js';
import type { RuntimeDaemonMethod } from './protocol.js';
import {
  appendRuntimeDaemonLog,
  readRuntimeDaemonLockOwner,
  readRuntimeOwnerPolicy,
  type RuntimeDaemonPaths,
} from './state.js';

export interface RuntimeDaemonManagementController {
  readonly lifecycle: 'interactive' | 'persistent';
  readonly retention: 'explicit' | 'service' | undefined;
  armOrphanExitAfterReady(): void;
  attachClient(client: RuntimeDaemonClientSnapshot, options?: { readonly persistent: boolean; readonly startup?: boolean }): void;
  detachClient(connectionId: string): void;
  runMutation<T>(method: RuntimeDaemonMethod, effect: () => Promise<T>): Promise<T>;
  preflight(signal?: AbortSignal): Promise<RuntimeDaemonPreflight>;
  inspect(): Promise<RuntimeDaemonManagementState>;
  stop(input?: { readonly principalId?: string; readonly preserveBackgroundWork?: true }): Promise<{ readonly ok: true }>;
  close(): void;
}

export function createRuntimeDaemonManagementController(input: {
  readonly runtime: KodaXRuntime;
  readonly paths: RuntimeDaemonPaths;
  readonly requestStop: () => void;
  /**
   * When set, a daemon that has observed at least one logical client stops
   * itself after the final client disconnects and all governed work is idle.
   * Omitted for persistent daemon owners.
   */
  readonly orphanExitMs?: number;
  /** A configured server keeps this Host available independently of clients. */
  readonly keepAlive?: () => boolean;
  readonly integrationStatuses?: () => readonly RuntimeIntegrationDomainStatus[];
}): RuntimeDaemonManagementController {
  return new DaemonManagementController(input);
}

class DaemonManagementController implements RuntimeDaemonManagementController {
  private readonly clients = new Map<string, RuntimeDaemonClientSnapshot>();
  private readonly startupClients = new Set<string>();
  private observedLogicalClient = false;
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
  private orphanExitAbort: AbortController | undefined;
  private orphanBlockerFingerprint: string | undefined;
  private persistent = false;
  private orphanIdleSince: number | undefined;

  constructor(private readonly input: {
    readonly runtime: KodaXRuntime;
    readonly paths: RuntimeDaemonPaths;
    readonly requestStop: () => void;
    readonly orphanExitMs?: number;
    readonly keepAlive?: () => boolean;
    readonly integrationStatuses?: () => readonly RuntimeIntegrationDomainStatus[];
  }) {
  }

  get lifecycle(): 'interactive' | 'persistent' {
    return this.retention !== undefined || this.input.orphanExitMs === undefined
      ? 'persistent' : 'interactive';
  }

  get retention(): 'explicit' | 'service' | undefined {
    if (this.persistent) return 'explicit';
    return this.input.keepAlive?.() === true ? 'service' : undefined;
  }

  armOrphanExitAfterReady(): void {
    if (this.input.orphanExitMs === undefined || this.closed || this.draining) return;
    this.orphanExitArmed = true;
    this.orphanIdleSince = Date.now();
    this.scheduleOrphanExitCheck(this.input.orphanExitMs);
  }

  attachClient(client: RuntimeDaemonClientSnapshot, options?: { readonly persistent: boolean; readonly startup?: boolean }): void {
    if (this.draining || this.closed) {
      throw managementError('conflict', 'Runtime daemon is draining and cannot attach another client.');
    }
    if (options?.persistent) this.persistent = true;
    if (this.clients.has(client.daemonConnectionId)) return;
    this.clients.set(client.daemonConnectionId, { ...client });
    this.orphanExitAbort?.abort();
    if (options?.startup) this.startupClients.add(client.daemonConnectionId);
    else this.observedLogicalClient = true;
    this.orphanExitArmed = true;
    this.clientGeneration += 1;
    this.orphanIdleSince = undefined;
    this.cancelOrphanExitCheck();
    this.orphanBlockerFingerprint = undefined;
    this.revision += 1;
  }

  detachClient(connectionId: string): void {
    if (!this.clients.delete(connectionId)) return;
    const startup = this.startupClients.delete(connectionId);
    this.clientGeneration += 1;
    this.revision += 1;
    if (this.clients.size === 0) {
      // A bootstrap identity check holds admission but has submitted no work.
      // Do not compete with the first real SDK attach by scanning history now.
      const bootstrapOnly = startup && !this.observedLogicalClient;
      if (bootstrapOnly) this.orphanIdleSince = Date.now();
      this.scheduleOrphanExitCheck(bootstrapOnly ? this.input.orphanExitMs : 0);
    }
  }

  async runMutation<T>(method: RuntimeDaemonMethod, effect: () => Promise<T>): Promise<T> {
    if (this.draining || this.closed) {
      throw managementError('conflict', 'Runtime daemon is draining and rejects new mutations.');
    }
    this.activeMutations += 1;
    this.orphanIdleSince = undefined;
    this.activeMutationMethods.set(method, (this.activeMutationMethods.get(method) ?? 0) + 1);
    this.revision += 1;
    try {
      return await effect();
    } finally {
      this.activeMutations -= 1;
      const remaining = (this.activeMutationMethods.get(method) ?? 1) - 1;
      if (remaining === 0) this.activeMutationMethods.delete(method);
      else this.activeMutationMethods.set(method, remaining);
      if (this.clients.size === 0) this.scheduleOrphanExitCheck(0);
    }
  }

  async preflight(signal?: AbortSignal): Promise<RuntimeDaemonPreflight> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      signal?.throwIfAborted();
      this.assertNoActiveMutations();
      const before = this.revision;
      const current = await this.input.runtime.status.preflight(signal ? { signal } : undefined);
      signal?.throwIfAborted();
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

  async stop(input?: { readonly principalId?: string; readonly preserveBackgroundWork?: true }): Promise<{ readonly ok: true }> {
    this.beginDraining();
    try {
      await this.assertStoppable(input?.principalId, input?.preserveBackgroundWork === true);
      this.input.requestStop();
      return { ok: true };
    } catch (error: unknown) {
      this.draining = false;
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.orphanExitAbort?.abort();
    this.cancelOrphanExitCheck();
    this.clients.clear();
    this.startupClients.clear();
  }

  private beginDraining(): void {
    if (this.closed) throw managementError('conflict', 'Runtime daemon management is closed.');
    if (this.draining) throw managementError('conflict', 'Runtime daemon is already draining.');
    this.assertNoActiveMutations();
    this.draining = true;
    this.orphanExitAbort?.abort();
    this.cancelOrphanExitCheck();
  }

  private assertNoActiveMutations(): void {
    if (this.activeMutations > 0) {
      throw managementError(
        'conflict',
        `Runtime daemon has in-flight mutations: ${[...this.activeMutationMethods]
          .map(([method, count]) => `${method} (${count})`)
          .join(', ')}.`,
      );
    }
  }

  private async assertStoppable(exitingPrincipalId?: string, preserveBackgroundWork = false): Promise<void> {
    const current = await this.preflight();
    const blockers = exitingPrincipalId === undefined ? [...current.blockers] : [
      ...current.blockers.filter(blocker => blocker !== 'connected_clients'),
      ...([...this.clients.values()].some(client => client.principalId !== exitingPrincipalId) ? ['connected_clients'] : []),
    ];
    if (preserveBackgroundWork && (current.pendingBackgroundWork ?? 0) > 0) blockers.push('background_work');
    if (blockers.length > 0) {
      throw managementError(
        'conflict',
        `Runtime daemon cannot stop safely: ${blockers.join(', ')}.`,
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
      || this.input.orphanExitMs === undefined
      || this.persistent
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
      || this.persistent
      || this.draining
      || this.clients.size > 0
      || this.input.orphanExitMs === undefined
    ) {
      return;
    }
    this.orphanExitCheckRunning = true;
    const inspection = new AbortController();
    this.orphanExitAbort = inspection;
    const clientGeneration = this.clientGeneration;
    let stopped = false;
    let retryDelayMs = Math.min(this.input.orphanExitMs, 5_000);
    try {
      if (this.input.keepAlive?.()) {
        this.orphanIdleSince = undefined;
        return;
      }
      const current = await this.preflight(inspection.signal);
      this.orphanExitAbort = undefined;
      if (this.clients.size > 0 || this.closed || this.draining || this.persistent) return;
      if (this.clientGeneration !== clientGeneration) {
        // A client attached and detached while preflight was in flight. Give
        // that newest detach a complete grace period instead of stopping on
        // the stale timer's deadline.
        retryDelayMs = 0;
        return;
      }
      if (current.canStop && (current.pendingBackgroundWork ?? 0) === 0) {
        this.orphanIdleSince ??= Date.now();
        const remaining = this.input.orphanExitMs - (Date.now() - this.orphanIdleSince);
        if (remaining > 0) {
          retryDelayMs = remaining;
          return;
        }
        this.appendOrphanExitLog(
          'info',
          'Runtime daemon orphan exit accepted after the final client disconnected.',
        );
        await this.stop({ preserveBackgroundWork: true });
        stopped = true;
        return;
      }
      this.orphanIdleSince = undefined;
      const blockers = [...current.blockers, ...((current.pendingBackgroundWork ?? 0) > 0 ? ['background_work'] : [])];
      const fingerprint = blockers.join(',');
      if (fingerprint !== this.orphanBlockerFingerprint) {
        this.orphanBlockerFingerprint = fingerprint;
        this.appendOrphanExitLog(
          'info',
          'Runtime daemon orphan exit deferred until governed work becomes idle.',
          { blockers },
        );
      }
    } catch (error: unknown) {
      this.orphanIdleSince = undefined;
      if (inspection.signal.aborted) {
        retryDelayMs = 0;
        return;
      }
      this.appendOrphanExitLog(
        'warn',
        'Runtime daemon orphan exit inspection failed; it will retry.',
        { error: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      if (this.orphanExitAbort === inspection) this.orphanExitAbort = undefined;
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
