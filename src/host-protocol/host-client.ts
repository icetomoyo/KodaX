/**
 * A client of one Host that outlives its connections. `open` makes one
 * connection; when it is lost, this layer opens another, sends again what was
 * waiting for an answer, follows the same views and, on a Host that replaced
 * the one before, continues the Runs it left part-way. No Node dependency, so
 * the browser SDK shares it.
 */
import type { z } from 'zod/v4';

import type { HostRpcClient } from './client.js';
import { HostProtocolError } from './codec.js';
import type { HostCredentialRequest, HostLeaseRequest, HostToolCall } from './lease.js';
import type {
  HOST_METHODS,
  HostInitializeResult,
  HostLocalResult,
  HostMethodName,
  HostResult,
} from './methods.js';
import type { LocalSessionView, SessionView, ViewPatch, ViewSnapshot } from './view.js';
import { applyViewOps, viewPatchStep, type ViewPosition } from './view-sync.js';

/** The longest pause between two attempts to reach a Host that went away. */
const MAX_RECONNECT_DELAY_MS = 30_000;
const FIRST_RECONNECT_DELAY_MS = 500;

/** After these the Host ends this client's link on purpose, so it is not opened again. */
const ENDS_CLIENT = new Set<string>(['client.exit.request', 'host.stop']);

type Spec<Method extends HostMethodName> = (typeof HOST_METHODS)[Method];

/** The methods a client calls and is answered: queries and commands. Views are followed with `observeSession`. */
export type HostCallableMethod = {
  [Method in HostMethodName]: Spec<Method>['primitive'] extends 'query' | 'command' ? Method : never;
}[HostMethodName];

/** What a client sends: commands carry the `requestId` the caller chose, see `createRequestId`. */
export type HostCallParams<Method extends HostCallableMethod> = z.input<Spec<Method>['params']>;

/**
 * `local` is what the owner on the Host's own machine is answered: the shared
 * answer plus paths on that machine. Every other client is answered `shared`.
 */
export type HostAnswerScope = 'shared' | 'local';

export type HostCallResult<Method extends HostCallableMethod, Scope extends HostAnswerScope> =
  Scope extends 'local' ? HostLocalResult<Method> : HostResult<Method>;

export type HostSessionView<Scope extends HostAnswerScope> = Scope extends 'local' ? LocalSessionView : SessionView;

export interface HostCallOptions {
  /** Aborting asks the Host to cancel and still waits for its answer, because only the Host knows what happened. */
  readonly signal?: AbortSignal;
}

type CallArgs<Method extends HostCallableMethod> = Record<string, never> extends HostCallParams<Method>
  ? [params?: HostCallParams<Method>, options?: HostCallOptions]
  : [params: HostCallParams<Method>, options?: HostCallOptions];

export type HostConnectionState =
  | { readonly state: 'connected'; readonly handshake: HostInitializeResult }
  /** The link was lost. Calls wait for the next connection; `error` is why the last attempt failed. */
  | { readonly state: 'reconnecting'; readonly attempt: number; readonly error?: HostProtocolError }
  /** For good: closed by the caller, ended on purpose, or refused in a way trying again would not change. */
  | { readonly state: 'closed'; readonly error?: HostProtocolError };

export interface HostSessionObserver<Scope extends HostAnswerScope> {
  /** The whole view after every change. Also called with a fresh view after a reconnect. */
  readonly onView: (view: HostSessionView<Scope>) => void;
  /** The Host ended the observation, for example because the Session is gone. It is not resumed. */
  readonly onClosed?: (reason: string) => void;
}

export interface HostSessionObservation {
  close(): void;
}

export type { HostCredentialRequest, HostLeaseRequest, HostToolCall };

/** Gives the key a Run asked for under one of this client's leases, or `undefined` when there is none to give. */
export type HostLeaseHandler = (request: HostCredentialRequest) => Promise<string | undefined>;

/** Runs one call of a tool this client lends. `content` is what the model reads. */
export type HostToolHandler = (call: HostToolCall) => Promise<{ readonly content: string; readonly structuredContent?: unknown }>;

