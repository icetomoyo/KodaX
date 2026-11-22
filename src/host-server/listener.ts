/**
 * Carries v2 over WebSocket for clients that are not on the Host's machine. It
 * owns what belongs to the wire: which path and browser origins may open a
 * socket, how many sockets may wait for their handshake, silence, a client
 * that stops reading, and the close code that tells a client why. The peer it
 * creates for each socket owns the protocol, credentials included.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';

import { emitKodaXDiagnostic } from '@kodax-ai/agent';

import { HOST_CLOSE_CODES, type HostCloseReason } from '../host-protocol/close.js';
import { prepareUnixSocketEndpoint } from '../runtime-daemon/transport.js';

/** The path a client opens the WebSocket on. Others are left for the Host's web pages. */
export const HOST_WEBSOCKET_PATH = '/v2';

/** Sockets that may wait for their handshake at once. Each may hold one frame of up to `maxFrameBytes` while it waits. */
const MAX_PENDING_HANDSHAKES = 32;
/** Bytes queued for a client before it counts as behind, so view patches coalesce until it catches up. */
const CONGESTED_BYTES = 64 * 1024;
/** Bytes queued for a client that stopped reading before the Host hangs up on it. */
const MAX_OUTBOUND_BYTES = 64 * 1024 * 1024;
/** How long a stopping Host waits for clients to answer its close before it drops them. */
const CLOSE_GRACE_MS = 2_000;
/** How long a client has to read what was queued and answer a close before the Host drops the socket. */
const DISCONNECT_GRACE_MS = 30_000;

export interface HostNetworkTransport {
  send(frame: string): void;
  /** Hangs up after what was already sent, with the close code for `reason`. */
  disconnect(reason: HostCloseReason): void;
  /** Whether the client is behind on reading what was already sent. */
  congested(): boolean;
}

export interface HostNetworkPeer {
  receive(frame: string): void;
  /** The client caught up on reading after the connection was congested. */
  drained?(): void;
  close(): void;
  /** Whether the client finished its handshake. Until then it counts against the pending limit. */
  admitted(): boolean;
}

export interface HostNetworkListenerOptions {
  readonly listen: { readonly hostname: string; readonly port: number } | { readonly socketPath: string };
  /** Browser origins that may open a socket. A client that sends no Origin is not a browser and is let through. */
  readonly allowedOrigins: readonly string[];
  readonly maxFrameBytes: number;
  /** A socket the Host hears nothing on for this long is closed as idle. */
  readonly idleTimeoutMs: number;
  readonly createPeer: (transport: HostNetworkTransport) => HostNetworkPeer;
  /** @internal Tests lower the limits. */
  readonly maxPendingHandshakes?: number;
  /** @internal */
  readonly maxOutboundBytes?: number;
}

export interface HostNetworkListener {
  /** The TCP port it listens on, which is the one the system chose when the config named 0. Absent on a socket path. */
  readonly port?: number;
  close(): Promise<void>;
}

/** The part of the `ws` package the listener uses; the root package carries no types for it. */
interface WsSocket {
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code: number, reason: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
}
interface WsServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WsSocket) => void): void;
}
type WsServerConstructor = new (options: {
  readonly noServer: true;
  readonly maxPayload: number;
  readonly perMessageDeflate: false;
  readonly clientTracking: false;
}) => WsServer;

