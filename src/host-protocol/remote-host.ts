/**
 * Reaching a Host over its network port: the WebSocket link, a credential
 * fetched for each connection, and renewing that credential before the Host
 * ends the connection for it. No Node dependency: it uses the global
 * `WebSocket` of a browser, or of Node 22.4 and later.
 */
import { connectHostRpc, type HostRpcClient, type HostRpcDial } from './client.js';
import { HOST_CLOSE_CODES, HOST_WEBSOCKET_PATH } from './close.js';
import { HostProtocolError } from './codec.js';
import { createKodaXHostClient, type KodaXHostClient, type KodaXHostClientOptions } from './host-client.js';
import type { HostInitializeParams } from './methods.js';

/** A Host that has not accepted the socket by then is given up on, and tried again. */
const OPEN_TIMEOUT_MS = 10_000;
/** The share of a credential's remaining life after which it is renewed. */
const RENEW_AFTER = 0.8;
/** The longest delay a timer holds, about 24 days. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface ConnectKodaXHostOptions {
  /** The Host's address, such as `https://host.example` or `wss://host.example/v2`. A page the Host serves passes `location.origin`. */
  readonly url: string;
  readonly client: HostInitializeParams['client'];
  /**
   * Gives the JWT for the next connection, and for each renewal. Leave it out
   * in a browser paired with the Host, whose device cookie proves who it is.
   */
  readonly credential?: () => string | Promise<string>;
  /** Receives what no caller is otherwise told, such as a renewal that failed. */
  readonly onError?: (error: unknown) => void;
  readonly recoveryLeases?: KodaXHostClientOptions['recoveryLeases'];
}

/** A client of a Host on the network. The first connection is open before this resolves. */
export function connectKodaXHost(options: ConnectKodaXHostOptions): Promise<KodaXHostClient> {
  return createKodaXHostClient({
    open: openHostWebSocket(options),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    ...(options.recoveryLeases !== undefined ? { recoveryLeases: options.recoveryLeases } : {}),
  });
}

/** The `open` of a Host client: one WebSocket connection, with a fresh credential, kept renewed. */
export function openHostWebSocket(options: ConnectKodaXHostOptions): (signal: AbortSignal) => Promise<HostRpcClient> {
  const url = hostWebSocketUrl(options.url);
  const { credential, onError } = options;
  return async () => {
    const token = credential === undefined ? undefined : await fetchCredential(credential);
    const connection = await connectHostRpc(dialHostWebSocket(url), {
      client: options.client,
      ...(token !== undefined ? { auth: { scheme: 'jwt', token } } : {}),
      ...(onError !== undefined ? { onError } : {}),
    });
    if (credential !== undefined) keepRenewed(connection, credential, onError);
    return connection;
  };
}

/** A credential the caller could not get now may be there on the next attempt. */
async function fetchCredential(credential: () => string | Promise<string>): Promise<string> {
  try {
    return await credential();
  } catch (cause: unknown) {
    throw new HostProtocolError('unavailable', 'The credential for the Host could not be fetched.', {
      reason: 'credential_unavailable', retryable: true, cause,
    });
  }
}

/**
 * Renews the credential once most of its life has passed. A renewal that fails
 * is reported and not retried: the Host ends the connection when the credential
 * runs out, and the next connection fetches a new one.
 */
function keepRenewed(connection: HostRpcClient, credential: () => string | Promise<string>, report?: (error: unknown) => void): void {
  let open = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (expiresAt: number | undefined): void => {
    if (!open || expiresAt === undefined) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, (expiresAt - Date.now()) * RENEW_AFTER));
    timer = setTimeout(() => void renew(), delay);
  };
  const renew = async (): Promise<void> => {
    try {
      const { expiresAt } = await connection.request('auth.renew', { token: await credential() });
      schedule(typeof expiresAt === 'number' ? expiresAt : undefined);
    } catch (error: unknown) {
      if (open) report?.(error);
    }
  };
  void connection.closed.then(() => {
    open = false;
    clearTimeout(timer);
  });
  schedule(connection.handshake.expiresAt);
}

/** `http(s)` becomes `ws(s)`, and an address without a path gets the v2 path. */
function hostWebSocketUrl(address: string): string {
  const url = new URL(address);
  const scheme = ({ 'http:': 'ws:', 'https:': 'wss:', 'ws:': 'ws:', 'wss:': 'wss:' } as Record<string, string>)[url.protocol];
  if (scheme === undefined) throw new TypeError(`A Host address must be http, https, ws or wss: ${address}`);
  url.protocol = scheme;
  if (url.pathname === '/') url.pathname = HOST_WEBSOCKET_PATH;
  return url.href;
}

/** A link over one WebSocket. It rejects when the socket closes or stalls before it opens. */
function dialHostWebSocket(url: string): HostRpcDial {
  return events => new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let opened = false;
    const deadline = setTimeout(() => {
      reject(new Error(`The Host did not accept the WebSocket within ${OPEN_TIMEOUT_MS} ms.`));
      socket.close();
    }, OPEN_TIMEOUT_MS);
    socket.addEventListener('open', () => {
      opened = true;
      clearTimeout(deadline);
      resolve({ send: frame => socket.send(frame), close: () => socket.close() });
    });
    socket.addEventListener('message', (event) => {
      // The Host sends text only, so anything else is a broken peer.
      if (typeof event.data === 'string') events.frame(event.data);
      else socket.close(HOST_CLOSE_CODES.protocol, 'protocol');
    });
    // A browser says nothing about why a socket failed; the close that follows carries what is known.
    socket.addEventListener('error', () => undefined);
    socket.addEventListener('close', (event) => {
      clearTimeout(deadline);
      if (opened) events.end({ code: event.code, reason: event.reason });
      else reject(new Error(`The WebSocket closed before it opened (code ${event.code}).`));
    });
  });
}
