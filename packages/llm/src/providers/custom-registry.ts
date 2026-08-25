/**
 * Custom Provider Registry
 *
 * In-memory registry for user-defined providers from config.json.
 * Custom providers are separate from built-in providers to avoid
 * modifying the closed ProviderName union.
 */

import type {
  KodaXCustomProviderConfig,
  KodaXModelDescriptor,
  KodaXVerifyStrategy,
} from '../types.js';
import type { KodaXBaseProvider } from './base.js';
import {
  createCustomProvider,
  legacyCapabilityFromReasoningProfile,
  mergeCapabilityProfileWithImageInput,
  resolveCustomModelReasoningProfile,
  resolveCustomProviderReasoningProfile,
  validateCustomProviderConfig,
} from './custom-provider.js';
import {
  KODAX_PROVIDERS,
  type KodaXModelCapabilities,
} from './registry.js';
import {
  cloneCapabilityProfile,
  NATIVE_PROVIDER_CAPABILITY_PROFILE,
} from './capability-profile.js';

type CustomProviderFactory = () => KodaXBaseProvider;

const customProviders = new Map<string, KodaXCustomProviderConfig>();
const customFactories = new Map<string, CustomProviderFactory>();

const THINKING_REASONING_CAPABILITIES = new Set([
  'native-toggle',
  'native-budget',
  'native-effort',
  'native-adaptive',
]);

/**
 * F2 — non-fatal config guidance for a genuinely-contradictory reasoning config:
 * `supportsThinking: false` is the master off-switch — it forces the resolved profile,
 * the capability, and the runtime to no-thinking, overriding ANY reasoning config
 * (reasoningCapability / reasoningProfile / reasoning / reasoningPreset). So a config
 * that supplies a thinking config AND disables thinking is almost certainly a mistake;
 * warn that the reasoning config is ignored. We deliberately do NOT warn on a bare
 * `supportsThinking: true` with no explicit reasoning mapping — that resolves to a
 * sensible default (passive on openai-compat, enable-toggle on anthropic-compat) and is
 * a valid, common config; warning on it would be noise. An explicit `none` reasoning
 * config agrees with supportsThinking:false, so it is not flagged.
 */
/** True when a config/descriptor carries a reasoning config that intends thinking. */
function hasThinkingReasoningConfig(fields: {
  readonly reasoningCapability?: string;
  readonly reasoningProfile?: unknown;
  readonly reasoningPreset?: string;
  readonly reasoning?: unknown;
}): boolean {
  return (
    (fields.reasoningCapability !== undefined &&
      THINKING_REASONING_CAPABILITIES.has(fields.reasoningCapability)) ||
    fields.reasoningProfile !== undefined ||
    (fields.reasoningPreset !== undefined && fields.reasoningPreset !== 'none') ||
    (fields.reasoning !== undefined && fields.reasoning !== 'none')
  );
}

function warnOnIgnoredReasoningCapability(config: KodaXCustomProviderConfig): void {
  if (config.supportsThinking !== false) return;
  const providerHasThinking = hasThinkingReasoningConfig(config);
  const modelHasThinking = (config.models ?? []).some(
    (entry) => typeof entry !== 'string' && hasThinkingReasoningConfig(entry),
  );
  if (providerHasThinking || modelHasThinking) {
    console.warn(
      `[kodax] Custom provider "${config.name}": its reasoning config (provider- or per-model reasoningCapability / reasoningProfile / reasoning / reasoningPreset) is ignored because supportsThinking is false (thinking stays off). Set supportsThinking: true to enable thinking, or remove the reasoning config.`,
    );
  }
}

/**
 * Register custom providers from config. Replaces all existing custom providers.
 */
