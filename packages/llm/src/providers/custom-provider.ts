/**
 * Custom Provider Factory
 *
 * Creates KodaXBaseProvider instances from KodaXCustomProviderConfig.
 * Supports both OpenAI and Anthropic protocol families.
 */

import {
  type KodaXCustomProviderConfig,
  type KodaXModelDescriptor,
  type KodaXOpenAICompatMaxOutputTokensField,
  type KodaXProtocolFamily,
  type KodaXProviderCapabilityProfile,
  type KodaXProviderConfig,
  type KodaXReasoningCapability,
  type KodaXReasoningConfig,
  type KodaXReasoningProfile,
  type KodaXSimpleReasoningConfig,
  type KodaXVerifyStrategy,
} from '../types.js';
import { KodaXBaseProvider } from './base.js';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { KodaXOpenAIResponsesProvider } from './openai-responses.js';
import { KodaXOAuthResponsesProvider } from './oauth-responses.js';
import { validateOAuthProviderConfig } from '../oauth/provider-config.js';
import { validateCloudProviderConfig } from '../cloud/provider-config.js';
import { KodaXAzureResponsesProvider, KodaXAzureCompletionsProvider } from './azure-responses.js';
import { KodaXLazyNativeProvider, KodaXLazyCloudProvider } from './lazy-native.js';
import { NATIVE_PROVIDER_CAPABILITY_PROFILE } from './capability-profile.js';
import { createReasoningProfileFromPreset } from '../reasoning.js';
import { optionalOutputTokenLimit } from './output-token-limit.js';
import { validateToolCapabilities } from './tool-constraints.js';
import { validateCacheCapabilities } from './cache-policy.js';

const VALID_CUSTOM_PROVIDER_USER_AGENT_MODES = new Set(['compat', 'sdk']);
const VALID_OPENAI_MAX_OUTPUT_TOKEN_FIELDS = new Set<KodaXOpenAICompatMaxOutputTokensField>([
  'max_tokens',
  'max_completion_tokens',
]);
const VALID_CUSTOM_PROVIDER_VERIFY_STRATEGIES = new Set<KodaXVerifyStrategy>([
  'count-tokens',
  'models-list',
  'minimal-message',
  'unsupported',
]);

type DeprecatedReasoningProfileAlias = {
  readonly reasoningCapabilityV2?: KodaXReasoningProfile;
};

function getConfiguredReasoningProfile(
  value: { readonly reasoningProfile?: KodaXReasoningProfile } & DeprecatedReasoningProfileAlias,
): KodaXReasoningProfile | undefined {
  return value.reasoningProfile ?? value.reasoningCapabilityV2;
}

/**
 * FEATURE_216 v0.7.45 — Derive the default verify strategy when a custom
 * provider config does not set `verifyStrategy` explicitly:
 *   - anthropic protocol → count-tokens (true 0-token if implemented)
 *   - openai protocol    → models-list (auth-gated GET if implemented)
 * Custom providers that hit an upstream where these defaults fail should
 * set `verifyStrategy: 'minimal-message'` explicitly in their config.
 */
function defaultVerifyStrategyForProtocol(
  protocol: KodaXProtocolFamily,
): KodaXVerifyStrategy {
  return protocol === 'anthropic' ? 'count-tokens' : protocol === 'openai' ? 'models-list' : 'minimal-message';
}

function validateMaxOutputTokensField(
  custom: KodaXCustomProviderConfig,
  value: unknown,
  path: string,
): void {
  if (value === undefined) return;
  if (
    typeof value !== 'string'
    || !VALID_OPENAI_MAX_OUTPUT_TOKEN_FIELDS.has(
      value as KodaXOpenAICompatMaxOutputTokensField,
    )
  ) {
    throw new Error(
      `Custom provider "${custom.name}": ${path} must be "max_tokens" or "max_completion_tokens".`,
    );
  }
  if (custom.protocol !== 'openai') {
    throw new Error(
      `Custom provider "${custom.name}": ${path} is only valid for protocol="openai".`,
    );
  }
}

export function legacyCapabilityFromReasoningProfile(
  capability: KodaXReasoningProfile | undefined,
): KodaXReasoningCapability | undefined {
  if (!capability) {
    return undefined;
  }
  if (capability.effortStrategy === 'none') {
    return 'none';
  }
  if (capability.effortStrategy === 'prompt-only') {
    return 'prompt-only';
  }
  if (capability.thinkingStrategy === 'anthropic-adaptive') {
    return 'native-adaptive';
  }
  if (capability.effortStrategy === 'provider-budget') {
    return 'native-budget';
  }
  if (capability.effortStrategy === 'provider-toggle') {
    return 'native-toggle';
  }
  return 'native-effort';
}

