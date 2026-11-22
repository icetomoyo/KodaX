/**
 * One v2 connection, whatever carries it. The transport hands in text frames
 * and takes text frames back; this layer owns the handshake, which methods the
 * connection may call, validation in both directions and cancellation.
 */
import { runtimeRoleHasPlane, type RuntimeConnectionRole, type RuntimeMethodPlane } from '../runtime-daemon/access.js';
import {
  HOST_PROTOCOL,
  HOST_PROTOCOL_REVISION,
  HostProtocolError,
  hostRpcFailure,
  hostRpcSuccess,
  parseHostRpcFrame,
  type HostRpcFailure,
  type HostRpcId,
  type HostRpcNotification,
  type HostRpcRequest,
  type HostRpcSuccess,
} from './codec.js';
import { HOST_METHODS, type HostInitializeParams, type HostLimits, type HostMethodRegistry } from './methods.js';

/** A connection that has not finished the handshake by then is hung up on. */
const INITIALIZE_TIMEOUT_MS = 10_000;
/** A handshake is small. Larger frames wait until the client has proved who it is. */
const PRE_INITIALIZE_FRAME_CHARS = 16 * 1024;
/** How many validation problems one error message names. */
const REPORTED_ISSUES = 5;

export interface HostAdmissionRequest {
  readonly client: HostInitializeParams['client'];
  readonly auth: HostInitializeParams['auth'];
  /** The revision this connection will use. */
  readonly revision: number;
}

/** What the Host grants a client it admitted, and how the connection reaches the Host from then on. */
export interface HostAdmission {
  readonly role: RuntimeConnectionRole;
  readonly subject: string;
  readonly host: { readonly id: string; readonly version: string };
  readonly features: readonly string[];
  readonly locks: readonly string[];
  readonly limits: HostLimits;
  readonly expiresAt?: number;
  /**
   * Runs a method whose params already passed its schema. The result is cut to
   * the contract before it is sent. What is passed to `afterAnswer` runs once
   * the answer is on the wire, so a method can keep what follows its answer
   * from overtaking it.
   */
  call(
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    afterAnswer: (run: () => void) => void,
  ): Promise<unknown>;
  close(): void;
}

export interface HostConnectionOptions {
  readonly methods: HostMethodRegistry;
  readonly send: (frame: string) => void;
  /** Hangs up after delivering what was already sent. */
  readonly disconnect: () => void;
  /** Checks the credential. Throws `HostProtocolError` to refuse; the connection then hangs up. */
  readonly admit: (request: HostAdmissionRequest) => Promise<HostAdmission>;
  /** Receives what the client is not shown: an unexpected failure or a result that broke the contract. */
  readonly onInternalError: (method: string, error: unknown) => void;
  /** @internal Tests shorten the handshake deadline. */
  readonly initializeTimeoutMs?: number;
}

export interface HostConnection {
  receive(frame: string): void;
  close(): void;
}

interface SchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export function createHostConnection(options: HostConnectionOptions): HostConnection {
  let state: 'new' | 'admitting' | 'ready' | 'closed' = 'new';
  let admission: HostAdmission | undefined;
  let callable: ReadonlySet<string> = new Set();
  const reaches = (plane: RuntimeMethodPlane): boolean => runtimeRoleHasPlane(admission?.role, plane);
  const inFlight = new Map<HostRpcId, AbortController>();

  const close = (): void => {
    if (state === 'closed') return;
    state = 'closed';
    clearTimeout(deadline);
    for (const controller of inFlight.values()) {
      controller.abort(new HostProtocolError('cancelled', 'The connection closed.'));
    }
    inFlight.clear();
    admission?.close();
  };
  const hangUp = (): void => {
    close();
    options.disconnect();
  };
  const deadline = setTimeout(() => {
    if (state === 'new' || state === 'admitting') hangUp();
  }, options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS);

  const send = (message: HostRpcSuccess | HostRpcFailure): void => {
    if (state !== 'closed') options.send(JSON.stringify(message));
  };
  const fail = (id: HostRpcId | null, error: HostProtocolError): void => send(hostRpcFailure(id, error));
  /** Hides everything but a deliberate protocol error from the client. */
  const clientError = (method: string, error: unknown): HostProtocolError => {
    if (error instanceof HostProtocolError) return error;
    options.onInternalError(method, error);
    return new HostProtocolError('internal', 'The Host could not complete this request.');
  };
  /**
   * Sends what the contract names and nothing else, so a handler cannot leak a
   * field. Host paths are in the contract of a role on the Host's own machine only.
   */
  const succeed = (id: HostRpcId, method: string, value: unknown): void => {
    if (state === 'closed') return;
    try {
      const spec = options.methods[method];
      const checked = ((reaches('local') ? spec?.localResult : undefined) ?? spec?.result)?.safeParse(value);
      if (checked?.success !== true) {
        throw new Error(`Result does not match the contract: ${describeIssues(checked?.error.issues ?? [], 'result')}`);
      }
      options.send(JSON.stringify(hostRpcSuccess(id, checked.data as Record<string, unknown>)));
    } catch (error: unknown) {
      fail(id, clientError(method, error));
    }
  };

