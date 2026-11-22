/**
 * The WebSocket wire both ends share: the path, and why the Host hung up on a
 * connection with the close code that carries it. Each reason asks the client
 * for one action. The codes are 4000 plus the HTTP status that means the same
 * thing.
 */
import { HostProtocolError, type HostErrorCode } from './codec.js';

/** The path a client opens the WebSocket on. Others are left for the Host's web pages. */
export const HOST_WEBSOCKET_PATH = '/v2';

export const HOST_CLOSE_CODES = {
  /** The client broke the protocol. Do not reconnect; report it. */
  protocol: 4400,
  /** The credential expired or is not good. Get a new one, then reconnect. */
  credential: 4401,
  /** The device was revoked, the browser's origin is not allowed, or the Host's authentication changed. Do not reconnect; tell the user. */
  revoked: 4403,
  /** Nothing arrived within `limits.idleTimeoutMs`. Reconnect. */
  idle: 4408,
  /** A newer connection of the same client instance took over. Do not reconnect. */
  replaced: 4409,
  /** The Host has too many connections, or this client read too slowly. Back off, then reconnect. */
  overloaded: 4429,
  /** The Host is stopping or cannot check credentials right now. Back off, then reconnect. */
  unavailable: 4503,
} as const;

export type HostCloseReason = keyof typeof HOST_CLOSE_CODES;

/** A WebSocket close as the client saw it. */
export interface HostLinkClose {
  readonly code: number;
  readonly reason: string;
}

/** What a client does next after the Host closed its link, and the error it reports. */
export interface HostLinkEnd {
  readonly action: 'stop' | 'reconnect' | 'back_off';
  /** Retryable unless `action` is `stop`. */
  readonly error: HostProtocolError;
}

const CLOSE_ACTIONS: Readonly<Record<HostCloseReason, { readonly action: HostLinkEnd['action']; readonly code: HostErrorCode }>> = {
  protocol: { action: 'stop', code: 'invalid_state' },
  credential: { action: 'reconnect', code: 'unauthorized' },
  revoked: { action: 'stop', code: 'unauthorized' },
  idle: { action: 'reconnect', code: 'timeout' },
  replaced: { action: 'stop', code: 'conflict' },
  overloaded: { action: 'back_off', code: 'overloaded' },
  unavailable: { action: 'back_off', code: 'unavailable' },
};

/** Any close without a Host reason, such as a dropped network, is a lost connection. */
export function hostLinkEnd(close: HostLinkClose): HostLinkEnd {
  const name = (Object.keys(HOST_CLOSE_CODES) as HostCloseReason[]).find(key => HOST_CLOSE_CODES[key] === close.code);
  if (name === undefined) {
    return {
      action: 'reconnect',
      error: new HostProtocolError('unavailable', 'The connection to the Host was lost.', { reason: 'connection_closed', retryable: true }),
    };
  }
  const { action, code } = CLOSE_ACTIONS[name];
  return {
    action,
    error: new HostProtocolError(code, `The Host closed the connection: ${name}.`, {
      reason: close.reason !== '' ? close.reason : name, retryable: action !== 'stop',
    }),
  };
}
