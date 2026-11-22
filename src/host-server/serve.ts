/**
 * Starts what the `server` block of `host.json` asks for: a WebSocket listener
 * whose clients prove who they are with a JWT or a paired device's cookie. The
 * owner's subject connects as `user`, a listed backend's as `service`, a
 * paired browser as `user`, and nobody else gets in. The same port serves the
 * pairing endpoint and the pages in `webRoot`. The caller
 * builds the peer for each connection, so this module never loads the Host's
 * dispatcher and the dispatcher never loads this one.
 *
 * Who is admitted follows the file while the Host runs. A connection the new
 * file would not admit is closed: as `revoked` when its subject or origin was
 * dropped or pairing was turned off, as `credential` when the JWT check itself
 * changed, so the client fetches a token the new check accepts. Where to
 * listen, the workspace and the web root take effect when the Host restarts.
 */
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { IntegrationConfigController, type IntegrationConfigStatus } from '@kodax-ai/repl';

import type { HostCloseReason } from '../host-protocol/close.js';
import { HostProtocolError } from '../host-protocol/codec.js';
import type { HostInitializeParams, HostLimits } from '../host-protocol/methods.js';
import type { HostCredential } from '../runtime-daemon/host-rpc.js';
import { reportHostSecurityEvent } from '../runtime-daemon/security-log.js';
import { createHostWorkspace, type HostWorkspace } from '../runtime-daemon/workspace.js';
import { parseHostIntegrationDocument, readHostIntegration, type HostIntegrationDocument, type HostServerConfig } from './config.js';
import { openHostDeviceRegistry, type HostDeviceRegistry } from './devices.js';
import { createHostJwtVerifier, HostJwtError, type HostJwtVerifier } from './jwt.js';
import {
  startHostNetworkListener,
  type HostHealth,
  type HostNetworkListener,
  type HostNetworkListenerOptions,
  type HostNetworkPeer,
  type HostNetworkTransport,
} from './listener.js';
import { createHostWebHandler, deviceCookie, readDeviceCookie } from './web.js';

/** A network socket the Host hears nothing on for this long is closed. Clients ping well inside it. */
const IDLE_TIMEOUT_MS = 60_000;
/** Fields read once when the Host starts. */
const RESTART_FIELDS = ['listen', 'workspaceRoot', 'webRoot'] as const;

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
  readonly health: () => Promise<HostHealth>;
  readonly createPeer: (transport: HostNetworkTransport, connection: HostNetworkConnection) => HostNetworkPeer;
}

export interface HostNetworkServer extends HostNetworkListener {
  /** The `host` integration domain: the revision of `host.json` in force, and why the last edit did not apply. */
  status(): IntegrationConfigStatus;
  /**
   * The browsers paired with this Host, kept in `<configHome>/runtime/devices.json`. `pair` throws
   * `invalid_state` while pairing is off; revoking a device closes its connections as `revoked`.
   */
  readonly devices: HostDeviceRegistry;
}

/** Who may get in under one revision of the file. */
interface Admission {
  readonly server: HostServerConfig | undefined;
  readonly verifier: HostJwtVerifier | undefined;
  readonly authenticate: HostNetworkConnection['authenticate'];
}

interface TrackedConnection {
  readonly transport: HostNetworkTransport;
  readonly origin?: string;
  /** The paired device it is, admitted by its cookie. */
  readonly device?: string;
  /** The credential it was last admitted or renewed with. */
  credential?: HostCredential;
}