export async function startHostNetworkListener(options: HostNetworkListenerOptions): Promise<HostNetworkListener> {
  const { WebSocketServer } = createRequire(import.meta.url)('ws') as { WebSocketServer: WsServerConstructor };
  // Compression is off: a small compressed frame could inflate past every limit here.
  const wss = new WebSocketServer({ noServer: true, maxPayload: options.maxFrameBytes, perMessageDeflate: false, clientTracking: false });
  const maxPending = options.maxPendingHandshakes ?? MAX_PENDING_HANDSHAKES;
  const connections = new Map<WsSocket, HostNetworkPeer>();
  let stopping = false;

  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const refusal = refuseUpgrade(request);
    if (refusal !== undefined) {
      socket.end(`HTTP/1.1 ${refusal}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, attach);
  });

  function refuseUpgrade(request: IncomingMessage): string | undefined {
    if (stopping) return '503 Service Unavailable';
    if (new URL(request.url ?? '/', 'http://host').pathname !== HOST_WEBSOCKET_PATH) return '404 Not Found';
    const { origin } = request.headers;
    if (origin !== undefined && !options.allowedOrigins.includes(origin)) return '403 Forbidden';
    const pending = [...connections.values()].filter(peer => !peer.admitted()).length;
    return pending >= maxPending ? '503 Service Unavailable' : undefined;
  }

  function attach(socket: WsSocket): void {
    let open = true;
    let congested = false;
    let dropAfterGrace: ReturnType<typeof setTimeout> | undefined;
    const disconnect = (reason: HostCloseReason): void => {
      if (!open) return;
      open = false;
      clearTimeout(idle);
      // Sent after every frame already queued, so the client reads those first.
      socket.close(HOST_CLOSE_CODES[reason], reason);
      // A client that stopped reading never reaches the close frame.
      dropAfterGrace = setTimeout(() => socket.terminate(), DISCONNECT_GRACE_MS);
    };
    /** A client this far behind would not read a close frame either, so it is dropped and reconnects as after any lost socket. */
    const dropSlowClient = (): void => {
      open = false;
      clearTimeout(idle);
      emitKodaXDiagnostic({
        source: 'host.network', level: 'warn', message: 'Closed a network connection whose client stopped reading.',
        detail: { queuedBytes: socket.bufferedAmount },
      });
      socket.terminate();
    };
    const idle = setTimeout(() => disconnect('idle'), options.idleTimeoutMs);
    const caughtUp = (): void => {
      if (!congested || socket.bufferedAmount > CONGESTED_BYTES) return;
      congested = false;
      peer.drained?.();
    };
    const peer = options.createPeer({
      send(frame) {
        if (!open) return;
        socket.send(frame, caughtUp);
        if (socket.bufferedAmount > (options.maxOutboundBytes ?? MAX_OUTBOUND_BYTES)) dropSlowClient();
        else if (socket.bufferedAmount > CONGESTED_BYTES) congested = true;
      },
      disconnect,
      congested: () => congested,
    });
    connections.set(socket, peer);
    socket.on('message', (data, isBinary) => {
      if (!open) return;
      if (isBinary) {
        disconnect('protocol');
        return;
      }
      idle.refresh();
      peer.receive(data.toString('utf8'));
    });
    // A frame over the size limit, or a broken socket, ends in 'close' after this.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      open = false;
      clearTimeout(idle);
      clearTimeout(dropAfterGrace);
      connections.delete(socket);
      peer.close();
    });
  }

  await listenOn(server, options.listen);
  const address = server.address();
  return {
    ...(typeof address === 'object' && address !== null ? { port: address.port } : {}),
    async close() {
      stopping = true;
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of connections.keys()) socket.close(HOST_CLOSE_CODES.unavailable, 'unavailable');
      server.closeIdleConnections();
      const grace = setTimeout(() => {
        for (const socket of connections.keys()) socket.terminate();
        server.closeAllConnections();
      }, CLOSE_GRACE_MS);
      await closed;
      clearTimeout(grace);
    },
  };
}

async function listenOn(server: ReturnType<typeof createServer>, listen: HostNetworkListenerOptions['listen']): Promise<void> {
  if ('socketPath' in listen) {
    await prepareUnixSocketEndpoint({ kind: process.platform === 'win32' ? 'pipe' : 'unix', path: listen.socketPath });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const listening = (): void => {
      server.off('error', reject);
      resolve();
    };
    if ('socketPath' in listen) server.listen(listen.socketPath, listening);
    else server.listen(listen.port, listen.hostname, listening);
  });
}
