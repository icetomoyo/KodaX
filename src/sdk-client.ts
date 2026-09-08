/** Product SDK entry — @kodax-ai/kodax/client. */
import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import { connectKodaXRuntime } from './sdk-runtime.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';

export type {
  KodaXProductClient,
  ClientSession,
  ClientSessionSummary,
  ClientSessionFilter,
  ClientCreateSessionInput,
  ClientSubmitInput,
  ClientInputAcceptance,
  ClientSessionSettings,
  ClientSessionSettingsPatch,
  ClientConfig,
  ClientMcpServerConfig,
  ClientMcpServerStatus,
  ClientMcpTool,
  ClientModelSelection,
  ClientCapabilityProbeResult,
  ClientProviderInfo,
  ClientModelCatalog,
  ClientInteraction,
  ClientInteractionResponse,
  ClientInteractionResult,
  ClientPermissionDecision,
  ClientHistoryPage,
  ClientHistoryReadOptions,
  ClientHistorySearchInput,
  ClientHistorySearchResult,
  ClientSessionGoal,
  ClientGoalCreateInput,
  ClientLineageSummary,
  ClientLineageEntry,
  ClientLineageLabelInput,
  ClientSessionForkInput,
  ClientSessionRecoverInput,
  ClientPermissionGrant,
  ClientPermissionGrants,
  ClientCommandInfo,
  ClientSkillInfo,
} from '@kodax-ai/coding/client-contract';

export interface ConnectKodaXClientOptions {
  /** Base directory containing .kodax, matching CLI --home. */
  readonly homeDir?: string;
  readonly profile?: string;
  /** Local socket or named pipe. Defaults to the selected profile's endpoint. */
  readonly endpoint?: string;
  /** Explicit Host token; otherwise read from the selected local profile. */
  readonly token?: string;
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
  });
  return toKodaXProductClient(runtime);
}