function legacyReasoningPresetForProtocol(
  protocol: KodaXProtocolFamily,
  reasoningCapability: KodaXReasoningCapability | undefined,
  supportsThinking?: boolean,
): KodaXModelDescriptor['reasoningPreset'] | undefined {
  if (supportsThinking === false) {
    return 'none';
  }
  if (protocol === 'google' || protocol === 'bedrock') return undefined;
  switch (reasoningCapability) {
    case 'none':
    case 'prompt-only':
      return 'none';
    case 'native-toggle':
      // OpenAI has no portable thinking toggle. Leave the preset unspecified;
      // provider resolution below supplies an unknown-capability effort strategy.
      return protocol === 'anthropic' ? 'generic-thinking-toggle' : undefined;
    case 'native-budget':
      return protocol === 'anthropic' ? 'anthropic-budget' : 'qwen-hybrid-thinking';
    case 'native-effort':
      return protocol === 'anthropic' ? 'claude-adaptive-max' : 'openai-chat-reasoning';
    case 'native-adaptive':
      // OpenAI-compatible unknown models use effort negotiation instead of adaptive thinking.
      return protocol === 'anthropic' ? 'claude-adaptive-max' : undefined;
    default:
      // Bare supportsThinking with no explicit capability: anthropic-compat keeps the
      // non-Claude enable toggle; OpenAI uses the unknown-capability effort strategy.
      if (supportsThinking !== true) return undefined;
      return protocol === 'anthropic' ? 'generic-thinking-toggle' : undefined;
  }
}

/** True for the canonical friendly form (`{ efforts }`) or `"none"`. */
function isSimpleReasoning(
  reasoning: KodaXReasoningConfig | undefined,
): reasoning is KodaXSimpleReasoningConfig | 'none' {
  return (
    reasoning === 'none'
    || (typeof reasoning === 'object'
      && reasoning !== null
      && Array.isArray((reasoning as KodaXSimpleReasoningConfig).efforts))
  );
}

/**
 * Build a full reasoning profile from the friendly `{ efforts, default }` form.
 * The wire strategy is derived from `protocol` so users never name a preset;
 * `"off"` maps to the internal `none` rung and lights up disable-thinking.
 */
function buildReasoningProfileFromSimple(
  simple: KodaXSimpleReasoningConfig | 'none',
  protocol: KodaXProtocolFamily,
): KodaXReasoningProfile {
  if (simple === 'none') {
    return createReasoningProfileFromPreset('none');
  }
  const toWire = (effort: string): string => (effort === 'off' ? 'none' : effort);
  const wireEfforts = simple.efforts.map(toWire);
  const defaultWire = simple.default ? toWire(simple.default) : undefined;
  const canDisable = wireEfforts.includes('none');
  const supportedEfforts = wireEfforts.map((value) =>
    value === defaultWire ? { value, isDefault: true } : { value },
  );
  return {
    // anthropic-compat: most anthropic-compatible endpoints front NON-Claude models
    // (zhipu/kimi/minimax/deepseek), whose thinking dialect is {type:'enabled'} +
    // reasoning_effort — NOT Claude's adaptive + output_config.effort. Map the friendly
    // form there so those models get thinking-on + a tunable effort (B1). A real-Claude
    // anthropic-compat endpoint instead wants adaptive: configure an explicit
    // reasoningProfile (effortStrategy:'anthropic-output-effort') for that case.
    effortStrategy: protocol === 'google' ? 'google-thinking-level' : protocol === 'bedrock' ? 'bedrock-anthropic-effort'
      : protocol === 'anthropic' ? 'anthropic-reasoning-effort' : 'openai-chat-effort',
    ...(protocol === 'anthropic' ? { thinkingStrategy: 'provider-toggle' as const } : {}),
    ...(defaultWire !== undefined ? { defaultEffort: defaultWire } : {}),
    supportedEfforts,
    ...(canDisable
      ? { disabledEfforts: ['none'], supportsDisabledThinking: true }
      : { localRejectEfforts: ['none'], supportsDisabledThinking: false }),
    supportsReasoningEffort: true,
  };
}