export interface KodaXHostClient<Scope extends HostAnswerScope = 'shared'> {
  /** What the Host granted the current connection. A reconnect may change it. */
  readonly handshake: HostInitializeResult;
  /**
   * Rejects with `HostProtocolError`. A call that loses its link is sent again
   * on the next connection: a query is safe to repeat, and a command repeats
   * nothing under the same `requestId`.
   */
  call<Method extends HostCallableMethod>(method: Method, ...args: CallArgs<Method>): Promise<HostCallResult<Method, Scope>>;
  /** Resolves once the first view arrived. */
  observeSession(sessionId: string, observer: HostSessionObserver<Scope>): Promise<HostSessionObservation>;
  /** Called at once with the current state. Returns the function that removes the listener. */
  onConnectionChange(listener: (state: HostConnectionState) => void): () => void;
  /**
   * Answers the Host when a Run needs a key under one of this client's leases.
   * Replaces the handler set before. Without one, each request is refused at
   * once, so the model call fails instead of waiting out its time limit. What
   * the handler throws goes to `onError`; the Host is told only that it failed.
   */
  answerLeaseRequests(handler: HostLeaseHandler | undefined): void;
  /**
   * Runs the calls of the tools this client lends. Replaces the handler set
   * before. Without one, each call is refused at once. What the handler throws
   * goes to `onError`; the Host is told only that the call failed, and the
   * model that its outcome is unknown.
   */
  answerToolCalls(handler: HostToolHandler | undefined): void;
  /** Settles when the client is closed for good. */
  readonly closed: Promise<void>;
  close(): void;
}

export interface KodaXHostClientOptions {
  /**
   * Opens one connection. Called again after a link is lost; a rejection whose
   * `HostProtocolError` is `retryable` is tried again after a pause, any other
   * rejection closes the client.
   */
  readonly open: (signal: AbortSignal) => Promise<HostRpcClient>;
  /** Receives what no caller is otherwise told: a listener that threw, a reconnect attempt that failed. */
  readonly onError?: (error: unknown) => void;
  /**
   * What a Run left part-way by a replaced Host borrows when this client
   * continues it, such as the lease its model calls get their keys from.
   * Called once the new Host is connected. When it throws, the Run is left
   * waiting and the error goes to `onError`.
   */
  readonly recoveryLeases?: (runId: string) => Promise<HostCallParams<'run.recover'>['leases']>;
}