export function registerCustomProviders(configs: KodaXCustomProviderConfig[]): void {
  const seen = new Set<string>();
  const nextProviders = new Map<string, KodaXCustomProviderConfig>();
  const nextFactories = new Map<string, CustomProviderFactory>();
  for (const config of configs) {
    validateCustomProviderConfig(config);
    if (seen.has(config.name)) {
      throw new Error(`Duplicate custom provider name: "${config.name}". Each custom provider must have a unique name.`);
    }
    if (config.name in KODAX_PROVIDERS) {
      console.warn(`[kodax] Custom provider "${config.name}" shadows a built-in provider. The built-in provider will be used. Choose a different name to use your custom provider.`);
    }
    warnOnIgnoredReasoningCapability(config);
    seen.add(config.name);
    nextProviders.set(config.name, config);
    nextFactories.set(config.name, () => createCustomProvider(config));
  }

  customProviders.clear();
  customFactories.clear();
  for (const [name, config] of nextProviders) {
    customProviders.set(name, config);
  }
  for (const [name, factory] of nextFactories) {
    customFactories.set(name, factory);
  }
}

/**
 * Get a custom provider instance by name.
 * Returns undefined if not found in custom registry.
 * Note: This will throw if the provider's API key env var is not set.
 */
export function getCustomProvider(name: string): KodaXBaseProvider | undefined {
  const factory = customFactories.get(name);
  return factory ? factory() : undefined;
}

/**
 * Effective capability profile for a custom provider, read from the stored
 * config WITHOUT instantiation — so no API key is required (v0.7.43
 * keyless-query convention). Applies the same `imageInput` merge rule as
 * `createCustomProvider`, keeping the keyless surface consistent with the
 * runtime. Exact name match wins, then a case-insensitive fallback (callers
 * such as the media capability layer may pass differently-cased names).
 * Returns undefined when the name is not a registered custom provider.
 */
export function getCustomProviderCapabilityProfile(
  name: string,
): import('../types.js').KodaXProviderCapabilityProfile | undefined {
  const config = customProviders.get(name)
    ?? [...customProviders.entries()].find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    )?.[1];
  if (!config) return undefined;
  return cloneCapabilityProfile(
    mergeCapabilityProfileWithImageInput(
      config.capabilityProfile,
      config.imageInput,
    ) ?? NATIVE_PROVIDER_CAPABILITY_PROFILE,
  );
}

/**
 * Check if a name refers to a custom provider.
 */
export function isCustomProviderName(name: string): boolean {
  return customProviders.has(name);
}

/**
 * Get all custom provider names without instantiation.
 */
export function getCustomProviderNames(): string[] {
  return [...customProviders.keys()];
}

/**
 * Get display info for all registered custom providers.
 * Reads metadata from stored config without instantiating providers,
 * so it won't throw for unconfigured providers.
 */
export function getCustomProviderList(): Array<{
  name: string;
  model: string;
  models: string[];
  configured: boolean;
  reasoningCapability: string;
  capabilityProfile: import('../types.js').KodaXProviderCapabilityProfile;
  custom: true;
}> {
  const result: Array<{
    name: string;
    model: string;
    models: string[];
    configured: boolean;
    reasoningCapability: string;
    capabilityProfile: import('../types.js').KodaXProviderCapabilityProfile;
    custom: true;
  }> = [];
  for (const [name, config] of customProviders) {
    const configured = !!process.env[config.apiKeyEnv];
    const reasoningProfile = resolveCustomProviderReasoningProfile(config);
    const modelIds = (config.models ?? []).map(entry =>
      typeof entry === 'string' ? entry : entry.id,
    );
    const models = config.model && modelIds.length
      ? [...new Set([config.model, ...modelIds])]
      : [config.model];
    result.push({
      name,
      model: config.model,
      models,
      configured,
      // supportsThinking:false ignores any configured capability at runtime (reasoning
      // resolves to 'none'); report 'none' so the list matches getCustomModelCapabilities
      // and the runtime instead of advertising a phantom tunable capability.
      reasoningCapability: config.supportsThinking === false
        ? 'none'
        : (config.reasoningCapability
            ?? legacyCapabilityFromReasoningProfile(reasoningProfile)
            ?? 'none'),
      capabilityProfile: cloneCapabilityProfile(
        mergeCapabilityProfileWithImageInput(
          config.capabilityProfile,
          config.imageInput,
        ) ?? NATIVE_PROVIDER_CAPABILITY_PROFILE,
      ),
      custom: true,
    });
  }
  return result;
}

