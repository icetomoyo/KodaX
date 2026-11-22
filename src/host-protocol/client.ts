/**
 * The client end of one v2 connection, whatever carries it. The caller supplies
 * a `dial` that opens the link and moves whole text frames; this layer owns the
 * handshake, pairing answers with requests, cancellation and what a lost link
 * means for work in flight. No Node dependency, so the browser SDK shares it.
 */
import {
  HOST_PROTOCOL,
  HOST_PROTOCOL_REVISION,
  HostProtocolError,
  hostProtocolErrorFrom,
  hostRpcFailure,
  hostRpcNotification,
  hostRpcRequest,
  parseHostRpcFrame,
  type HostRpcId,
} from './codec.js';
import type { HostInitializeParams, HostInitializeResult } from './methods.js';

/** A Host that has not answered the handshake by then is given up on. */
const INITIALIZE_TIMEOUT_MS = 10_000;

export interface HostRpcLinkEvents {
  /** One whole frame from the Host. */
  frame(text: string): void;
  /** The link is gone, whichever side ended it. */
  end(): void;
}

export interface HostRpcLink {
  send(frame: string): void;
  /** Safe to call more than once, and after the link already ended. */
  close(): void;
}

/** Opens a link to a Host. Rejects when the Host cannot be reached. */
export type HostRpcDial = (events: HostRpcLinkEvents) => Promise<HostRpcLink>;

export interface HostRpcClientOptions {
  readonly client: HostInitializeParams['client'];
  readonly auth: HostInitializeParams['auth'];
  /** Receives what no caller is otherwise told: a listener that threw, a frame that could not be read or sent. */
  readonly onError?: (error: unknown) => void;
}

export type HostRpcNotificationListener = (method: string, params: Readonly<Record<string, unknown>>) => void;

export interface HostRpcClient {
  /** What the Host granted this connection. */
  readonly handshake: HostInitializeResult;
  /**
   * Rejects with `HostProtocolError`. An aborted signal asks the Host to cancel
   * and still waits for its answer, because only the Host knows what happened.
   */
  request(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Readonly<Record<string, unknown>>>;
  /** Returns the function that removes the listener. */
  onNotification(listener: HostRpcNotificationListener): () => void;
  /** Settles when the link is gone, whichever side ended it. */
  readonly closed: Promise<void>;
  close(): void;
}

interface PendingRequest {
  resolve(result: Readonly<Record<string, unknown>>): void;
  reject(error: HostProtocolError): void;
}

export async function connectHostRpc(dial: HostRpcDial, options: HostRpcClientOptions): Promise<HostRpcClient> {
  const pending = new Map<HostRpcId, PendingRequest>();
  const listeners = new Set<HostRpcNotificationListener>();
  let nextId = 1;
  let open = true;
  let link: HostRpcLink | undefined;
  let maxFrameBytes = Number.POSITIVE_INFINITY;
  /** Set while the handshake waits. A frame that is not v2 then means the peer does not speak it. */
  let refuseHandshake: ((error: HostProtocolError) => void) | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const report = (error: unknown): void => options.onError?.(error);
  const transmit = (frame: string): boolean => {
    try {
      link?.send(frame);
      return link !== undefined;
    } catch (error: unknown) {
      report(error);
      return false;
    }
  };

  const end = (): void => {
    if (!open) return;
    open = false;
    const lost = [...pending.values()];
    pending.clear();
    listeners.clear();
    for (const request of lost) {
      // The request was sent and never answered, so only the Host knows whether it took effect.
      request.reject(new HostProtocolError('unknown_outcome', 'The connection closed before the Host answered.', {
        reason: 'connection_closed',
      }));
    }
    resolveClosed();
  };
  const close = (): void => {
    if (!open) return;
    end();
    link?.close();
  };

  const receive = (text: string): void => {
    if (!open) return;
    const parsed = parseHostRpcFrame(text);
    if (parsed.kind === 'success') {
      const request = pending.get(parsed.message.id);
      pending.delete(parsed.message.id);
      request?.resolve(parsed.message.result);
    } else if (parsed.kind === 'failure') {
      const { id } = parsed.message;
      const error = hostProtocolErrorFrom(parsed.message);
      const request = id === null ? undefined : pending.get(id);
      // A failure that answers no request means the Host could not read a frame this client sent.
      if (id === null || request === undefined) report(error);
      else {
        pending.delete(id);
        request.reject(error);
      }
    } else if (parsed.kind === 'notification') {
      const { method, params = {} } = parsed.message;
      for (const listener of [...listeners]) {
        try {
          listener(method, params);
        } catch (error: unknown) {
          report(error);
        }
      }
    } else if (parsed.kind === 'request') {
      // The Host is owed an answer even though this client serves no method yet.
      const { id, method } = parsed.message;
      transmit(JSON.stringify(hostRpcFailure(id, new HostProtocolError(
        'method_not_found',
        `${method} is not a method this client serves.`,
      ))));
    } else if (refuseHandshake !== undefined) {
      // An older Host answers the handshake in v1, which would otherwise leave it waiting for the deadline.
      refuseHandshake(new HostProtocolError('invalid_state', 'The Host does not speak this protocol.', {
        reason: 'protocol_mismatch',
      }));
    } else {
      report(hostProtocolErrorFrom(parsed.failure));
    }
  };

  const request: HostRpcClient['request'] = (method, params, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HostProtocolError('cancelled', 'The request was cancelled before it was sent.'));
      return;
    }
    if (!open) {
      reject(new HostProtocolError('unavailable', 'The connection to the Host is closed.', {
        reason: 'connection_closed',
      }));
      return;
    }
    const id = nextId++;
    const frame = JSON.stringify(hostRpcRequest(id, method, params));
    if (frameExceeds(frame, maxFrameBytes)) {
      reject(new HostProtocolError('limit_exceeded', `The request is larger than the ${maxFrameBytes} bytes this Host accepts.`, {
        reason: 'frame_too_large',
      }));
      return;
    }
    const cancel = (): void => {
      if (open && pending.has(id)) transmit(JSON.stringify(hostRpcNotification('request.cancel', { id })));
    };
    const release = (): void => signal?.removeEventListener('abort', cancel);
    pending.set(id, {
      resolve: (result) => { release(); resolve(result); },
      reject: (error) => { release(); reject(error); },
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (!transmit(frame)) {
      pending.delete(id);
      release();
      reject(new HostProtocolError('unavailable', 'The request could not be sent to the Host.', {
        reason: 'send_failed',
      }));
    }
  });

