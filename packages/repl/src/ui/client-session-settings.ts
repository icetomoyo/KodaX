import type { ClientSessionSettingsPatch } from '@kodax-ai/coding/client-contract';
import type { CurrentConfig } from '../commands/types.js';
import { resolveProviderReasoningRuntimeEffort } from '../common/utils.js';
import { canonicalizePermissionMode } from '../permission/types.js';

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
