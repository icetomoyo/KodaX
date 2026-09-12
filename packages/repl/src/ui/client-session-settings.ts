import type { ClientSessionSettingsPatch, ClientSessionView } from '@kodax-ai/coding/client-contract';
import type { CurrentConfig } from '../commands/types.js';
import { resolveProviderReasoningRuntimeEffort } from '../common/utils.js';
import { canonicalizePermissionMode } from '../permission/types.js';

/** Apply known Host selections to display state, without resolving local defaults. */
export function applyClientSessionViewSettings(
  config: CurrentConfig,
  view: Pick<ClientSessionView, 'settings' | 'contextBudget'>,
  locallyConfirmed: ClientSessionSettingsPatch = {},
): CurrentConfig {
  const { settings, contextBudget } = view;
  const hostSettings = { ...settings, ...Object.fromEntries(Object.entries(locallyConfirmed).map(([key, value]) => [key, value ?? undefined])) };
  const provider = settings.provider ?? contextBudget?.provider;
  const known = Object.fromEntries(Object.entries({
    provider,
    model: settings.model ?? contextBudget?.model,
    effort: settings.effort,
    effortOverride: settings.effort !== undefined,
    thinking: settings.thinking,
    reasoningMode: settings.reasoningMode,
    agentMode: settings.agentMode,
    permissionMode: settings.permissionMode,
  }).filter(([key, value]) => (value !== undefined || key === 'effort'
    || (key === 'model' && provider !== undefined && provider !== config.provider))
    && !Object.hasOwn(locallyConfirmed, key === 'effortOverride' ? 'effort' : key)));
  if (Object.entries(known).every(([key, value]) => Object.is(config[key as keyof CurrentConfig], value))
    && JSON.stringify(config.hostSettings) === JSON.stringify(hostSettings)) return config;
  return { ...config, ...known, hostSettings };
}

/** Keep startup, commands, and keyboard selections on the same Host settings face. */
export function clientSessionSettings(
  config: CurrentConfig,
  maxIter?: number,
): ClientSessionSettingsPatch {
  return {
    provider: config.provider,
    model: config.model ?? null,
    effort: resolveProviderReasoningRuntimeEffort(config).runtimeEffort ?? null,
    thinking: config.thinking,
    reasoningMode: config.reasoningMode,
    agentMode: config.agentMode,
    permissionMode: canonicalizePermissionMode(config.permissionMode),
    maxIter: maxIter ?? null,
  };
}

/** A local selection must not overwrite unrelated changes made by another client. */
export function changedClientSessionSettings(
  previous: ClientSessionSettingsPatch,
  next: ClientSessionSettingsPatch,
  explicit: readonly (keyof ClientSessionSettingsPatch)[] = [],
): ClientSessionSettingsPatch {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) =>
    explicit.includes(key as keyof ClientSessionSettingsPatch)
    || !Object.is(previous[key as keyof ClientSessionSettingsPatch], value)));
}
