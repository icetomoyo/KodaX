import type { ClientConfig } from '@kodax-ai/coding/client-contract';
import type { KodaXOptions } from '@kodax-ai/coding';
import { inspectConfigEnvironmentSource, KODAX_CONFIG_ENV_BINDINGS } from '@kodax-ai/repl';

export const RUN_CONFIG_KEYS = ['maxOutputTokens', 'disablePromptCache', 'lsp',
  'fastProvider', 'fastModel', 'deepProvider', 'deepModel'] as const;

/** A removed saved default must not revive its obsolete CLI-bootstrap projection. */
export function clearRemovedExecutionConfig(config: ClientConfig): void {
  for (const key of RUN_CONFIG_KEYS) {
    const env = KODAX_CONFIG_ENV_BINDINGS.find(binding => binding.configPath === key)?.env;
    if (config[key] === undefined && env && inspectConfigEnvironmentSource(env) === 'persisted') delete process.env[env];
  }
}

/** Capture defaults for a new Run without mutating process-wide environment or active Runs. */
export function resolveExecutionConfig(config: ClientConfig): Pick<KodaXOptions,
  'maxOutputTokens' | 'disablePromptCache' | 'lsp' | 'modelTiers'> {
  const value = <K extends typeof RUN_CONFIG_KEYS[number]>(key: K): ClientConfig[K] | undefined => {
    const env = KODAX_CONFIG_ENV_BINDINGS.find(binding => binding.configPath === key)?.env;
    return env && inspectConfigEnvironmentSource(env) === 'environment' ? undefined : config[key];
  };
  const maxOutputTokens = value('maxOutputTokens');
  const disablePromptCache = value('disablePromptCache');
  const lsp = value('lsp');
  const fast = { provider: value('fastProvider'), model: value('fastModel') };
  const deep = { provider: value('deepProvider'), model: value('deepModel') };
  return {
    ...(typeof maxOutputTokens === 'number' && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
    ...(typeof disablePromptCache === 'boolean' ? { disablePromptCache } : {}),
    ...(typeof lsp === 'boolean' ? { lsp } : {}),
    ...(fast.provider || fast.model || deep.provider || deep.model ? { modelTiers: {
      ...(fast.provider || fast.model ? { fast } : {}), ...(deep.provider || deep.model ? { deep } : {}),
    } } : {}),
  };
}
