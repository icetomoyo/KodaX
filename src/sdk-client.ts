/** Product SDK entry — @kodax-ai/kodax/client. */
import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import { connectKodaXRuntime } from './sdk-runtime.js';
import { toClientConfig, toClientSessionSettings } from './client-settings.js';

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
  return {
    host: {
      shutdown: () => runtime.daemon.shutdown(),
    },
    sessions: {
      create: (input) => runtime.sessions.create(input),
      list: (filter) => runtime.sessions.list(filter),
      read: (sessionId) => runtime.sessions.load(sessionId),
      delete: (sessionId) => runtime.sessions.delete(sessionId),
      archive: (sessionId) => runtime.sessions.archive(sessionId),
      unarchive: (sessionId) => runtime.sessions.unarchive(sessionId),
      getSettings: async (sessionId) => toClientSessionSettings(await runtime.sessions.getSettings(sessionId)),
      updateSettings: async (sessionId, patch) => toClientSessionSettings(await runtime.sessions.updateSettings(sessionId, patch)),
      observe: (sessionId, onView) => runtime.sessions.observeView(sessionId, onView),
      readItem: (sessionId, itemId, options) => runtime.sessions.readViewItem(sessionId, itemId, options),
      readHistory: (sessionId, options) => runtime.sessions.readHistory(sessionId, options),
      readHistoryEntry: (sessionId, itemId, options) => runtime.sessions.readHistoryEntry(sessionId, itemId, options),
      searchHistory: (sessionId, input) => runtime.sessions.searchHistory(sessionId, input),
      readGoal: (sessionId) => runtime.sessions.readGoal(sessionId),
      createGoal: (sessionId, input) => runtime.sessions.createGoal({ sessionId, ...input }),
      pauseGoal: (sessionId) => runtime.sessions.pauseGoal(sessionId),
      resumeGoal: (sessionId) => runtime.sessions.resumeGoal(sessionId),
      clearGoal: (sessionId) => runtime.sessions.clearGoal(sessionId),
      appendNotice: async (sessionId, input) => {
        await runtime.sessions.appendNotice({ sessionId, ...input });
      },
    },
    inputs: {
      submit: (input) => runtime.runs.acceptInput(input),
      read: (sessionId, inputId) => runtime.runs.getInput(sessionId, inputId),
      withdraw: (sessionId, inputId) => runtime.runs.withdrawInput(sessionId, inputId),
    },
    runs: {
      read: (runId) => runtime.runs.get(runId),
      stop: (runId) => runtime.runs.abort(runId),
    },
    interactions: {
      list: (filter) => runtime.interactions.list(filter),
      respond: (requestId, response) => runtime.interactions.respond(requestId, response),
    },
    config: {
      read: async () => toClientConfig(await runtime.config.read()),
      patch: async (patch) => toClientConfig(await runtime.config.patch(patch)),
      reload: async () => ({ ok: true, config: toClientConfig((await runtime.config.reload()).config) }),
    },
    mcp: {
      listServers: () => runtime.mcp.listServers(),
      getServer: (name) => runtime.mcp.getServer(name),
      validateServer: (name, config) => runtime.mcp.validateServer(name, config),
      upsertServer: (name, config) => runtime.mcp.upsertServer(name, config),
      deleteServer: (name) => runtime.mcp.deleteServer(name),
      reloadServers: () => runtime.mcp.reloadServers(),
      listTools: (filter) => runtime.mcp.listTools(filter),
    },
    catalog: {
      providers: () => runtime.catalog.providers(),
      models: async (filter) => (await runtime.catalog.providers())
        .filter((provider) => filter?.provider === undefined || provider.name === filter.provider)
        .map((provider) => ({ provider: provider.name, models: provider.models })),
      reasoningEfforts: (input) => runtime.catalog.reasoningEfforts(input),
      probeReasoningEfforts: (input) => runtime.catalog.probeReasoningEfforts(input),
      forgetCapabilities: (input) => runtime.catalog.forgetCapabilities(input),
    },
    disconnect: () => runtime.close(),
  };
}