/** A new id for one intent. Send it again, never a new one, to learn what came of a command that got no answer. */
export function createRequestId(): string {
  const { crypto } = globalThis;
  // A browser offers randomUUID only in a secure context, which a page over plain http on a LAN address is not.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The first connection is opened before this resolves; its failure is the caller's to handle. */
export async function createKodaXHostClient<Scope extends HostAnswerScope = 'shared'>(
  options: KodaXHostClientOptions,
): Promise<KodaXHostClient<Scope>> {
  const lifetime = new AbortController();
  const host = createHostLink(options, lifetime);
  host.adopt(await options.open(lifetime.signal));
  return {
    get handshake() { return host.handshake(); },
    call: ((method: string, params?: Readonly<Record<string, unknown>>, callOptions?: HostCallOptions) =>
      host.call(method, params, callOptions)) as KodaXHostClient<Scope>['call'],
    observeSession: (sessionId, observer) => host.observe(sessionId, observer as HostSessionObserver<HostAnswerScope>),
    onConnectionChange: host.onConnectionChange,
    answerLeaseRequests: host.answerLeaseRequests,
    answerToolCalls: host.answerToolCalls,
    closed: host.closed,
    close: () => host.close(),
  };
}

interface Waiter {
  resolve(connection: HostRpcClient): void;
  reject(error: HostProtocolError): void;
}

/** The connection that is current, the one that replaces it, and everything that must survive the swap. */
function createHostLink(options: KodaXHostClientOptions, lifetime: AbortController) {
  let current: HostRpcClient | undefined;
  let latest: HostInitializeResult | undefined;
  let firstHostId: string | undefined;
  let ending: HostProtocolError | undefined;
  let finished = false;
  /** Set once a call that ends this client's link went out, so the loss that follows is not taken for a failure. */
  let leaving = false;
  let state: HostConnectionState = { state: 'reconnecting', attempt: 0 };
  const waiters = new Set<Waiter>();
  const stateListeners = new Set<(state: HostConnectionState) => void>();
  const observations = new Set<Observation>();
  /** Runs this client asked to stop. A reconnect never continues them. */
  const stopped = new Set<string>();
  /** Runs already asked to go on under the current Host, which are not asked again however often they wait. */
  const recovered = new Set<string>();
  let leaseHandler: HostLeaseHandler | undefined;
  let toolHandler: HostToolHandler | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const report = (error: unknown): void => options.onError?.(error);
  const setState = (next: HostConnectionState): void => {
    state = next;
    for (const listener of [...stateListeners]) {
      try {
        listener(next);
      } catch (error: unknown) {
        report(error);
      }
    }
  };

  const finish = (error?: HostProtocolError): void => {
    if (finished) return;
    finished = true;
    ending = error ?? new HostProtocolError('unavailable', 'The client is closed.', { reason: 'client_closed', retryable: false });
    lifetime.abort(ending);
    const connection = current;
    current = undefined;
    connection?.close();
    for (const waiter of [...waiters]) waiter.reject(ending);
    waiters.clear();
    for (const observation of [...observations]) observation.dispose();
    setState(error === undefined ? { state: 'closed' } : { state: 'closed', error });
    stateListeners.clear();
    resolveClosed();
  };

  const adopt = (connection: HostRpcClient): void => {
    if (finished) {
      connection.close();
      return;
    }
    const replacedHost = firstHostId !== undefined && firstHostId !== connection.handshake.host.id;
    firstHostId ??= connection.handshake.host.id;
    if (latest?.host.id !== connection.handshake.host.id) recovered.clear();
    current = connection;
    latest = connection.handshake;
    connection.onNotification((method, params) => {
      if (method === 'lease.request') {
        const request = params as HostLeaseRequest;
        void (request.kind === 'host_tool' ? answerToolCall(request) : answerLease(request));
        return;
      }
      for (const observation of [...observations]) observation.receive(connection, method, params);
    });
    void connection.closed.then(() => lost(connection));
    setState({ state: 'connected', handshake: connection.handshake });
    for (const waiter of [...waiters]) waiter.resolve(connection);
    waiters.clear();
    for (const observation of [...observations]) observation.follow(connection, replacedHost);
  };

  const lost = (connection: HostRpcClient): void => {
    if (current !== connection || finished) return;
    current = undefined;
    if (leaving) {
      finish();
      return;
    }
    // A close code is the Host saying what to do next; without one the link was simply lost.
    const { ended } = connection;
    if (ended?.action === 'stop') {
      finish(ended.error);
      return;
    }
    setState(ended === undefined ? { state: 'reconnecting', attempt: 0 } : { state: 'reconnecting', attempt: 0, error: ended.error });
    void reconnect(ended?.action === 'back_off' ? ended.error : undefined);
  };

  /** `backOff` is why the Host asked for a pause before the first attempt. */
  const reconnect = async (backOff?: HostProtocolError): Promise<void> => {
    if (backOff !== undefined) await pause(reconnectDelay(0, backOff), lifetime.signal);
    for (let attempt = 0; !finished; attempt += 1) {
      try {
        adopt(await options.open(lifetime.signal));
        return;
      } catch (error: unknown) {
        if (finished) return;
        if (!(error instanceof HostProtocolError) || !error.retryable) {
          finish(error instanceof HostProtocolError ? error : new HostProtocolError('unavailable', 'The Host cannot be reached.', {
            reason: 'connect_failed', retryable: false, cause: error,
          }));
          return;
        }
        report(error);
        setState({ state: 'reconnecting', attempt: attempt + 1, error });
        await pause(reconnectDelay(attempt, error), lifetime.signal);
      }
    }
  };

  /** The live connection, or the next one. */
  const connection = (signal: AbortSignal | undefined): Promise<HostRpcClient> => {
    if (current !== undefined) return Promise.resolve(current);
    if (ending !== undefined) return Promise.reject(ending);
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        waiters.delete(waiter);
        reject(new HostProtocolError('cancelled', 'The request was cancelled while the Host was being reconnected.'));
      };
      const waiter: Waiter = {
        resolve: (value) => { signal?.removeEventListener('abort', abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error); },
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  };

  const call = async (
    method: string,
    params: Readonly<Record<string, unknown>> | undefined,
    callOptions: HostCallOptions = {},
  ): Promise<never> => {
    noteStop(method, params, stopped);
    const ends = ENDS_CLIENT.has(method);
    for (;;) {
      const link = await connection(callOptions.signal);
      if (ends) leaving = true;
      try {
        return await link.request(method, params, callOptions) as never;
      } catch (error: unknown) {
        const linkLost = lostLink(error);
        // A refused exit leaves the client as it was. One that lost its link most likely did what it asked.
        if (ends && !linkLost) leaving = false;
        if (linkLost) lost(link);
        // A call that was in flight when the client closed keeps that outcome; one never sent learns why the client closed.
        const inFlightAtClose = finished && error instanceof HostProtocolError && error.kodaxCode === 'unknown_outcome';
        if (ends || !linkLost || inFlightAtClose || callOptions.signal?.aborted) throw error;
      }
    }
  };

  /**
   * Continues a Run the replaced Host left part-way, once per Host: a Run that
   * stops again for want of room waits for a person, not for another attempt.
   */
  const recover = (runId: string): void => {
    if (stopped.has(runId) || recovered.has(runId)) return;
    recovered.add(runId);
    void (async () => {
      const leases = await options.recoveryLeases?.(runId);
      await call('run.recover', { requestId: createRequestId(), runId, ...(leases !== undefined ? { leases } : {}) });
    })().catch((error: unknown) => report(error));
  };

  /** The Host is sent fixed words only, so nothing the handler knows, such as a key in an error message, leaves the client. */
  const answerLease = async (request: HostCredentialRequest): Promise<void> => {
    let answer: { readonly credential: string } | { readonly error: string };
    try {
      const credential = leaseHandler === undefined ? undefined : await leaseHandler(request);
      answer = credential === undefined || credential === '' ? { error: 'credential_unavailable' } : { credential };
    } catch (error: unknown) {
      report(error);
      answer = { error: 'credential_broker_failed' };
    }
    await call('lease.complete', { requestId: createRequestId(), kind: 'credential', callId: request.callId, ...answer })
      .catch((error: unknown) => report(error));
  };

  /** Fixed words only on failure, for the reason `answerLease` gives. */
  const answerToolCall = async (request: HostToolCall): Promise<void> => {
    let answer: { readonly result: Awaited<ReturnType<HostToolHandler>> } | { readonly error: string };
    try {
      answer = toolHandler === undefined ? { error: 'host_tool_unavailable' } : { result: await toolHandler(request) };
    } catch (error: unknown) {
      report(error);
      answer = { error: 'host_tool_failed' };
    }
    await call('lease.complete', { requestId: createRequestId(), kind: 'host_tool', callId: request.callId, ...answer })
      .catch((error: unknown) => report(error));
  };

  const observe = async (
    sessionId: string,
    observer: HostSessionObserver<HostAnswerScope>,
  ): Promise<HostSessionObservation> => {
    const observation = createObservation(sessionId, observer, {
      report, recover, forget: (done) => { observations.delete(done); },
    });
    // In the set before it subscribes, so a patch that arrives with the answer is not missed.
    observations.add(observation);
    try {
      observation.follow(await connection(undefined), false);
    } catch (error: unknown) {
      observation.dispose();
      throw error;
    }
    await observation.ready;
    return { close: () => observation.close() };
  };

  return {
    adopt,
    call,
    observe,
    handshake: (): HostInitializeResult => {
      if (latest === undefined) throw new HostProtocolError('invalid_state', 'The client has not connected yet.');
      return latest;
    },
    onConnectionChange(listener: (next: HostConnectionState) => void): () => void {
      if (finished) {
        listener(state);
        return () => undefined;
      }
      stateListeners.add(listener);
      listener(state);
      return () => { stateListeners.delete(listener); };
    },
    answerLeaseRequests: (handler: HostLeaseHandler | undefined): void => { leaseHandler = handler; },
    answerToolCalls: (handler: HostToolHandler | undefined): void => { toolHandler = handler; },
    closed,
    close: () => finish(),
  };
}

/** The connection ended with the call in flight or before it was sent, so sending it again is how to learn its outcome. */
function lostLink(error: unknown): boolean {
  return error instanceof HostProtocolError
    && (error.kodaxCode === 'unknown_outcome' || error.kodaxCode === 'unavailable')
    && (error.reason === 'connection_closed' || error.reason === 'send_failed');
}

function noteStop(method: string, params: Readonly<Record<string, unknown>> | undefined, stopped: Set<string>): void {
  const runId = method === 'run.stop' ? params?.runId : method === 'session.cancel' ? params?.ifRunId : undefined;
  if (typeof runId === 'string') stopped.add(runId);
}

/** Doubles from half a second up to thirty, each pause somewhere between half and all of it, so clients do not return together. */
function reconnectDelay(attempt: number, error: HostProtocolError): number {
  const ceiling = Math.min(MAX_RECONNECT_DELAY_MS, FIRST_RECONNECT_DELAY_MS * 2 ** Math.min(attempt, 6));
  return Math.max(error.retryAfterMs ?? 0, ceiling / 2 + Math.random() * ceiling / 2);
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}

interface Observation {
  /** Settles with the first view, or with the error that kept it from arriving. */
  readonly ready: Promise<void>;
  /** Subscribes again on a new connection. `replacedHost` asks it to continue the Runs the old Host left. */
  follow(connection: HostRpcClient, replacedHost: boolean): void;
  receive(connection: HostRpcClient, method: string, params: Readonly<Record<string, unknown>>): void;
  close(): void;
  /** Ends it without telling the Host, which is gone or about to be. */
  dispose(): void;
}

interface ObservationContext {
  report(error: unknown): void;
  recover(runId: string): void;
  forget(observation: Observation): void;
}

type AnyView = SessionView | LocalSessionView;

/** One followed Session: its copy of the view and where that copy stands. */
function createObservation(
  sessionId: string,
  observer: HostSessionObserver<HostAnswerScope>,
  context: ObservationContext,
): Observation {
  let link: HostRpcClient | undefined;
  let subscriptionId: string | undefined;
  let position: ViewPosition | undefined;
  let view: AnyView | undefined;
  /** Patches that came before the answer they follow was read. */
  let early: ViewPatch[] = [];
  let recoverRuns = false;
  let active = true;
  let settleReady: { resolve(): void; reject(error: unknown): void } | undefined;
  const ready = new Promise<void>((resolve, reject) => { settleReady = { resolve, reject }; });
  // Whoever waits on it hears the rejection; one that nobody waits on must not surface as unhandled.
  ready.catch(() => undefined);

  const deliver = (next: AnyView): void => {
    view = next;
    if (recoverRuns) {
      for (const run of next.runs) if (run.phase === 'recovering') context.recover(run.id);
    }
    try {
      observer.onView(next);
    } catch (error: unknown) {
      context.report(error);
    }
  };

  const accept = (snapshot: ViewSnapshot): void => {
    position = { epoch: snapshot.epoch, seq: snapshot.seq };
    settleReady?.resolve();
    settleReady = undefined;
    deliver(snapshot.snapshot);
    const waiting = early;
    early = [];
    for (const patch of waiting) apply(patch);
  };

  const apply = (patch: ViewPatch): void => {
    if (position === undefined || view === undefined) {
      early.push(patch);
      return;
    }
    const applied = viewPatchStep(position, patch) === 'apply' ? applyViewOps(view, patch.ops) : undefined;
    if (applied?.view === undefined) {
      resubscribe();
      return;
    }
    position = { epoch: patch.epoch, seq: patch.seq };
    deliver(applied.view as AnyView);
  };

  const subscribe = async (connection: HostRpcClient): Promise<void> => {
    link = connection;
    position = undefined;
    early = [];
    subscriptionId = createRequestId();
    const answer = await connection.request('view.subscribe', {
      subscriptionId,
      target: { kind: 'session', sessionId },
    }) as unknown as ViewSnapshot;
    if (!active || link !== connection || answer.subscriptionId !== subscriptionId) return;
    accept(answer);
  };

  /** Subscribes again in the background. A failure other than a lost link ends the observation. */
  const resubscribe = (): void => {
    const connection = link;
    const previous = subscriptionId;
    if (!active || connection === undefined) return;
    if (previous !== undefined) {
      connection.request('view.unsubscribe', { subscriptionId: previous }).catch((error: unknown) => {
        if (!lostLink(error)) context.report(error);
      });
    }
    subscribe(connection).catch((error: unknown) => {
      // The next connection subscribes again.
      if (lostLink(error)) return;
      // The caller of `observeSession` is told why the first view never came.
      if (settleReady !== undefined) {
        settleReady.reject(error);
        dispose();
        return;
      }
      context.report(error);
      end(error instanceof HostProtocolError ? error.kodaxCode : 'internal');
    });
  };

  const end = (reason: string): void => {
    if (!active) return;
    dispose();
    try {
      observer.onClosed?.(reason);
    } catch (error: unknown) {
      context.report(error);
    }
  };

  const dispose = (): void => {
    if (!active) return;
    active = false;
    settleReady?.reject(new HostProtocolError('unavailable', 'The client closed before the view arrived.', {
      reason: 'client_closed', retryable: false,
    }));
    settleReady = undefined;
    context.forget(observation);
  };

  const observation: Observation = {
    ready,
    follow(connection, replacedHost) {
      if (!active) return;
      recoverRuns ||= replacedHost;
      link = connection;
      subscriptionId = undefined;
      resubscribe();
    },
    receive(connection, method, params) {
      if (!active || connection !== link || params.subscriptionId !== subscriptionId) return;
      if (method === 'view.patch') apply(params as unknown as ViewPatch);
      else if (method === 'view.reset') accept(params as unknown as ViewSnapshot);
      else if (method === 'view.closed') end(typeof params.reason === 'string' ? params.reason : 'closed');
    },
    close() {
      if (!active) return;
      const connection = link;
      const previous = subscriptionId;
      dispose();
      if (connection !== undefined && previous !== undefined) {
        connection.request('view.unsubscribe', { subscriptionId: previous }).catch((error: unknown) => {
          if (!lostLink(error)) context.report(error);
        });
      }
    },
    dispose,
  };
  return observation;
}