function resolveCustomReasoningProfile(
  reasoningProfile: KodaXReasoningProfile | undefined,
  reasoningPreset: KodaXModelDescriptor['reasoningPreset'],
  reasoning: KodaXModelDescriptor['reasoning'],
  legacy?: {
    readonly protocol: KodaXProtocolFamily;
    readonly reasoningCapability?: KodaXReasoningCapability;
    readonly supportsThinking?: boolean;
  },
): KodaXReasoningProfile | undefined {
  const simple = isSimpleReasoning(reasoning) ? reasoning : undefined;
  const partialOverride: Partial<KodaXReasoningProfile> | undefined =
    reasoning !== undefined && !isSimpleReasoning(reasoning) ? reasoning : undefined;

  // 0. supportsThinking:false is the master off-switch — it overrides any explicit
  // reasoningProfile / reasoning / preset so the resolved profile, the reported
  // capability, and the runtime all agree on no-thinking (single-track). A thinking
  // config under supportsThinking:false is contradictory; supportsThinking wins, and
  // warnOnIgnoredReasoningCapability surfaces it. Without this, an explicit profile here
  // would still drive the runtime to send thinking while the capability reads 'none'.
  if (legacy?.supportsThinking === false) {
    return createReasoningProfileFromPreset('none');
  }

  // 1. Explicit full profile wins; an advanced partial override merges on top.
  if (reasoningProfile) {
    return { ...reasoningProfile, ...(partialOverride ?? {}) };
  }
  // 2. Canonical friendly form — preferred over the deprecated preset/legacy path.
  if (simple !== undefined) {
    return buildReasoningProfileFromSimple(simple, legacy?.protocol ?? 'openai');
  }
  // 3. Deprecated (auto-migrated): explicit preset name or legacy capability mapping.
  const effectivePreset = reasoningPreset ?? (legacy
    ? legacyReasoningPresetForProtocol(
        legacy.protocol,
        legacy.reasoningCapability,
        legacy.supportsThinking,
      )
    : undefined);
  return effectivePreset
    ? createReasoningProfileFromPreset(effectivePreset, partialOverride)
    : undefined;
}

function migrateLegacyDeepSeekPreset(
  preset: KodaXModelDescriptor['reasoningPreset'],
  modelId: string,
  wireModel?: string,
): KodaXModelDescriptor['reasoningPreset'] {
  if (preset !== 'deepseek-v4-openai') return preset;
  const upstreamModel = wireModel ?? modelId;
  if (upstreamModel === 'deepseek-v4-flash' || upstreamModel === 'deepseek-flash') {
    return 'deepseek-v4-flash-openai';
  }
  if (upstreamModel === 'deepseek-v4-pro') {
    return 'deepseek-v4-pro-openai';
  }
  return preset;
}

function selectReasoningApi(profile: KodaXReasoningProfile | undefined, api: KodaXCustomProviderConfig['api']): KodaXReasoningProfile | undefined {
  return api === 'responses' && profile?.effortStrategy === 'openai-chat-effort'
    ? { ...profile, effortStrategy: 'openai-responses-effort' } : profile;
}

export function resolveCustomProviderReasoningProfile(
  config: KodaXCustomProviderConfig,
): KodaXReasoningProfile | undefined {
  // The fallback describes a wire dialect; no supportedEfforts are asserted.
  const profile = resolveCustomReasoningProfile(
    getConfiguredReasoningProfile(config),
    migrateLegacyDeepSeekPreset(config.reasoningPreset, config.model),
    config.reasoning,
    {
      protocol: config.protocol,
      reasoningCapability: config.reasoningCapability,
      supportsThinking: config.supportsThinking,
    },
  ) ?? (config.protocol === 'openai'
    ? { effortStrategy: 'openai-chat-effort', allowCustomEffort: true }
    : undefined);
  return selectReasoningApi(profile, config.api);
}