/**
 * Get available model IDs for a custom provider.
 * Reads from stored config without instantiation.
 * Returns undefined if not a custom provider.
 */
export function getCustomProviderModels(name: string): string[] | undefined {
  const config = customProviders.get(name);
  if (!config) return undefined;
  const modelIds = (config.models ?? []).map(entry =>
    typeof entry === 'string' ? entry : entry.id,
  );
  return config.model && modelIds.length
    ? [...new Set([config.model, ...modelIds])]
    : [config.model];
}

// ============== SDK Model Capability Exposure for Custom Providers (v0.7.43) ==============
//
// Mirrors the built-in counterparts in `registry.ts` but reads from the
// in-memory `customProviders` map populated by
// `registerConfiguredCustomProviders` at startup (from `~/.kodax/config.json`).
// No instantiation, no API key required.

function customDescriptorToFull(
  entry: string | KodaXModelDescriptor,
  protocol: KodaXCustomProviderConfig['protocol'],
  supportsThinking?: boolean,
  inheritedReasoningPreset?: KodaXModelDescriptor['reasoningPreset'],
): KodaXModelDescriptor {
  const descriptor = typeof entry === 'string' ? { id: entry } : entry;
  const reasoningProfile = resolveCustomModelReasoningProfile(
    descriptor,
    protocol,
    supportsThinking,
    inheritedReasoningPreset,
  );
  // Single-track invariant: supportsThinking:false forces every surface to 'none'
  // (mirrors customModelDescriptorToFull + getCustomModelCapabilities). Without
  // this the deprecated per-model reasoningCapability leaks through the spread and
  // getReasoningCapability(id) reports a stale label the runtime never acts on.
  const normalized =
    supportsThinking === false && descriptor.reasoningCapability !== undefined
      ? { ...descriptor, reasoningCapability: 'none' as const }
      : descriptor;
  return reasoningProfile
    ? { ...normalized, reasoningProfile }
    : normalized;
}

/**
 * List all model descriptors for a custom provider. Default model first,
 * then alternatives. Returns undefined when the name doesn't match any
 * registered custom provider — caller can fall through to the built-in
 * `getProviderModelDescriptors`.
 */
export function getCustomProviderModelDescriptors(
  name: string,
): KodaXModelDescriptor[] | undefined {
  const config = customProviders.get(name);
  if (!config) return undefined;
  // When the default model ALSO has an entry in models[], use that entry (with its
  // contextWindow / maxOutputTokens / displayName / reasoningProfile override) as the
  // default descriptor instead of a bare `{id}` — otherwise a picker UI built on this
  // list shows the default model with missing/wrong metadata while getCustomModelCapabilities
  // reports the override. Mirrors the built-in getProviderModelDescriptors fix and the
  // getCustomModelCapabilities descriptor-first precedence.
  const full = (config.models ?? []).map((entry) =>
    customDescriptorToFull(
      entry,
      config.protocol,
      config.supportsThinking,
      config.reasoningPreset,
    ),
  );
  const defaultEntry: KodaXModelDescriptor = full.find((m) => m.id === config.model) ?? { id: config.model };
  const alternatives = full.filter((m) => m.id !== config.model);
  return [defaultEntry, ...alternatives];
}

/**
 * Effective per-model capability surface for a custom provider. Returns
 * undefined when the provider name is not a registered custom provider,
 * OR when the model id doesn't appear under that provider. The same
 * descriptor-then-provider cascade as the built-in counterpart.
 */
