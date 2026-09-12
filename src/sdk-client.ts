/** Product SDK entry — @kodax-ai/kodax/client. */
import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import { connectKodaXRuntime, ensureKodaXRuntime } from './sdk-runtime.js';
import type { RuntimeClientInfo } from './runtime-client-info.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';

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
}

export interface EnsureKodaXClientOptions extends Omit<ConnectKodaXClientOptions, 'endpoint' | 'token'> {
  readonly daemonStartupTimeoutMs?: number;
}

/** Local launcher. All business operations use the same product Client as passive connections. */
export async function ensureKodaXClient(options: EnsureKodaXClientOptions = {}): Promise<KodaXProductClient> {
  return toKodaXProductClient(await ensureKodaXRuntime({ ...options, requirements: { productClient: 1 } }));
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
    requirements: { productClient: 1 },
  });
  return toKodaXProductClient(runtime);
}