export function resolveCustomModelReasoningProfile(
  descriptor: KodaXModelDescriptor,
  protocol: KodaXProtocolFamily,
  // Provider-level master off-switch. When the provider declares supportsThinking:false,
  // it overrides a per-model reasoning profile too (single-track), so the per-model
  // descriptor resolves to the 'none' profile at the SOURCE — keeping the runtime
  // (getReasoningProfile(modelId)) consistent with the capability query surfaces.
  supportsThinking?: boolean,
  inheritedReasoningPreset?: KodaXModelDescriptor['reasoningPreset'],
  api?: KodaXCustomProviderConfig['api'],
): KodaXReasoningProfile | undefined {
  const inheritsLegacyPreset =
    inheritedReasoningPreset === 'deepseek-v4-openai'
    && getConfiguredReasoningProfile(descriptor) === undefined
    && descriptor.reasoningPreset === undefined
    && descriptor.reasoning === undefined
    && descriptor.reasoningCapability === undefined;
  const profile = resolveCustomReasoningProfile(
    getConfiguredReasoningProfile(descriptor),
    migrateLegacyDeepSeekPreset(
      descriptor.reasoningPreset ?? (inheritsLegacyPreset ? inheritedReasoningPreset : undefined),
      descriptor.id,
      descriptor.wireModel,
    ),
    descriptor.reasoning,
    {
      protocol,
      reasoningCapability: descriptor.reasoningCapability,
      supportsThinking,
    },
  );
  return selectReasoningApi(profile, api);
}

function customModelDescriptorToFull(
  entry: string | KodaXModelDescriptor,
  protocol: KodaXProtocolFamily,
  supportsThinking?: boolean,
  inheritedReasoningPreset?: KodaXModelDescriptor['reasoningPreset'],
  api?: KodaXCustomProviderConfig['api'],
): KodaXModelDescriptor {
  const descriptor = typeof entry === 'string' ? { id: entry } : entry;
  const reasoningProfile = resolveCustomModelReasoningProfile(
    descriptor,
    protocol,
    supportsThinking,
    inheritedReasoningPreset,
    api,
  );
  // Single-track invariant: a provider-level supportsThinking:false must make
  // EVERY surface agree on 'none' — same override buildProviderConfig and
  // getCustomModelCapabilities already apply. Otherwise the deprecated per-model
  // reasoningCapability field survives the spread and getReasoningCapability(id)
  // reports a stale label (e.g. 'native-effort') the runtime never acts on,
  // masking the 'reasoning-control-limited' user warning (provider-policy).
  const normalized =
    supportsThinking === false && descriptor.reasoningCapability !== undefined
      ? { ...descriptor, reasoningCapability: 'none' as const }
      : descriptor;
  return reasoningProfile
    ? { ...normalized, reasoningProfile }
    : normalized;
}