  const initialize = async (request: HostRpcRequest): Promise<void> => {
    if (state !== 'new') {
      fail(request.id, new HostProtocolError('invalid_state', 'This connection already sent initialize.', {
        reason: 'already_initialized',
      }));
      return;
    }
    const params = HOST_METHODS.initialize.params.safeParse(request.params ?? {});
    if (!params.success) {
      fail(request.id, new HostProtocolError('invalid_params', describeIssues(params.error.issues, 'params')));
      return;
    }
    const revision = Math.min(params.data.revision, HOST_PROTOCOL_REVISION);
    state = 'admitting';
    let admitted: HostAdmission;
    try {
      admitted = await options.admit({ client: params.data.client, auth: params.data.auth, revision });
    } catch (error: unknown) {
      fail(request.id, clientError('initialize', error));
      hangUp();
      return;
    }
    if (state !== 'admitting') {
      admitted.close();
      return;
    }
    admission = admitted;
    callable = new Set(Object.entries(options.methods)
      .filter(([, spec]) => reaches(spec.plane))
      .map(([name]) => name));
    state = 'ready';
    clearTimeout(deadline);
    succeed(request.id, 'initialize', {
      protocol: HOST_PROTOCOL,
      revision,
      role: admitted.role,
      subject: admitted.subject,
      host: admitted.host,
      methods: [...callable],
      features: admitted.features,
      locks: admitted.locks,
      ...(admitted.expiresAt !== undefined ? { expiresAt: admitted.expiresAt } : {}),
      limits: admitted.limits,
    });
  };

  const handleRequest = async (request: HostRpcRequest): Promise<void> => {
    const { id, method } = request;
    if (method === 'initialize') {
      await initialize(request);
      return;
    }
    if (state !== 'ready' || admission === undefined) {
      fail(id, new HostProtocolError('invalid_state', 'Send initialize before any other method.', {
        reason: 'not_initialized',
      }));
      return;
    }
    // One answer for a method the Host lacks and one this role may not call:
    // a connection learns nothing about what lies outside its own list.
    const spec = callable.has(method) ? options.methods[method] : undefined;
    if (spec?.result === undefined) {
      fail(id, new HostProtocolError('method_not_found', `${method} is not a method this connection can call.`));
      return;
    }
    if (inFlight.has(id)) {
      fail(id, new HostProtocolError('invalid_params', 'A request with this id is still in flight.', {
        reason: 'request_id_in_flight',
      }));
      return;
    }
    const params = spec.params.safeParse(request.params ?? {});
    if (!params.success) {
      fail(id, new HostProtocolError('invalid_params', describeIssues(params.error.issues, 'params')));
      return;
    }
    const refused = Object.entries(spec.restricted ?? {})
      .find(([name, plane]) => Object.hasOwn(params.data as object, name) && !reaches(plane));
    if (refused !== undefined) {
      fail(id, new HostProtocolError('forbidden', `This connection may not send ${refused[0]} to ${method}.`, {
        reason: 'param_not_allowed',
      }));
      return;
    }
    if (method === 'ping') {
      succeed(id, method, {});
      return;
    }
    const controller = new AbortController();
    inFlight.set(id, controller);
    const afterAnswer: (() => void)[] = [];
    let outcome: { readonly result: unknown } | { readonly error: unknown };
    try {
      outcome = {
        result: await admission.call(method, params.data as Record<string, unknown>, controller.signal,
          run => afterAnswer.push(run)),
      };
    } catch (error: unknown) {
      outcome = { error };
    }
    // The id is free again before the answer goes out, so the client may reuse it at once.
    if (inFlight.get(id) === controller) inFlight.delete(id);
    if ('error' in outcome) fail(id, clientError(method, outcome.error));
    else succeed(id, method, outcome.result);
    for (const run of afterAnswer) run();
  };

  const handleNotification = (notification: HostRpcNotification): void => {
    // A notification gets no answer, so one this build does not know is dropped.
    if (state !== 'ready' || notification.method !== 'request.cancel') return;
    const params = HOST_METHODS['request.cancel'].params.safeParse(notification.params ?? {});
    if (!params.success) return;
    inFlight.get(params.data.id)?.abort(new HostProtocolError('cancelled', 'The client cancelled this request.'));
  };

  return {
    receive(frame) {
      if (state === 'closed') return;
      if (state !== 'ready' && frame.length > PRE_INITIALIZE_FRAME_CHARS) {
        fail(null, new HostProtocolError('limit_exceeded', 'Frame is too large to send before initialize.', {
          reason: 'frame_too_large_before_initialize',
        }));
        hangUp();
        return;
      }
      const parsed = parseHostRpcFrame(frame);
      if (parsed.kind === 'invalid') send(parsed.failure);
      else if (parsed.kind === 'request') {
        const { method } = parsed.message;
        handleRequest(parsed.message).catch((error: unknown) => options.onInternalError(method, error));
      }
      else if (parsed.kind === 'notification') handleNotification(parsed.message);
      // The Host sends no requests on this connection yet, so a response has nothing to answer.
    },
    close,
  };
}

function describeIssues(issues: readonly SchemaIssue[], root: string): string {
  const named = issues.slice(0, REPORTED_ISSUES)
    .map(issue => `${issue.path.length > 0 ? issue.path.map(String).join('.') : root}: ${issue.message}`);
  if (issues.length > REPORTED_ISSUES) named.push(`and ${issues.length - REPORTED_ISSUES} more`);
  return named.join('; ');
}
