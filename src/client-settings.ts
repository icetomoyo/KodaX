import type { ClientConfig, ClientEffectiveExecutionConfig, ClientSessionSettings } from '@kodax-ai/coding/client-contract';

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
  'maxOutputTokens', 'disablePromptCache', 'cacheWarming', 'lsp', 'lspAutoDownload', 'acpLogLevel',
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

/** One setting in effect as the Host reports it: where it comes from and whether it applies yet. */
interface EffectiveEntry {
  readonly present?: boolean;
  readonly applied?: boolean;
  readonly source?: string;
  readonly value?: unknown;
}

const asFlag = (value: unknown): boolean => value === true || value === '1';

/** The execution controls a client shows, from the settings the Host reports in effect. */
export function toClientEffectiveConfig({ entries, application }: {
  readonly entries: Readonly<Record<string, EffectiveEntry>>;
  readonly application?: Readonly<Record<string, string>>;
}): ClientEffectiveExecutionConfig {
  const project = <T>(key: string, value: T) => ({
    value,
    source: (entries[key]?.source ?? 'unset') as ClientEffectiveExecutionConfig['stallLog']['source'],
    applied: entries[key]?.applied === true || entries[key]?.present !== true,
  });
  const optional = (key: string, read: (value: unknown) => unknown) =>
    project(key, entries[key]?.value === undefined ? undefined : read(entries[key]!.value));
  const chain = entries.fallbackProviders?.value;
  return {
    ...(application === undefined ? {} : {
      application: application as NonNullable<ClientEffectiveExecutionConfig['application']>,
      maxOutputTokens: optional('maxOutputTokens', Number) as ClientEffectiveExecutionConfig['maxOutputTokens'],
      disablePromptCache: optional('disablePromptCache', asFlag) as ClientEffectiveExecutionConfig['disablePromptCache'],
      cacheWarming: optional('cacheWarming', String) as ClientEffectiveExecutionConfig['cacheWarming'],
      lsp: optional('lsp', asFlag) as ClientEffectiveExecutionConfig['lsp'],
    }),
    stallLog: project('stallLog', asFlag(entries.stallLog?.value)),
    fallbackProviders: project('fallbackProviders', typeof chain === 'string'
      ? chain.split(',').map(item => item.trim()).filter(Boolean)
      : Array.isArray(chain) ? chain.filter((item): item is string => typeof item === 'string') : []),
  };
}