/** Starts the listener, or nothing when the config names no listen address. A config it cannot read stops the Host. */
export async function startHostNetworkServer(options: HostNetworkServerOptions): Promise<HostNetworkServer | undefined> {
  // Read directly first, so a file that stops the Host names what is wrong with it.
  const served = readHostIntegration(options.configHome).document.server;
  // The config refuses `listen` with neither; the second check only narrows the type.
  if (served?.listen === undefined || (served.jwt === undefined && served.pairing !== true)) return undefined;
  const controller = new IntegrationConfigController<HostIntegrationDocument>({
    domain: 'host',
    configHome: options.configHome,
    validate: parseHostIntegrationDocument,
    read: () => readReportingErrors(options.configHome),
  });
  let admission = admit((await controller.initialize()).document.server, undefined);
  const connections = new Set<TrackedConnection>();
  const devices = openHostDeviceRegistry({ file: path.join(options.configHome, 'runtime', 'devices.json') });
  devices.onRevoke((id) => {
    for (const connection of connections) if (connection.device === id) connection.transport.disconnect('revoked');
  });
  /** Bumped by every applied edit, so a check that started under the previous one runs again. */
  let generation = 0;

  controller.subscribe((snapshot) => {
    const next = snapshot.document.server;
    const restart = RESTART_FIELDS.filter(field => !isDeepStrictEqual(served[field], next?.[field]));
    if (restart.length > 0) {
      emitKodaXDiagnostic({
        source: 'host.network', level: 'warn',
        message: 'host.json changed settings that take effect when the Host restarts.', detail: { fields: restart },
      });
    }
    const jwtChanged = !isDeepStrictEqual(admission.server?.jwt, next?.jwt);
    admission = admit(next, jwtChanged ? undefined : admission.verifier);
    generation += 1;
    for (const connection of connections) {
      const reason = recheck(connection, next, jwtChanged);
      if (reason !== undefined) connection.transport.disconnect(reason);
    }
  });
  controller.startWatching();

  const shared = {
    limits: { maxFrameBytes: options.maxFrameBytes, idleTimeoutMs: IDLE_TIMEOUT_MS },
    ...(served.workspaceRoot !== undefined ? { workspace: createHostWorkspace(served.workspaceRoot) } : {}),
  };
  const pairing = (): HostDeviceRegistry | undefined => (admission.server?.pairing === true ? devices : undefined);
  let listener: HostNetworkListener;
  try {
    listener = await startHostNetworkListener({
      listen: listenAddress(served.listen),
      allowsOrigin: (origin) => {
        const allowed = admission.server?.allowedOrigins.includes(origin) === true;
        if (!allowed) reportHostSecurityEvent({ event: 'auth_failed', reason: 'origin_not_allowed', origin });
        return allowed;
      },
      admitsDevice: ({ origin, cookie }) => {
        const token = readDeviceCookie(cookie);
        const device = token !== undefined ? pairing()?.admit(token, origin) : undefined;
        return device !== undefined ? { device: device.id, setCookie: deviceCookie(token!, origin) } : undefined;
      },
      serveHttp: createHostWebHandler({ ...(served.webRoot !== undefined ? { webRoot: served.webRoot } : {}), devices: pairing }),
      maxFrameBytes: options.maxFrameBytes,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      // A Host that pairs browsers is reached through a tunnel, which shows this port to anyone; no
      // platform reads its blockers there, and they would tell a stranger when its owner is at work.
      health: async () => {
        const health = await options.health();
        return pairing() === undefined ? health : { state: health.state };
      },
      createPeer: (transport, request) => {
        const tracked: TrackedConnection = { transport, ...request };
        connections.add(tracked);
        const peer = options.createPeer(transport, {
          ...shared,
          authenticate: async (auth) => {
            // Its cookie already proved who it is.
            if (tracked.device !== undefined) {
              tracked.credential = { role: 'user', subject: tracked.device };
              return tracked.credential;
            }
            for (;;) {
              const seen = generation;
              const credential = await admission.authenticate(auth).catch((error: unknown) => {
                reportRefusal(error, tracked.origin);
                throw error;
              });
              if (seen !== generation) continue;
              tracked.credential = credential;
              return credential;
            }
          },
        });
        return {
          receive: frame => peer.receive(frame),
          drained: () => peer.drained?.(),
          draining: () => peer.draining?.(),
          admitted: () => peer.admitted(),
          close: () => {
            connections.delete(tracked);
            peer.close();
          },
        };
      },
    });
  } catch (error: unknown) {
    controller.close();
    throw error;
  }
  return {
    ...(listener.port !== undefined ? { port: listener.port } : {}),
    drain: () => listener.drain(),
    status: () => controller.status(),
    devices: {
      ...devices,
      pair(request) {
        if (pairing() === undefined) {
          throw new HostProtocolError('invalid_state', 'Pairing is off on this Host: set server.pairing in host.json.', { reason: 'pairing_off' });
        }
        return devices.pair(request);
      },
    },
    async close() {
      controller.close();
      await listener.close();
    },
  };
}

