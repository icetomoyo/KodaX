import { randomUUID } from 'node:crypto';
import type { KodaXClientHostServices, RuntimeExecutionBindingRequest, RuntimeExecutionBindingResolver, RuntimeExecutionBindingService } from './client-host-authorization.js';
import type { RuntimeDaemonMethod } from './runtime-daemon/protocol.js';

export function createExecutionBindingClient(request: (method: RuntimeDaemonMethod, params: unknown) => Promise<unknown>,
  capabilities: Readonly<Record<string, unknown>>, services: (sessionId: string) => KodaXClientHostServices) {
  const resolvers = new Map<string, RuntimeExecutionBindingResolver | undefined>();
  const active = new Map<string, AbortController>();
  const requireCapability = () => {
    if ((capabilities.productExecutionBinding as { version?: number } | undefined)?.version !== 1) {
      throw Object.assign(new Error('Execution bindings require an upgraded Host.'), { code: 'daemon_upgrade_required' });
    }
  };
  const service: RuntimeExecutionBindingService = {
    async register(resolver) {
      requireCapability();
      if (typeof resolver !== 'function') throw new TypeError('Execution binding resolver must be a function.');
      const id = `binding_${randomUUID().replace(/-/g, '')}`;
      resolvers.set(id, resolver);
      try { await request('execution.register', { leaseId: id }); }
      catch (error: unknown) { resolvers.set(id, undefined); throw error; }
      return { id };
    },
    async revoke(id) {
      requireCapability();
      if (!resolvers.has(id)) return false;
      resolvers.set(id, undefined);
      const result = await request('execution.revoke', { leaseId: id }) as { revoked: boolean };
      resolvers.delete(id);
      return result.revoked;
    },
  };
  return { service,
    async handle(value: unknown) {
      if (value === null || typeof value !== 'object') throw new Error('Invalid execution binding notification.');
      const envelope = value as { requestId: string; leaseId: string; request: RuntimeExecutionBindingRequest };
      if (typeof envelope.requestId !== 'string' || typeof envelope.leaseId !== 'string' || !envelope.request
        || typeof envelope.request.sessionId !== 'string' || !['admission', 'recovery'].includes(envelope.request.phase)) {
        throw new Error('Invalid execution binding request identity.');
      }
      const resolver = resolvers.get(envelope.leaseId);
      const controller = new AbortController();
      active.set(envelope.requestId, controller);
      let result: Parameters<typeof request>[1];
      try {
        if (!resolver) throw new Error('Execution binding was revoked.');
        const authorization = await resolver(structuredClone(envelope.request), services(envelope.request.sessionId), controller.signal);
        result = { requestId: envelope.requestId, resolution: structuredClone(authorization) };
      } catch {
        result = { requestId: envelope.requestId, error: 'execution_binding_rejected' };
      } finally { active.delete(envelope.requestId); }
      if (!controller.signal.aborted) await request('execution.complete', result);
    },
    close() {
      for (const controller of active.values()) controller.abort();
      active.clear();
      resolvers.clear();
    },
  };
}
