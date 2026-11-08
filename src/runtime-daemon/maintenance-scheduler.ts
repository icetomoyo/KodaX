import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import type { RuntimeDaemonManagementController } from './management.js';
import type { RuntimeDaemonLockOwner, RuntimeDaemonPaths } from './state.js';
import { createRuntimeDaemonMaintenance } from './maintenance.js';

/** Kept behind the Host's post-ready dynamic import to preserve the CLI startup budget. */
export function startRuntimeDaemonHostMaintenance(
  paths: RuntimeDaemonPaths,
  owner: RuntimeDaemonLockOwner,
  management: Pick<RuntimeDaemonManagementController, 'preflight'>,
  onError: (error: unknown) => void,
): { close(): Promise<void> } {
  const collector = createRuntimeDaemonMaintenance(paths, owner);
  const scheduler = startRuntimeDaemonMaintenanceScheduler({
    canSweep: async (signal) => {
      try {
        const current = await management.preflight(signal);
        return current.runtimeId === owner.runtimeId
          && current.blockers.every(blocker => blocker === 'connected_clients')
          && (current.pendingBackgroundWork ?? 0) === 0;
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'conflict') return false;
        throw error;
      }
    },
    sweep: async (signal) => {
      const result = await collector.runOnce(signal);
      if (result.removed > 0) emitKodaXDiagnostic({
        source: 'runtime.daemon.maintenance', level: 'info',
        message: 'Runtime daemon abandoned temporary files removed.', detail: result,
      });
    },
    onError,
  });
  return { async close() { await scheduler.close(); await collector.close(); } };
}

/** Only the ready Host creates this scheduler; every round checks current work first. */
export function startRuntimeDaemonMaintenanceScheduler(input: {
  readonly canSweep: (signal: AbortSignal) => Promise<boolean>;
  readonly sweep: (signal: AbortSignal) => Promise<unknown>;
  readonly onError: (error: unknown) => void;
}): { close(): Promise<void> } {
  const stopping = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;

  const run = async (): Promise<void> => {
    let cancelCheck!: () => void;
    const cancelled = new Promise<boolean>((resolve) => { cancelCheck = () => resolve(false); });
    stopping.signal.addEventListener('abort', cancelCheck, { once: true });
    try {
      const idle = await Promise.race([input.canSweep(stopping.signal), cancelled]);
      if (idle && !stopping.signal.aborted) {
        await input.sweep(stopping.signal);
      }
    } catch (error: unknown) {
      if (!(stopping.signal.aborted && error instanceof Error && error.name === 'AbortError')) {
        input.onError(error);
      }
    } finally {
      stopping.signal.removeEventListener('abort', cancelCheck);
    }
  };
  const schedule = (delayMs: number): void => {
    if (stopping.signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      pending = run().finally(() => {
        pending = undefined;
        schedule(300_000);
      });
    }, delayMs);
    timer.unref();
  };
  schedule(0);
  return {
    async close() {
      stopping.abort();
      clearTimeout(timer);
      timer = undefined;
      await pending;
    },
  };
}
