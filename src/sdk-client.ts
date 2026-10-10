/** Product SDK entry — @kodax-ai/kodax/client. */
import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import { connectKodaXRuntime, ensureKodaXRuntime } from './sdk-runtime.js';
import type { RuntimeClientInfo } from './runtime-client-info.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import type { KodaXClientHostAuthorization } from './client-host-authorization.js';
import type { ClientExitReceipt } from '@kodax-ai/coding/client-contract';
import path from 'node:path';
import { KODAX_DIR } from '@kodax-ai/repl';
import { resolveRuntimeDaemonPathsFromConfigHome } from './runtime-daemon/state.js';
import { runtimeClientPrincipal, readExitReceipts, verifyExitReceipt } from './runtime-daemon/client-lifecycle.js';
export type { KodaXClientHostAuthorization, KodaXClientExecutionRequest, RuntimeExecutionAuthorization, KodaXClientWorkflowHostPolicy } from './client-host-authorization.js';

export type * from '@kodax-ai/coding/client-contract';
export type { RuntimeClientInfo } from './runtime-client-info.js';

export interface ConnectKodaXClientOptions {
  /** Base directory containing .kodax, matching CLI --home. */
  readonly homeDir?: string;
  readonly profile?: string;
  /** Local socket or named pipe. Defaults to the selected profile's endpoint. */
  readonly endpoint?: string;
  /** Explicit Host token; otherwise read from the selected local profile. */
  readonly token?: string;
  readonly clientInfo?: RuntimeClientInfo;
  /** Trusted Main only. Select lease capabilities outside Renderer/IPC inputs; callbacks stay local. */
  readonly authorizeExecution?: KodaXClientHostAuthorization;
}

export interface EnsureKodaXClientOptions extends Omit<ConnectKodaXClientOptions, 'endpoint' | 'token'> {
  readonly daemonStartupTimeoutMs?: number;
}

/** Offline recovery query. Does not connect, start a Host, replay work, or clean Space resources. */
export async function readKodaXClientExits(options: {
  readonly homeDir?: string; readonly profile?: string; readonly clientInfo: RuntimeClientInfo;
}): Promise<readonly ClientExitReceipt[]> {
  const { instanceId, instanceSecret } = options.clientInfo;
  if (!instanceId || !/^[A-Za-z0-9_.:-]{4,160}$/.test(instanceId) || !instanceSecret
    || instanceSecret.length < 32 || instanceSecret.length > 512) throw new Error('Exit recovery requires the original stable client identity and secret.');
  const paths = resolveRuntimeDaemonPathsFromConfigHome(options.homeDir === undefined ? KODAX_DIR : path.resolve(options.homeDir, '.kodax'), options.profile);
  return Promise.all(readExitReceipts(paths, runtimeClientPrincipal(instanceId, instanceSecret)).map(receipt => verifyExitReceipt(paths, receipt)));
}

/** Local launcher. All business operations use the same product Client as passive connections. */
export async function ensureKodaXClient(options: EnsureKodaXClientOptions = {}): Promise<KodaXProductClient> {
  return toKodaXProductClient(await ensureKodaXRuntime({ ...options, requirements: {
    productClient: 1, productHistoryBoundaries: 1, productExitControl: 1, productExecutionFacts: 1,
    ...(options.authorizeExecution ? { productExecutionAuthorization: 2, productActorAuthorization: 1 } : {}),
  } }), options.authorizeExecution);
}

/** Connect to an existing compatible Host without starting or replacing one. */
export async function connectKodaXClient(
  options: ConnectKodaXClientOptions = {},
): Promise<KodaXProductClient> {
  const runtime = await connectKodaXRuntime({
    homeDir: options.homeDir,
    profile: options.profile,
    endpoint: options.endpoint,
    daemonToken: options.token,
    autoStart: false,
    clientInfo: options.clientInfo,
    requirements: { productClient: 1, productHistoryBoundaries: 1, productExitControl: 1, productExecutionFacts: 1,
      ...(options.authorizeExecution ? { productExecutionAuthorization: 2, productActorAuthorization: 1 } : {}) },
  });
  return toKodaXProductClient(runtime, options.authorizeExecution);
}
