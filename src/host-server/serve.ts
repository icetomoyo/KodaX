/**
 * Starts what the `server` block of `host.json` asks for: a WebSocket listener
 * whose clients prove who they are with a JWT. The owner's subject connects as
 * `user`, a listed backend's as `service`, and nobody else gets in. The caller
 * builds the peer for each connection, so this module never loads the Host's
 * dispatcher and the dispatcher never loads this one.
 */
import { HostProtocolError } from '../host-protocol/codec.js';
import type { HostInitializeParams, HostLimits } from '../host-protocol/methods.js';
import type { HostCredential } from '../runtime-daemon/host-rpc.js';
import { createHostWorkspace, type HostWorkspace } from '../runtime-daemon/workspace.js';
import { readHostIntegration, type HostServerConfig } from './config.js';
import { createHostJwtVerifier, HostJwtError, type HostJwtVerifier } from './jwt.js';
import {
  startHostNetworkListener,
  type HostNetworkListener,
  type HostNetworkListenerOptions,
  type HostNetworkPeer,
  type HostNetworkTransport,
} from './listener.js';

/** A network socket the Host hears nothing on for this long is closed. Clients ping well inside it. */
const IDLE_TIMEOUT_MS = 60_000;

/** What every network connection shares: how to check its credential, its limits, and the workspace it may name projects in. */
export interface HostNetworkConnection {
  readonly authenticate: (auth: HostInitializeParams['auth']) => Promise<HostCredential>;
  readonly limits: HostLimits;
  readonly workspace?: HostWorkspace;
}

export interface HostNetworkServerOptions {
  /** The directory whose `integrations/host.json` holds the `server` block. */
  readonly configHome: string;
  readonly maxFrameBytes: number;
  readonly createPeer: (transport: HostNetworkTransport, connection: HostNetworkConnection) => HostNetworkPeer;
}

/** Starts the listener, or nothing when the config names no listen address. A config it cannot read stops the Host. */
export async function startHostNetworkServer(options: HostNetworkServerOptions): Promise<HostNetworkListener | undefined> {
  const server = readHostIntegration(options.configHome).document.server;
  // The config refuses `listen` without `jwt`; the second check only narrows the type.
  if (server?.listen === undefined || server.jwt === undefined) return undefined;
  const connection: HostNetworkConnection = {
    authenticate: createHostAuthenticator(server, createHostJwtVerifier(server.jwt)),
    limits: { maxFrameBytes: options.maxFrameBytes, idleTimeoutMs: IDLE_TIMEOUT_MS },
    ...(server.workspaceRoot !== undefined ? { workspace: createHostWorkspace(server.workspaceRoot) } : {}),
  };
  return startHostNetworkListener({
    listen: listenAddress(server.listen),
    allowedOrigins: server.allowedOrigins,
    maxFrameBytes: options.maxFrameBytes,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    createPeer: transport => options.createPeer(transport, connection),
  });
}

/** Checks a network client's JWT and decides its role from the subject. */
export function createHostAuthenticator(
  server: Pick<HostServerConfig, 'owner' | 'services'>,
  verifier: HostJwtVerifier,
): HostNetworkConnection['authenticate'] {
  return async (auth) => {
    if (auth.scheme !== 'jwt') {
      throw new HostProtocolError('unauthorized', 'This Host accepts a JWT only.', { reason: 'unsupported_auth_scheme' });
    }
    const jwt = await verifier.verify(auth.token).catch((error: unknown) => {
      if (!(error instanceof HostJwtError)) throw error;
      throw error.kind === 'unavailable'
        ? new HostProtocolError('unavailable', 'The Host cannot check credentials right now.', {
          reason: 'credential_check_unavailable', retryable: true, cause: error,
        })
        : new HostProtocolError('unauthorized', 'The credential is not good.', { reason: 'invalid_credential', cause: error });
    });
    const role = jwt.subject === server.owner ? 'user' : server.services.includes(jwt.subject) ? 'service' : undefined;
    if (role === undefined) {
      throw new HostProtocolError('unauthorized', 'This Host does not admit that subject.', { reason: 'subject_not_admitted' });
    }
    return { role, subject: jwt.subject, expiresAt: jwt.expiresAt };
  };
}

function listenAddress(listen: NonNullable<HostServerConfig['listen']>): HostNetworkListenerOptions['listen'] {
  if (listen.socketPath !== undefined) return { socketPath: listen.socketPath };
  // The config requires both when there is no socket path.
  return { hostname: listen.hostname ?? '', port: listen.port ?? 0 };
}
