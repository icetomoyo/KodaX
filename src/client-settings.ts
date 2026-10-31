import type { ClientConfig, ClientSessionSettings } from '@kodax-ai/coding/client-contract';

/** Expose product choices without leaking the Host's execution or sandbox contract. */
export function toClientSessionSettings(settings: ClientSessionSettings): ClientSessionSettings {
  const {
    provider, model, effort, planModeEffort, thinking, reasoningMode, permissionMode, agentMode,
    autoModeClassifierModel, compactionTriggerPercent, compactionTriggerTokens, maxIter,
    compactionReasoning, repoIntelligenceMode, repoIntelligenceTrace, workMode,
  } = settings;
  return {
    provider, model, effort, thinking, reasoningMode, permissionMode, agentMode,
    ...(planModeEffort !== undefined ? { planModeEffort } : {}),
    autoModeClassifierModel, compactionTriggerPercent, compactionTriggerTokens, maxIter,
    ...(compactionReasoning !== undefined ? { compactionReasoning } : {}),
    ...(repoIntelligenceMode !== undefined ? { repoIntelligenceMode } : {}),
    ...(repoIntelligenceTrace !== undefined ? { repoIntelligenceTrace } : {}),
    ...(workMode !== undefined ? { workMode } : {}),
  };
}

export const CLIENT_CONFIG_KEYS = [
  'provider', 'model', 'effort', 'planModeEffort', 'thinking', 'reasoningMode',
  'permissionMode', 'agentMode', 'locale', 'providerModels', 'extensions',
  'fallbackProviders', 'repoIntelligenceMode', 'repoIntelligenceTrace',
  'stallLog', 'fastProvider', 'fastModel', 'deepProvider', 'deepModel',
  'maxOutputTokens', 'disablePromptCache', 'lsp', 'lspAutoDownload', 'acpLogLevel',
  'sessionRetentionDays', 'repoIntelligence', 'workflow',
] as const satisfies readonly (keyof ClientConfig)[];

export const CLIENT_CONFIG_APPLICATION = Object.fromEntries(CLIENT_CONFIG_KEYS.map(key => [key,
  ['fallbackProviders', 'stallLog'].includes(key) ? 'immediate'
    : key === 'extensions' ? 'extension_reload'
    : ['locale', 'providerModels', 'lspAutoDownload', 'acpLogLevel', 'sessionRetentionDays', 'repoIntelligence'].includes(key)
      ? 'restart' : 'next_run',
])) as NonNullable<import('@kodax-ai/coding/client-contract').ClientEffectiveExecutionConfig['application']>;

export function toClientConfig(config: unknown): ClientConfig {
  if (!config || typeof config !== 'object') return {};
  const values = config as ClientConfig;
  return Object.fromEntries(CLIENT_CONFIG_KEYS
    .filter((key) => values[key] !== undefined)
    .map((key) => [key, structuredClone(values[key])])) as ClientConfig;
}