/** Checks a network client's JWT and decides its role from the subject. */
export function createHostAuthenticator(
  server: Pick<HostServerConfig, 'owner' | 'services'>,
  verifier: HostJwtVerifier,
): HostNetworkConnection['authenticate'] {
  return async (auth) => {
    if (auth?.scheme !== 'jwt') {
      throw new HostProtocolError('unauthorized', 'This Host accepts a JWT or a paired device only.', { reason: 'unsupported_auth_scheme' });
    }
    const jwt = await verifier.verify(auth.token).catch((error: unknown) => {
      if (!(error instanceof HostJwtError)) throw error;
      throw error.kind === 'unavailable'
        ? new HostProtocolError('unavailable', 'The Host cannot check credentials right now.', {
          reason: 'credential_check_unavailable', retryable: true, cause: error,
        })
        : new HostProtocolError('unauthorized', 'The credential is not good.', { reason: 'invalid_credential', cause: error });
    });
    const role = roleOf(server, jwt.subject);
    if (role === undefined) throw notAdmitted();
    return { role, subject: jwt.subject, expiresAt: jwt.expiresAt };
  };
}

function admit(server: HostServerConfig | undefined, verifier: HostJwtVerifier | undefined): Admission {
  // Without a JWT check, which only a file that stops listening can say, the Host admits nobody until it restarts.
  if (server?.jwt === undefined) return { server, verifier: undefined, authenticate: async () => { throw notAdmitted(); } };
  const current = verifier ?? createHostJwtVerifier(server.jwt);
  return { server, verifier: current, authenticate: createHostAuthenticator(server, current) };
}

/** Why a connection must close under the new file, or undefined when it may stay. */
function recheck(connection: TrackedConnection, next: HostServerConfig | undefined, jwtChanged: boolean): HostCloseReason | undefined {
  if (connection.device !== undefined) return next?.pairing === true ? undefined : 'revoked';
  if (connection.origin !== undefined && next?.allowedOrigins.includes(connection.origin) !== true) return 'revoked';
  // One still in its handshake is checked under the new file when its check ends.
  if (connection.credential === undefined) return undefined;
  if (next?.jwt === undefined || roleOf(next, connection.credential.subject) !== connection.credential.role) return 'revoked';
  return jwtChanged ? 'credential' : undefined;
}

function roleOf(server: Pick<HostServerConfig, 'owner' | 'services'>, subject: string): HostCredential['role'] | undefined {
  if (subject === server.owner) return 'user';
  return server.services.includes(subject) ? 'service' : undefined;
}

/** A refused credential is a security event; a check the Host could not make is not a refusal. */
function reportRefusal(error: unknown, origin: string | undefined): void {
  if (!(error instanceof HostProtocolError) || error.kodaxCode !== 'unauthorized') return;
  reportHostSecurityEvent({ event: 'auth_failed', reason: error.reason ?? 'unauthorized', ...(origin !== undefined ? { origin } : {}) });
}

function notAdmitted(): HostProtocolError {
  return new HostProtocolError('unauthorized', 'This Host does not admit that subject.', { reason: 'subject_not_admitted' });
}

/** The controller keeps only a generic diagnostic, so the log gets what is wrong with the file. */
function readReportingErrors(configHome: string): ReturnType<typeof readHostIntegration> {
  try {
    return readHostIntegration(configHome);
  } catch (error: unknown) {
    emitKodaXDiagnostic({
      source: 'host.network', level: 'warn', message: 'host.json was not applied; the previous settings stay in force.',
      detail: { error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

function listenAddress(listen: NonNullable<HostServerConfig['listen']>): HostNetworkListenerOptions['listen'] {
  if (listen.socketPath !== undefined) return { socketPath: listen.socketPath };
  // The config requires both when there is no socket path.
  return { hostname: listen.hostname ?? '', port: listen.port ?? 0 };
}
