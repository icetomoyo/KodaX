/**
 * Why the Host hung up on a network connection, and the WebSocket close code
 * that carries it. Each reason asks the client for one action. The codes are
 * 4000 plus the HTTP status that means the same thing.
 */
export const HOST_CLOSE_CODES = {
  /** The client broke the protocol. Do not reconnect; report it. */
  protocol: 4400,
  /** The credential expired or is not good. Get a new one, then reconnect. */
  credential: 4401,
  /** The device was revoked or the Host's authentication changed. Do not reconnect; tell the user. */
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