export function getCustomModelCapabilities(
  providerName: string,
  modelId: string,
): KodaXModelCapabilities | undefined {
  const config = customProviders.get(providerName);
  if (!config) return undefined;
  const isDefault = modelId === config.model;
  const providerReasoningProfile = resolveCustomProviderReasoningProfile(config);
  // Prefer an explicit models[] entry FIRST, even when modelId is the default:
  // a custom provider's default model can declare its own contextWindow /
  // maxOutputTokens / reasoningProfile override, which the bare `{id}` default
  // descriptor silently dropped. Mirrors base.ts + the built-in registry fix.
  const fromList = (config.models ?? [])
    .map((entry) => customDescriptorToFull(
      entry,
      config.protocol,
      config.supportsThinking,
      config.reasoningPreset,
    ))
    .find((m) => m.id === modelId);
  const descriptor = fromList ?? (isDefault ? ({ id: config.model } as KodaXModelDescriptor) : undefined);
  if (!descriptor) return undefined;
  // supportsThinking:false forces the provider-level 'none' profile (resolved above), so
  // the exposed profile, capability, and runtime all agree on no-thinking — even for a
  // per-model descriptor that carries its own (now-ignored) reasoningProfile.
  const effectiveReasoningProfile =
    config.supportsThinking === false
      ? providerReasoningProfile
      : (descriptor.reasoningProfile ?? providerReasoningProfile);
  const effectiveReasoningCapability =
    config.supportsThinking === false
      ? 'none'
      : (descriptor.reasoningCapability ??
         legacyCapabilityFromReasoningProfile(effectiveReasoningProfile) ??
         config.reasoningCapability ??
         'none');
  return {
    provider: providerName,
    model: descriptor.id,
    displayName: descriptor.displayName ?? descriptor.id,
    supportsThinking: config.supportsThinking ??
      (effectiveReasoningCapability !== 'none' && effectiveReasoningCapability !== 'prompt-only'),
    reasoningCapability: effectiveReasoningCapability,
    reasoningProfile: effectiveReasoningProfile,
    contextWindow: descriptor.contextWindow ?? config.contextWindow,
    maxOutputTokens: descriptor.maxOutputTokens ?? config.maxOutputTokens,
    thinkingBudgetCap:
      descriptor.thinkingBudgetCap ?? config.thinkingBudgetCap,
    isDefault,
  };
}

/**
 * FEATURE_216 v0.7.45 — Look up `(apiKeyEnv, verifyStrategy)` for a
 * registered custom provider without instantiation. Mirrors the
 * built-in `KODAX_PROVIDER_SNAPSHOTS` lookup. Returns undefined when
 * the name is not registered, signaling fall-through.
 *
 * verifyStrategy precedence:
 *   1. Explicit `customProviders[name].verifyStrategy` (user-provided)
 *   2. Protocol-derived default (anthropic → count-tokens / openai → models-list)
 *
 * Matches the same precedence `createCustomProvider()` applies when
 * building the runtime `KodaXProviderConfig` — keeps the two paths
 * (resolver short-circuit vs in-class verifyCredential) consistent.
 */
export function getCustomProviderVerifyMetadata(
  name: string,
): { apiKeyEnv: string; verifyStrategy: KodaXVerifyStrategy } | undefined {
  const config = customProviders.get(name);
  if (!config) return undefined;
  const verifyStrategy: KodaXVerifyStrategy =
    config.verifyStrategy ??
    (config.protocol === 'anthropic' ? 'count-tokens' : 'models-list');
  return { apiKeyEnv: config.apiKeyEnv, verifyStrategy };
}

/**
 * Full capability listing for every registered custom provider / model.
 * Mirrors `listBuiltinModelCapabilities`. Default model first per provider.
 */
export function listCustomProviderModelCapabilities(): KodaXModelCapabilities[] {
  const result: KodaXModelCapabilities[] = [];
  for (const [name, config] of customProviders) {
    const defaultCaps = getCustomModelCapabilities(name, config.model);
    if (defaultCaps) result.push(defaultCaps);
    for (const entry of config.models ?? []) {
      const id = typeof entry === 'string' ? entry : entry.id;
      if (id === config.model) continue;
      const caps = getCustomModelCapabilities(name, id);
      if (caps) result.push(caps);
    }
  }
  return result;
}
