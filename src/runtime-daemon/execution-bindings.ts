import { randomUUID } from 'node:crypto';
import type { RuntimeExecutionAuthorization, RuntimeExecutionBindingRequest } from '../client-host-authorization.js';
import { createRuntimeDaemonNotification, type RuntimeDaemonNotification } from './protocol.js';

type ResolvedAuthorization = Omit<RuntimeExecutionAuthorization, 'binding'>;

/** One principal's transient reverse channel. No authority survives its owning Main. */
export function createExecutionBindingChannel(notify: () => ((event: RuntimeDaemonNotification) => void) | undefined,
  timeoutMs: number) {
  const leases = new Set<string>();
  const pending = new Map<string, { leaseId: string; resolve(value: ResolvedAuthorization): void;
    reject(error: Error): void; dispose(): void }>();
  const unavailable = (message: string) => Object.assign(new Error(message), { code: 'execution_binding_unavailable' });
  const cancel = (leaseId?: string) => {
    for (const [id, request] of pending) if (leaseId === undefined || request.leaseId === leaseId) {
      pending.delete(id); request.dispose(); request.reject(unavailable('Execution binding is no longer available.'));
    }
  };
  return {
    register(id: string) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw Object.assign(new Error('Invalid execution binding lease.'), { code: 'invalid_params' });
      if (!leases.has(id) && leases.size >= 64) throw unavailable('Execution binding lease limit reached.');
      leases.add(id);
      return { id };
    },
    revoke(id: string) { const existed = leases.delete(id); cancel(id); return existed; },
    cancel,
    close() { leases.clear(); cancel(); },
    async resolve(leaseId: string, request: RuntimeExecutionBindingRequest, signal?: AbortSignal): Promise<ResolvedAuthorization> {
      signal?.throwIfAborted();
      const send = notify();
      if (!leases.has(leaseId) || !send) throw unavailable('The Main execution binding is missing or disconnected.');
      const requestId = `execution_${randomUUID().replace(/-/g, '')}`;
      return new Promise<ResolvedAuthorization>((resolve, reject) => {
        const fail = (error: Error) => {
          const current = pending.get(requestId);
          if (!current) return;
          pending.delete(requestId); current.dispose(); reject(error);
        };
        const timer = setTimeout(() => fail(unavailable('Main execution binding resolution timed out.')), timeoutMs);
        timer.unref?.();
        const abort = () => fail(Object.assign(new Error('Execution binding resolution cancelled.'), { code: 'cancelled' }));
        pending.set(requestId, { leaseId, resolve, reject, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        try { send(createRuntimeDaemonNotification('execution.resolve', { requestId, leaseId, request: structuredClone(request) })); }
        catch (error: unknown) { fail(unavailable(`Execution binding transport failed (${error instanceof Error ? error.name : 'unknown'}).`)); }
      });
    },
    complete(input: { readonly requestId: string; readonly authorization?: ResolvedAuthorization; readonly error?: string }) {
      const current = pending.get(input.requestId);
      if (!current) return false;
      pending.delete(input.requestId); current.dispose();
      if (input.error !== undefined || input.authorization === undefined || Object.hasOwn(input.authorization, 'binding')) {
        current.reject(Object.assign(new Error('Main rejected the execution binding.'), { code: 'execution_binding_rejected' }));
      } else current.resolve(structuredClone(input.authorization));
      return true;
    },
  };
}
