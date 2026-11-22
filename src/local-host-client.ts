import { randomBytes, randomUUID } from 'node:crypto';

import type { ClientStartupProgress } from '@kodax-ai/coding/client-contract';

import { connectHostRpc, type HostRpcClient } from './host-protocol/client.js';
import { HostProtocolError } from './host-protocol/codec.js';
import { createKodaXHostClient, type KodaXHostClient, type KodaXHostClientOptions } from './host-protocol/host-client.js';
import { runtimeDaemonHostLink } from './runtime-daemon/host-link.js';
import { dialRuntimeDaemonHostRpc } from './runtime-daemon/transport.js';
import { ensureKodaXRuntime } from './sdk-runtime.js';

export interface EnsureKodaXHostClientOptions {
  readonly client: {
    readonly name: string;
    readonly version: string;
    /** Stable for one installed client, so its work is still its own after a restart. Without it each launch is a new client. */
    readonly instanceId?: string;
    /** Proves a returning client is the same instance. Give it together with `instanceId`. */
    readonly instanceSecret?: string;
  };
  /** Base directory containing .kodax, matching CLI --home. */
  readonly homeDir?: string;
  readonly daemonStartupTimeoutMs?: number;
  /**
   * A Host this client starts stops about 30 seconds after its last client
   * leaves, unless it still has work. Without it that Host keeps running. A
   * Host that is already running keeps its own policy.
   */
  readonly exitWhenIdle?: boolean;
  /** Local launcher stage changes. Work is not awaited; observer failures do not change the result. */
  readonly onStartupProgress?: (progress: ClientStartupProgress) => void | Promise<void>;
  /** Receives what no caller is otherwise told, such as a failed attempt to reconnect. */
  readonly onError?: (error: unknown) => void;
  /** See `KodaXHostClientOptions.recoveryLeases`. */
  readonly recoveryLeases?: KodaXHostClientOptions['recoveryLeases'];
}

/** Failures of the local launcher that a later attempt can get past: a Host that is starting, stopping or being replaced. */
const TRANSIENT_LAUNCH_CODES = new Set([
  'protocol_closed', 'transport_error', 'ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'ETIMEDOUT',
]);

/**
 * Starts the Host of this home when none runs, or replaces an idle older one,
 * and connects to it over the v2 protocol. The client starts the Host again
 * when it goes away.
 */
export async function ensureKodaXHostClient(options: EnsureKodaXHostClientOptions): Promise<KodaXHostClient<'local'>> {
  const client = {
    name: options.client.name,
    version: options.client.version,
    instanceId: options.client.instanceId ?? randomUUID(),
    instanceSecret: options.client.instanceSecret ?? randomBytes(32).toString('hex'),
  };
  return createKodaXHostClient<'local'>({
    open: signal => openLocalHost(options, client, signal),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    ...(options.recoveryLeases !== undefined ? { recoveryLeases: options.recoveryLeases } : {}),
  });
}

async function openLocalHost(
  options: EnsureKodaXHostClientOptions,
  client: Parameters<typeof connectHostRpc>[1]['client'],
  signal: AbortSignal,
): Promise<HostRpcClient> {
  let launcher: Awaited<ReturnType<typeof ensureKodaXRuntime>>;
  try {
    // The launcher connection is a separate, short-lived client, so it holds none of the work of the client it opens the Host for.
    launcher = await ensureKodaXRuntime({
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.daemonStartupTimeoutMs !== undefined ? { daemonStartupTimeoutMs: options.daemonStartupTimeoutMs } : {}),
      ...(options.onStartupProgress !== undefined ? { onStartupProgress: options.onStartupProgress } : {}),
      ...(options.exitWhenIdle === true ? { daemonLifecycle: 'interactive' as const } : {}),
      daemonStartupSignal: signal,
      clientInfo: { name: client.name, version: client.version },
    });
  } catch (error: unknown) {
    throw launchFailure(error);
  }
  try {
    const link = runtimeDaemonHostLink(launcher);
    if (link?.token === undefined) {
      throw new HostProtocolError('unavailable', 'The Host of this home published no local credential.', {
        reason: 'connect_failed', retryable: false,
      });
    }
    return await connectHostRpc(dialRuntimeDaemonHostRpc(link.endpoint), {
      client,
      auth: { scheme: 'ipc', token: link.token },
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
    });
  } finally {
    // Closed only once the v2 connection is up, so a Host started for this client does not see it leave and exit.
    await launcher.close().catch((error: unknown) => options.onError?.(error));
  }
}

function launchFailure(error: unknown): HostProtocolError {
  if (error instanceof HostProtocolError) return error;
  const fields = typeof error === 'object' && error !== null ? error as { code?: unknown; retryable?: unknown } : {};
  const transient = fields.retryable === true
    || (typeof fields.code === 'string' && TRANSIENT_LAUNCH_CODES.has(fields.code));
  return new HostProtocolError('unavailable', 'The local Host could not be started or reached.', {
    reason: 'connect_failed', retryable: transient, cause: error,
  });
}