export function validateCustomProviderConfig(
  custom: KodaXCustomProviderConfig,
): void {
  validateToolCapabilities(custom.toolCapabilities);
  validateCacheCapabilities(custom.cacheCapabilities);
  const cacheDialects = custom.protocol === 'anthropic' ? ['anthropic'] : custom.protocol === 'bedrock' ? ['bedrock']
    : custom.protocol === 'pi-messages' ? ['pi'] : custom.protocol === 'openai' ? custom.api === 'responses' ? ['openai-options', 'openai-retention', 'affinity'] : ['openai-retention', 'affinity'] : [];
  const cacheProfiles = [custom.cacheCapabilities, ...(custom.models ?? []).flatMap(model => typeof model === 'string' ? [] : [model.cacheCapabilities])];
  if (cacheProfiles.some(profile => profile && !cacheDialects.includes(profile.dialect))) throw new Error('Declared cache dialect does not match the native API.');
  for (const model of custom.models ?? []) if (typeof model !== 'string') validateCacheCapabilities(model.cacheCapabilities);
  for (const model of custom.models ?? []) if (typeof model !== 'string') validateToolCapabilities(model.toolCapabilities);
  const grammarRoute = custom.protocol === 'pi-messages' || (custom.protocol === 'openai' && custom.api === 'responses');
  if (!grammarRoute && (custom.toolCapabilities?.grammar?.length || custom.models?.some(model => typeof model !== 'string' && model.toolCapabilities?.grammar?.length))) throw new Error('Grammar tools require Responses or Pi Messages.');
  if (!custom.name || !custom.baseUrl || !custom.apiKeyEnv || !custom.model) {
    throw new Error(
      `Custom provider requires name, baseUrl, apiKeyEnv, and model. Got: ${JSON.stringify({ name: custom.name, baseUrl: custom.baseUrl, apiKeyEnv: custom.apiKeyEnv, model: custom.model })}`,
    );
  }

  if (!['anthropic', 'openai', 'google', 'bedrock', 'mistral', 'pi-messages'].includes(custom.protocol)) {
    throw new Error(
      `Unknown protocol "${custom.protocol}" for custom provider "${custom.name}". Must be "anthropic" or "openai".`,
    );
  }
  validateCloudProviderConfig(custom);
  if (custom.authentication !== undefined && !['bearer', 'cloudflare-gateway'].includes(custom.authentication)) throw new Error('Unknown connection authentication mode.');
  if (custom.authentication !== undefined && (!['anthropic', 'openai', 'google'].includes(custom.protocol)
    || (custom.protocol === 'google' && custom.authentication !== 'bearer')
    || (custom.cloud && custom.cloud.service !== 'gemini'))) throw new Error('Authentication mode is not supported by this native route.');

  if (custom.api !== undefined && (custom.protocol !== 'openai'
    || !['chat-completions', 'responses'].includes(custom.api))) {
    throw new Error(`Custom provider "${custom.name}": api requires openai and must be chat-completions or responses.`);
  }

  validateOAuthProviderConfig(custom);

  if (
    custom.userAgentMode !== undefined
    && !VALID_CUSTOM_PROVIDER_USER_AGENT_MODES.has(custom.userAgentMode)
  ) {
    throw new Error(
      `Unknown userAgentMode "${custom.userAgentMode}" for custom provider "${custom.name}". Must be "compat" or "sdk".`,
    );
  }

  // FEATURE_216 v0.7.45 — Validate explicit verifyStrategy. Also guard
  // against the most common misconfiguration: 'count-tokens' on openai
  // protocol (openai-compat servers do not implement count_tokens).
  if (
    custom.promptCacheAffinity !== undefined
    && typeof custom.promptCacheAffinity !== 'boolean'
  ) {
    throw new Error(
      `Custom provider "${custom.name}": promptCacheAffinity must be a boolean.`,
    );
  }

  if (
    custom.imageInput !== undefined
    && typeof custom.imageInput !== 'boolean'
  ) {
    throw new Error(
      `Custom provider "${custom.name}": imageInput must be a boolean.`,
    );
  }

  optionalOutputTokenLimit(custom.outputTokenLimit, custom.name);

  validateMaxOutputTokensField(
    custom,
    custom.maxOutputTokensField,
    'maxOutputTokensField',
  );
  custom.models?.forEach((model, index) => {
    if (typeof model !== 'string') {
      optionalOutputTokenLimit(model.outputTokenLimit, `${custom.name}.models[${index}]`);
      validateMaxOutputTokensField(
        custom,
        model.maxOutputTokensField,
        `models[${index}].maxOutputTokensField`,
      );
    }
  });

  if (custom.verifyStrategy !== undefined) {
    if (!VALID_CUSTOM_PROVIDER_VERIFY_STRATEGIES.has(custom.verifyStrategy)) {
      throw new Error(
        `Unknown verifyStrategy "${custom.verifyStrategy}" for custom provider "${custom.name}". Must be one of "count-tokens" | "models-list" | "minimal-message" | "unsupported".`,
      );
    }
    if (custom.protocol === 'openai' && custom.verifyStrategy === 'count-tokens') {
      throw new Error(
        `Custom provider "${custom.name}": verifyStrategy="count-tokens" requires Anthropic protocol; got protocol="openai". Use "models-list" or "minimal-message" for OpenAI-compat.`,
      );
    }
  }
}

/**
 * Merge rule for the friendly `imageInput` opt-in (single-track, mirrors the
 * `supportsThinking:false` master-switch precedent): `imageInput === true`
 * forces `multimodalSupport: 'image-input'` — overriding even an explicit
 * `'none'` in the profile, so every surface (provider instance, capability
 * queries, policy gates) agrees. Any other value leaves the profile as-is.
 */
export function mergeCapabilityProfileWithImageInput(
  profile: KodaXProviderCapabilityProfile | undefined,
  imageInput: boolean | undefined,
): KodaXProviderCapabilityProfile | undefined {
  if (imageInput !== true) return profile;
  return {
    ...(profile ?? NATIVE_PROVIDER_CAPABILITY_PROFILE),
    multimodalSupport: 'image-input',
  };
}

