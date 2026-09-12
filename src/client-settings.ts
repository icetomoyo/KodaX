import type { ClientConfig, ClientSessionSettings } from '@kodax-ai/coding/client-contract';

/** Expose product choices without leaking the Host's execution or sandbox contract. */
export function toClientSessionSettings(settings: ClientSessionSettings): ClientSessionSettings {
  const {
    provider, model, effort, thinking, reasoningMode, permissionMode, agentMode,
    autoModeClassifierModel, compactionTriggerPercent, compactionTriggerTokens, maxIter,
    compactionReasoning, repoIntelligenceMode, repoIntelligenceTrace,
  } = settings;
  return {
    provider, model, effort, thinking, reasoningMode, permissionMode, agentMode,
    autoModeClassifierModel, compactionTriggerPercent, compactionTriggerTokens, maxIter,
    ...(compactionReasoning !== undefined ? { compactionReasoning } : {}),
    ...(repoIntelligenceMode !== undefined ? { repoIntelligenceMode } : {}),
    ...(repoIntelligenceTrace !== undefined ? { repoIntelligenceTrace } : {}),
  };
}

export const CLIENT_CONFIG_KEYS = [
  'provider', 'model', 'effort', 'planModeEffort', 'thinking', 'reasoningMode',
  'permissionMode', 'agentMode', 'locale', 'providerModels', 'extensions',
  'fallbackProviders', 'repoIntelligenceMode', 'repoIntelligenceTrace',
  'verifierLog', 'stallLog', 'fastProvider', 'fastModel', 'deepProvider', 'deepModel',
  'maxOutputTokens', 'disablePromptCache', 'lsp', 'lspAutoDownload', 'acpLogLevel',
  'sessionRetentionDays', 'repoIntelligence', 'workflow',
] as const satisfies readonly (keyof ClientConfig)[];

export function toClientConfig(config: unknown): ClientConfig {
  if (!config || typeof config !== 'object') return {};
  const values = config as ClientConfig;
  return Object.fromEntries(CLIENT_CONFIG_KEYS
    .filter((key) => values[key] !== undefined)
    .map((key) => [key, structuredClone(values[key])])) as ClientConfig;
}
