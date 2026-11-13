/** Product SDK entry — @kodax-ai/kodax/client. */
import type { ClientStartupProgress, KodaXProductClient } from '@kodax-ai/coding/client-contract';
import type { RuntimeCapabilityRequirements } from '@kodax-ai/coding/client-contract';
export { KODAX_RUNTIME_SDK_CAPABILITIES, supportsRuntimeCapability } from '@kodax-ai/coding/client-contract';
import { connectKodaXRuntime, rejectRemovedHostProfile } from './sdk-runtime.js';
import { ensureRecoveringKodaXRuntime } from './recovering-runtime-client.js';
import type { RuntimeClientInfo } from './runtime-client-info.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import type { KodaXClientHostAuthorization } from './client-host-authorization.js';
import type { ClientExitReceipt } from '@kodax-ai/coding/client-contract';
import path from 'node:path';
import { KODAX_DIR } from '@kodax-ai/repl';
import { listRuntimeDaemonSlots, resolveRuntimeDaemonPathsFromConfigHome } from './runtime-daemon/state.js';
import { runtimeClientPrincipal, readExitReceipts, verifyExitReceipt } from './runtime-daemon/client-lifecycle.js';
export type { KodaXClientHostAuthorization, KodaXClientHostServices, KodaXClientExecutionRequest, RuntimeExecutionAuthorization, KodaXClientWorkflowHostPolicy } from './client-host-authorization.js';

export type * from '@kodax-ai/coding/client-contract';
export { createExecutionProfile } from './execution-profile.js';
export type { RuntimeExecutionProfile, RuntimeExecutionProfileSource, RuntimeDefaultSkill,
  RuntimeBusinessBinding, RuntimeExecutionBindingSnapshot, RuntimeExecutionBindingRequest,
  RuntimeExecutionBindingResolver, RuntimeExecutionBindingService } from './client-host-authorization.js';
export type { RuntimeClientInfo } from './runtime-client-info.js';

export interface ConnectKodaXClientOptions {
  /** Optional features; ensure upgrades an idle Host while connect stays passive. */
  readonly requirements?: RuntimeCapabilityRequirements;
  /** Local launcher stage changes. Work is not awaited; observer failures do not change the result. */
  readonly onStartupProgress?: (progress: ClientStartupProgress) => void | Promise<void>;
  /** Base directory containing .kodax, matching CLI --home. */
  readonly homeDir?: string;
  /** Local socket or named pipe. Defaults to the Host endpoint of this home. */
  readonly endpoint?: string;
  /** Explicit Host token; otherwise read from the Host of this home. */
  readonly token?: string;
  readonly clientInfo?: RuntimeClientInfo;
  /** Trusted Main only. Select lease capabilities outside Renderer/IPC inputs; callbacks stay local. */
  readonly authorizeExecution?: KodaXClientHostAuthorization;
}

export interface EnsureKodaXClientOptions extends Omit<ConnectKodaXClientOptions, 'endpoint' | 'token'> {
  readonly daemonStartupTimeoutMs?: number;
  /** Deadline for ordinary questions on a newly started Host; 0 (default) waits indefinitely. */
  readonly userInputTimeoutMs?: number;
}

/** Offline recovery query. Does not connect, start a Host, replay work, or clean Space resources. */
export async function readKodaXClientExits(options: {
  readonly homeDir?: string; readonly clientInfo: RuntimeClientInfo;
}): Promise<readonly ClientExitReceipt[]> {
  rejectRemovedHostProfile('readKodaXClientExits', options);
  const { instanceId, instanceSecret } = options.clientInfo;
  if (!instanceId || !/^[A-Za-z0-9_.:-]{4,160}$/.test(instanceId) || !instanceSecret
    || instanceSecret.length < 32 || instanceSecret.length > 512) throw new Error('Exit recovery requires the original stable client identity and secret.');
  const configHome = options.homeDir === undefined ? KODAX_DIR : path.resolve(options.homeDir, '.kodax');
  const principal = runtimeClientPrincipal(instanceId, instanceSecret);
  const verified: ClientExitReceipt[] = [];
  // A legacy-slot Host that served this client recorded its exits in its own slot (ADR-075).
  for (const slot of listRuntimeDaemonSlots(configHome)) {
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, slot);
    // Historical exits can require OS probes. Keep one probe chain in flight so
    // a large history cannot launch a burst of native inspection processes.
    for (const receipt of readExitReceipts(paths, principal)) verified.push(await verifyExitReceipt(paths, receipt));
  }
  return verified;
}

/** Local launcher. All business operations use the same product Client as passive connections. */
export async function ensureKodaXClient(options: EnsureKodaXClientOptions = {}): Promise<KodaXProductClient> {
  rejectRemovedHostProfile('ensureKodaXClient', options);
  return toKodaXProductClient(await ensureRecoveringKodaXRuntime({ ...options, requirements: {
    ...options.requirements,
    productClient: 1, productHistoryBoundaries: 1, productExitControl: 1, productExecutionFacts: 1, productInputRecovery: 1,
    ...(options.authorizeExecution ? { productExecutionAuthorization: 2, productActorAuthorization: 1, providerProbeAuthorization: 1 } : {}),
  } }, options.authorizeExecution), options.authorizeExecution);
}

/** Connect to an existing compatible Host without starting or replacing one. */
export async function connectKodaXClient(
  options: ConnectKodaXClientOptions = {},
): Promise<KodaXProductClient> {
  rejectRemovedHostProfile('connectKodaXClient', options);
  const runtime = await connectKodaXRuntime({
    homeDir: options.homeDir,
    endpoint: options.endpoint,
    daemonToken: options.token,
    autoStart: false,
    onStartupProgress: options.onStartupProgress,
    clientInfo: options.clientInfo,
    requirements: { ...options.requirements, productClient: 1, productHistoryBoundaries: 1, productExitControl: 1, productExecutionFacts: 1, productInputRecovery: 1,
      ...(options.authorizeExecution ? { productExecutionAuthorization: 2, productActorAuthorization: 1, providerProbeAuthorization: 1 } : {}) },
  });
  return toKodaXProductClient(runtime, options.authorizeExecution);
}