function buildProviderConfig(custom: KodaXCustomProviderConfig): KodaXProviderConfig {
  // Accept both legacy string ids and KodaXModelDescriptor objects.
  // FEATURE_098: descriptor objects carry per-model contextWindow /
  // maxOutputTokens / reasoningCapability so cross-model providers
  // can express real differences instead of a single provider-wide
  // value.
  const models = custom.models?.length
    ? custom.models.map((entry) => customModelDescriptorToFull(
        entry,
        custom.protocol,
        custom.supportsThinking,
        custom.reasoningPreset,
        custom.api,
      ))
    : undefined;
  const reasoningProfile = resolveCustomProviderReasoningProfile(custom);
  // supportsThinking:false forces the no-thinking preset at runtime
  // (legacyReasoningPresetForProtocol short-circuits to 'none'), so report the
  // capability as 'none' too — otherwise the capability surface advertises a tunable
  // effort the request never actually sends, misleading SDK / workflow consumers that
  // can't see the startup warning (see warnOnIgnoredReasoningCapability).
  const reasoningCapability =
    custom.supportsThinking === false
      ? 'none'
      : (custom.reasoningCapability ??
         legacyCapabilityFromReasoningProfile(reasoningProfile) ??
         'none');
  const supportsThinking = custom.supportsThinking ??
    (reasoningCapability !== 'none' && reasoningCapability !== 'prompt-only');

  return {
    apiKeyEnv: custom.apiKeyEnv,
    cacheCapabilities: custom.cacheCapabilities ? structuredClone(custom.cacheCapabilities) : undefined,
    toolCapabilities: custom.toolCapabilities ? structuredClone(custom.toolCapabilities) : undefined,
    authentication: custom.authentication,
    oauth: custom.oauth,
    ...(custom.oauth ? { credentialSource: 'broker' as const } : {}),
    model: custom.model,
    baseUrl: custom.baseUrl,
    models,
    userAgentMode: custom.userAgentMode,
    supportsThinking,
    reasoningCapability,
    reasoningProfile,
    capabilityProfile: mergeCapabilityProfileWithImageInput(
      custom.capabilityProfile,
      custom.imageInput,
    ),
    contextWindow: custom.contextWindow,
    maxOutputTokens: custom.maxOutputTokens,
    outputTokenLimit: custom.outputTokenLimit,
    maxOutputTokensField: custom.maxOutputTokensField,
    thinkingBudgetCap: custom.thinkingBudgetCap,
    promptCacheAffinity: custom.promptCacheAffinity ?? false,
    // Provider-level defaults for the three two-layer cascade fields.
    // false / undefined match the legacy implicit defaults so existing
    // custom providers see zero behavior change. Per-model entries in
    // `models[]` can override individually via KodaXModelDescriptor.
    replayReasoningContent: custom.replayReasoningContent ?? false,
    strictThinkingSignature: custom.strictThinkingSignature ?? false,
    streamMaxDurationMs: custom.streamMaxDurationMs,
    // FEATURE_216 v0.7.45 — explicit verifyStrategy wins; otherwise
    // derive from protocol per the table in the type's JSDoc.
    verifyStrategy:
      custom.verifyStrategy ?? (custom.cloud ? 'minimal-message' : defaultVerifyStrategyForProtocol(custom.protocol)),
  };
}

export function createCustomProvider(custom: KodaXCustomProviderConfig): KodaXBaseProvider {
  validateCustomProviderConfig(custom);


  const config = buildProviderConfig(custom);

  if (custom.protocol === 'mistral' || custom.protocol === 'pi-messages') return new KodaXLazyNativeProvider(custom.name, config, custom.protocol);
  if (custom.cloud?.service === 'azure') return custom.api === 'chat-completions' ? new KodaXAzureCompletionsProvider(custom.name, config) : new KodaXAzureResponsesProvider(custom.name, config);
  if (custom.cloud) return new KodaXLazyCloudProvider(custom.name, config, custom.cloud);

  if ((custom.oauth === 'openai-chatgpt' || custom.oauth === 'openai-codex' || custom.oauth === 'github-copilot')
    && custom.protocol === 'openai' && custom.api === 'responses') return new KodaXOAuthResponsesProvider(custom.name, config, custom.oauth);

  if (custom.protocol === 'anthropic') {
    return new DynamicAnthropicProvider(custom.name, config);
  }

  return custom.api === 'responses'
    ? new DynamicResponsesProvider(custom.name, config)
    : new DynamicOpenAIProvider(custom.name, config);
}

class DynamicResponsesProvider extends KodaXOpenAIResponsesProvider {
  constructor(readonly name: string, protected readonly config: KodaXProviderConfig) { super(); }
}

class DynamicAnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name: string;
  protected readonly config: KodaXProviderConfig;

  constructor(name: string, config: KodaXProviderConfig) {
    super();
    this.name = name;
    this.config = config;
  }
}

class DynamicOpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name: string;
  protected readonly config: KodaXProviderConfig;

  constructor(name: string, config: KodaXProviderConfig) {
    super();
    this.name = name;
    this.config = config;
  }
}