  try {
    link = await dial({ frame: receive, end });
  } catch (cause: unknown) {
    end();
    throw new HostProtocolError('unavailable', 'The Host could not be reached.', { reason: 'connect_failed', cause });
  }
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      request('initialize', {
        protocol: HOST_PROTOCOL,
        revision: HOST_PROTOCOL_REVISION,
        client: options.client,
        auth: options.auth,
      }),
      new Promise<never>((_resolve, reject) => {
        refuseHandshake = reject;
        deadline = setTimeout(() => {
          reject(new HostProtocolError('timeout', 'The Host did not answer the handshake in time.'));
        }, INITIALIZE_TIMEOUT_MS);
      }),
    ]);
    const handshake = readHandshake(answer);
    maxFrameBytes = handshake.limits.maxFrameBytes;
    return {
      handshake,
      request,
      onNotification(listener) {
        if (open) listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      closed,
      close,
    };
  } catch (error: unknown) {
    close();
    // A handshake changes nothing on the Host, so losing the link during one is a plain failure to connect.
    if (error instanceof HostProtocolError && error.kodaxCode === 'unknown_outcome') {
      throw new HostProtocolError('unavailable', 'The Host closed the connection during the handshake.', {
        reason: 'connection_closed',
      });
    }
    throw error;
  } finally {
    refuseHandshake = undefined;
    clearTimeout(deadline);
  }
}

/** Checks the fields this layer relies on. The Host validates the whole result against the contract before sending it. */
function readHandshake(answer: Readonly<Record<string, unknown>>): HostInitializeResult {
  const { protocol, revision, methods, limits } = answer;
  const usable = protocol === HOST_PROTOCOL
    && typeof revision === 'number' && Number.isInteger(revision) && revision >= 1 && revision <= HOST_PROTOCOL_REVISION
    && Array.isArray(methods)
    && typeof limits === 'object' && limits !== null
    && typeof (limits as Record<string, unknown>).maxFrameBytes === 'number';
  if (!usable) {
    throw new HostProtocolError('invalid_state', 'The Host answered the handshake in a protocol this client does not speak.', {
      reason: 'protocol_mismatch',
    });
  }
  return answer as unknown as HostInitializeResult;
}

function frameExceeds(frame: string, maxBytes: number): boolean {
  // UTF-8 takes at most three bytes per UTF-16 unit, so most frames are cleared without encoding them.
  if (frame.length * 3 <= maxBytes) return false;
  return frame.length > maxBytes || new TextEncoder().encode(frame).length > maxBytes;
}
