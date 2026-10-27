import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import type { KodaXRuntime, RuntimeConnectionState, RuntimeSubscription } from './sdk-runtime.js';
import type { KodaXClientHostAuthorization } from './client-host-authorization.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import { ensureKodaXRuntime } from './sdk-runtime.js';

/** A launcher retains its authenticated principal across replacement Host connections. */
export async function ensureRecoveringKodaXRuntime(
  options: Parameters<typeof ensureKodaXRuntime>[0] = {},
  authorize?: KodaXClientHostAuthorization,
): Promise<KodaXRuntime> {
  const clientInfo = { name: 'kodax-client', ...options.clientInfo,
    instanceId: options.clientInfo?.instanceId ?? randomUUID(),
    instanceSecret: options.clientInfo?.instanceSecret ?? randomBytes(32).toString('hex') };
  const initial = await ensureKodaXRuntime({ ...options, clientInfo });
  return createRecoveringRuntimeClient(initial, signal => ensureKodaXRuntime({ ...options, clientInfo,
    daemonStartupSignal: AbortSignal.any([signal, ...(options.daemonStartupSignal ? [options.daemonStartupSignal] : [])]),
  }), authorize);
}

function transientConnectionFailure(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && ['protocol_closed', 'transport_error', 'ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'ETIMEDOUT'].includes(code);
}

/** Launcher-owned connection continuity. Business mutations are never retried here. */
export function createRecoveringRuntimeClient(initial: KodaXRuntime,
  connect: (signal: AbortSignal) => Promise<KodaXRuntime>,
  authorize?: KodaXClientHostAuthorization): KodaXRuntime {
  let current = initial;
  let closed = false;
  let exiting = false;
  const lifetime = new AbortController();
  let connecting: Promise<void> | undefined;
  let connectionFailure: unknown;
  let connectionLosses = 0;
  let lifecycle: RuntimeSubscription | undefined;
  let state = initial.connection?.current();
  const listeners = new Set<(state: RuntimeConnectionState) => void>();
  const reattach = new Set<() => Promise<void>>();
  const recoveries = new Map<string, Promise<void>>();
  const stopped = new Set<string>();
  const connectionWaiters = new Set<() => void>();
  const report = (next: RuntimeConnectionState): void => {
    state = next;
    for (const listener of listeners) {
      try { listener(next); } catch (error) { diagnose('Connection observer failed.', error); }
    }
  };
  const diagnose = (message: string, error: unknown): void => emitKodaXDiagnostic({
    source: 'runtime.client-recovery', level: 'warn', message, detail: error,
  });
  const reconnect = (): Promise<void> => {
    if (closed || exiting) return Promise.reject(new Error('Runtime client is closing.'));
    if (connecting) return connecting;
    const previous = current;
    lifecycle?.close();
    const attempt = (async () => {
      await previous.close();
      let retry = 0;
      for (;;) {
        lifetime.signal.throwIfAborted();
        try {
          current = await connect(lifetime.signal);
          if (closed || exiting) { await current.close(); lifetime.signal.throwIfAborted(); return; }
          recoveries.clear();
          connectionFailure = undefined;
          const lossesBeforeAttach = connectionLosses;
          bindLifecycle();
          for (const resume of reattach) await resume();
          if (connectionLosses !== lossesBeforeAttach) {
            throw Object.assign(new Error('Host disconnected during subscription setup.'), { code: 'protocol_closed' });
          }
          break;
        }
        catch (error) {
          if (!transientConnectionFailure(error)) throw error;
          diagnose('Host connection is unavailable; waiting to reconnect.', error);
          lifecycle?.close();
          await current.close();
          await delay(Math.min(30_000, 1_000 * 2 ** Math.min(retry++, 5)), undefined, { signal: lifetime.signal });
        }
      }
      for (const wake of connectionWaiters) wake();
    })();
    connecting = attempt;
    void attempt.then(() => { if (connecting === attempt) connecting = undefined; }, error => {
      if (connecting === attempt) connecting = undefined;
      connectionFailure = error;
      if (!closed) {
        diagnose('Host reconnection could not complete.', error);
        if (state) report({ ...state, state: 'disconnected', reconnectable: false, reason: String(error) });
      }
      for (const wake of connectionWaiters) wake();
    });
    return attempt;
  };
  const bindLifecycle = (): void => {
    const host = current;
    lifecycle = current.connection?.subscribe(next => {
      if (host !== current) return;
      report(next);
      if (!closed && !exiting && next.state === 'disconnected' && next.reconnectable && transientConnectionFailure(next)) {
        connectionLosses += 1;
        void reconnect().catch(() => { /* The connection owner reports the failure once. */ });
      }
    });
  };
  const recoverRun = async (runId: string): Promise<void> => {
    if (closed || exiting || stopped.has(runId) || current.identity.runtimeId === initial.identity.runtimeId) return;
    const existing = recoveries.get(runId);
    if (existing) return existing;
    const host = current;
    const attempt = (async () => {
      const status = await host.runs.get(runId);
      if (closed || stopped.has(runId)
        || status.stop || status.phase !== 'recovering' || !status.contextRecovery?.checkpoint) return;
      // Reuses the same trusted Product authorization boundary as explicit recovery.
      await toKodaXProductClient(host, authorize).runs.recover({ sessionId: status.sessionId, runId });
    })();
    recoveries.set(runId, attempt);
    return attempt;
  };
  const awaitRun: KodaXRuntime['runs']['await'] = async runId => {
    for (;;) {
      if (connecting) await connecting;
      lifetime.signal.throwIfAborted();
      if (connectionFailure) throw connectionFailure;
      const host = current;
      try {
        await recoverRun(runId);
        const result = await host.runs.await(runId);
        if (result.phase !== 'recovering') return result;
        // Graceful Host suspension can publish the checkpoint before closing its socket.
        if (host === current && !connecting) await new Promise<void>((resolve, reject) => {
          const wake = () => { connectionWaiters.delete(wake); lifetime.signal.removeEventListener('abort', abort); resolve(); };
          const abort = () => { wake(); reject(lifetime.signal.reason); };
          connectionWaiters.add(wake);
          lifetime.signal.addEventListener('abort', abort, { once: true });
        });
      } catch (error) {
        if (!transientConnectionFailure(error)) throw error;
        if (host === current) await reconnect();
      }
    }
  };
  const abort: KodaXRuntime['runs']['abort'] = async (runId, ...rest) => {
    stopped.add(runId);
    if (connecting) await connecting;
    return current.runs.abort(runId, ...rest);
  };
  const cancel: KodaXRuntime['sessions']['cancel'] = async input => {
    // Match runs.abort: preserve Stop intent only for the exact target Run.
    stopped.add(input.expectedRunId);
    if (connecting) await connecting;
    return current.sessions.cancel(input);
  };
  const observeView: KodaXRuntime['sessions']['observeView'] = async (sessionId, deliver, options) => {
    let disposed = false;
    let generation = 0;
    let subscription: RuntimeSubscription | undefined;
    const resume = async (): Promise<void> => {
      if (disposed || closed) return;
      const token = ++generation;
      subscription?.close();
      const host = current;
      const next = await host.sessions.observeView(sessionId, view => {
        if (disposed || token !== generation || host !== current) return;
        deliver(view);
        for (const run of view.runs) if (run.phase === 'recovering') {
          void recoverRun(run.runId).catch(error => {
            diagnose('Checkpoint continuation requires attention.', error);
            if (!disposed && token === generation) options?.onStatus?.({ state: 'interrupted', message: String(error) });
          });
        }
      }, { ...options, onStatus: status => {
        if (!disposed && token === generation && host === current) options?.onStatus?.(status);
      } });
      if (disposed || closed || token !== generation) next.close();
      else subscription = next;
    };
    const reopen = async (): Promise<void> => {
      try { await resume(); } catch (error) {
        if (transientConnectionFailure(error)) throw error;
        diagnose('Session observation could not reconnect.', error);
        options?.onStatus?.({ state: 'closed', reason: 'unavailable', message: String(error) });
      }
    };
    if (connecting) await connecting;
    await resume();
    reattach.add(reopen);
    return { close() {
      if (disposed) return;
      disposed = true; generation += 1; reattach.delete(reopen); subscription?.close();
    } };
  };
  const subscribeEvents: KodaXRuntime['events']['subscribe'] = (filter, listener) => {
    let subscription: RuntimeSubscription | undefined;
    let disposed = false;
    const resume = (): void => {
      subscription?.close();
      const host = current;
      subscription = host.events.subscribe(filter, event => {
        if (!disposed && host === current) listener(event);
      });
    };
    // Event subscription is synchronous; reopening does not replay historical events.
    resume();
    const reopen = async (): Promise<void> => { if (!disposed) resume(); };
    reattach.add(reopen);
    return { close() { if (disposed) return; disposed = true; reattach.delete(reopen); subscription?.close(); } };
  };
  const close = async (): Promise<void> => {
    closed = true;
    lifetime.abort(new Error('Runtime client closed.'));
    lifecycle?.close();
    for (const wake of connectionWaiters) wake();
    await connecting?.catch(() => { /* Closing explicitly cancels reconnection. */ });
    await current.close();
  };
  // Stable facades route future calls to the current connection. They do not
  // replay a failed call, cache Host business state, or rewrite its outcomes.
  const domains = new Map<PropertyKey, object>();
  const facade = new Proxy(initial, { get(_target, key) {
    if (key === 'close') return close;
    const value: unknown = Reflect.get(current, key);
    if (!value || typeof value !== 'object' || ['identity', 'capabilities', 'grantedScopes'].includes(String(key))) return value;
    if (!domains.has(key)) domains.set(key, new Proxy({}, { get(_domain, method) {
      if (key === 'runs' && method === 'await') return awaitRun;
      if (key === 'runs' && method === 'abort') return abort;
      if (key === 'sessions' && method === 'cancel') return cancel;
      if (key === 'sessions' && method === 'observeView') return observeView;
      if (key === 'events' && method === 'subscribe') return subscribeEvents;
      if ((key === 'daemon' && method === 'shutdown') || (key === 'lifecycle' && method === 'requestExit')) {
        return async (...args: unknown[]) => {
          // An explicit exit must not be mistaken for a crashed Host.
          exiting = true;
          if (connecting) {
            lifetime.abort(new Error('Client exited while Host was unavailable; exit could not be acknowledged.'));
            await connecting;
          }
          const owner = Reflect.get(current, key) as object;
          return Reflect.apply(Reflect.get(owner, method) as (...values: unknown[]) => unknown, owner, args);
        };
      }
      if (key === 'connection' && method === 'current') return () => state;
      if (key === 'connection' && method === 'subscribe') return (listener: (value: RuntimeConnectionState) => void) => {
        listeners.add(listener); if (state) listener(state); return { close: () => { listeners.delete(listener); } };
      };
      const owner: object = Reflect.get(current, key) as object;
      const member: unknown = Reflect.get(owner, method);
      return typeof member === 'function' ? (...args: unknown[]) => {
        const latest: object = Reflect.get(current, key) as object;
        return Reflect.apply(Reflect.get(latest, method) as (...args: unknown[]) => unknown, latest, args);
      } : member;
    } }));
    return domains.get(key);
  } });
  bindLifecycle();
  return facade;
}
