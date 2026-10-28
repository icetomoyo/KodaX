/**
 * FEATURE_198 v0.7.44 — Provider capability JSON schema + validator.
 *
 * Backs `KODAX_PROVIDER_SNAPSHOTS` with a separate JSON file so KodaX
 * consumers can hot-patch capability data (context window, max output
 * tokens, model lists) without waiting for a KodaX release.
 *
 * Hand-rolled validator (no zod) — single schema, lightweight package,
 * aligns with the "no new deps unless 3+ use cases" rule. Validator
 * fails loudly with the field path so manual JSON edits surface clearly.
 */

import type {
  KodaXModelDescriptor,
  KodaXOpenAICompatMaxOutputTokensField,
  KodaXProviderCapabilityProfile,
  KodaXReasoningCapability,
  KodaXReasoningProfile,
  KodaXReasoningPresetName,
  KodaXReasoningEffortWireStrategy,
  KodaXThinkingWireStrategy,
  KodaXVerifyStrategy,
} from '../types.js';

/**
 * Capability profile names that the loader resolves to the concrete
 * profile objects exported from `capability-profile.ts`. JSON keeps a
 * string name (debugger-friendly, hot-patch-stable) instead of inlining
 * the full profile object, which would balloon the file and duplicate
 * the shape defined in `capability-profile.ts`.
 */
export type CapabilityProfileName =
  | 'native'
  | 'image-input-native'
  | 'cli-bridge'
  | 'image-input-cli-bridge';

/**
 * JSON shape for a single provider entry. Mirrors the in-memory
 * `ProviderSnapshot` (registry.ts) one-to-one, except:
 *  - `capabilityProfile` is a name (string) the loader resolves
 *  - `cliBridge: true` opts the entry into runtime fill of `model` and
 *    `models` from `cli-bridge-models.ts` (gemini-cli / codex-cli)
 *  - `cliBridge` entries OMIT `model` / `models` from the JSON since
 *    those are owned by the local CLI binary, not KodaX metadata
 */
export interface ProviderCapabilityJsonEntry {
  readonly apiKeyEnv: string;
  readonly model?: string;
  readonly models?: ReadonlyArray<KodaXModelDescriptor>;
  readonly reasoningCapability: KodaXReasoningCapability;
  readonly reasoningProfile?: KodaXReasoningProfile;
  readonly modelReasoningCapabilities?: Readonly<
    Record<string, KodaXReasoningCapability>
  >;
  readonly capabilityProfile: CapabilityProfileName;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly maxOutputTokensField?: KodaXOpenAICompatMaxOutputTokensField;
  readonly thinkingBudgetCap?: number;
  readonly supportsThinking?: boolean;
  /** When true, loader injects `model` + `models` from cli-bridge-models.ts. */
  readonly cliBridge?: boolean;
  /**
   * FEATURE_216 v0.7.45 — Verify primitive this provider uses for
   * credential checks. Required (no silent default) because the choice
   * is provider-empirical, not protocol-derived. cliBridge entries MUST
   * be 'unsupported' (CLI binary owns its own credentials).
   */
  readonly verifyStrategy: KodaXVerifyStrategy;
}

export interface ProviderCapabilitiesJson {
  readonly version: 1;
  readonly updatedAt: string;
  readonly providers: Readonly<Record<string, ProviderCapabilityJsonEntry>>;
}

/**
 * Resolved snapshot — what `KODAX_PROVIDER_SNAPSHOTS` callers see.
 * Identical shape to the legacy in-memory type so consumers are
 * unchanged.
 */
export interface ProviderSnapshot {
  readonly model: string;
  readonly models?: ReadonlyArray<KodaXModelDescriptor>;
  readonly apiKeyEnv: string;
  readonly reasoningCapability: KodaXReasoningCapability;
  readonly reasoningProfile?: KodaXReasoningProfile;
  readonly modelReasoningCapabilities?: Readonly<
    Record<string, KodaXReasoningCapability>
  >;
  readonly capabilityProfile: KodaXProviderCapabilityProfile;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly maxOutputTokensField?: KodaXOpenAICompatMaxOutputTokensField;
  readonly thinkingBudgetCap?: number;
  readonly supportsThinking?: boolean;
  /** FEATURE_216 v0.7.45 — verify primitive for this provider. */
  readonly verifyStrategy: KodaXVerifyStrategy;
}

const VALID_REASONING_CAPABILITIES: readonly KodaXReasoningCapability[] = [
  'none',
  'prompt-only',
  'native-effort',
  'native-budget',
  'native-toggle',
  'native-adaptive',
  'unknown',
];

// Allowlist for effortStrategy values appearing in provider-capabilities.json.
// `anthropic-reasoning-effort` is shared by custom providers and built-ins whose
// non-Claude Anthropic-compatible wire shape has been verified directly.
const VALID_EFFORT_STRATEGIES: readonly KodaXReasoningEffortWireStrategy[] = [
  'openai-responses-effort',
  'openai-chat-effort',
  'codex-cli-config',
  'anthropic-output-effort',
  'anthropic-reasoning-effort',
  'provider-budget',
  'provider-toggle',
  'prompt-only',
  'none',
];

const VALID_THINKING_STRATEGIES: readonly KodaXThinkingWireStrategy[] = [
  'anthropic-adaptive',
  'anthropic-budget',
  'provider-budget',
  'provider-toggle',
  'none',
];

const VALID_REASONING_PRESETS: readonly KodaXReasoningPresetName[] = [
  'zai-glm-5.3',
  'zai-glm-5.2',
  'zai-glm-toggle',
  'deepseek-v4-flash-openai',
  'deepseek-v4-pro-openai',
  'deepseek-v4-openai',
  'deepseek-v4-anthropic',
  'deepseek-toggle',
  'kimi-k3',
  'kimi-k3.1',
  'kimi-k2.7-code',
  'kimi-hybrid-toggle',
  'minimax-m3',
  'minimax-m2-always',
  'mimo-v2.5-toggle',
  'qwen-hybrid-thinking',
  'openai-chat-reasoning',
  'openai-responses-reasoning',
  'codex-cli-effort',
  'claude-adaptive-xhigh',
  'claude-adaptive-max',
  'anthropic-budget',
  'generic-thinking-toggle',
  'none',
];

const VALID_OPENAI_MAX_OUTPUT_TOKEN_FIELDS: readonly KodaXOpenAICompatMaxOutputTokensField[] = [
  'max_tokens',
  'max_completion_tokens',
];

const VALID_PROFILE_NAMES: readonly CapabilityProfileName[] = [
  'native',
  'image-input-native',
  'cli-bridge',
  'image-input-cli-bridge',
];

const VALID_VERIFY_STRATEGIES: readonly KodaXVerifyStrategy[] = [
  'count-tokens',
  'models-list',
  'minimal-message',
  'unsupported',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `provider-capabilities.json: ${path} must be a non-empty string`,
    );
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path);
}

function optionalMaxOutputTokensField(
  value: unknown,
  path: string,
): KodaXOpenAICompatMaxOutputTokensField | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || !VALID_OPENAI_MAX_OUTPUT_TOKEN_FIELDS.includes(
      value as KodaXOpenAICompatMaxOutputTokensField,
    )
  ) {
    throw new Error(
      `provider-capabilities.json: ${path} must be one of ${VALID_OPENAI_MAX_OUTPUT_TOKEN_FIELDS.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as KodaXOpenAICompatMaxOutputTokensField;
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `provider-capabilities.json: ${path} must be a non-negative finite number`,
    );
  }
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`provider-capabilities.json: ${path} must be a boolean`);
  }
  return value;
}

function optionalStringArray(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`provider-capabilities.json: ${path} must be an array`);
  }
  return value.map((entry, index) =>
    requireString(entry, `${path}[${index}]`),
  );
}

function optionalStringMap(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`provider-capabilities.json: ${path} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = requireString(entry, `${path}.${key}`);
  }
  return out;
}

function optionalReasoningPreset(
  value: unknown,
  path: string,
): KodaXReasoningPresetName | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !VALID_REASONING_PRESETS.includes(value as KodaXReasoningPresetName)
  ) {
    throw new Error(
      `provider-capabilities.json: ${path} must be one of ${VALID_REASONING_PRESETS.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as KodaXReasoningPresetName;
}

function requireReasoningCapability(
  value: unknown,
  path: string,
): KodaXReasoningCapability {
  if (
    typeof value !== 'string' ||
    !VALID_REASONING_CAPABILITIES.includes(value as KodaXReasoningCapability)
  ) {
    throw new Error(
      `provider-capabilities.json: ${path} must be one of ${VALID_REASONING_CAPABILITIES.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as KodaXReasoningCapability;
}

function requireEffortStrategy(
  value: unknown,
  path: string,
): KodaXReasoningEffortWireStrategy {
  if (
    typeof value !== 'string' ||
    !VALID_EFFORT_STRATEGIES.includes(value as KodaXReasoningEffortWireStrategy)
  ) {
    throw new Error(
      `provider-capabilities.json: ${path} must be one of ${VALID_EFFORT_STRATEGIES.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as KodaXReasoningEffortWireStrategy;
}

function optionalThinkingStrategy(
  value: unknown,
  path: string,
): KodaXThinkingWireStrategy | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !VALID_THINKING_STRATEGIES.includes(value as KodaXThinkingWireStrategy)
  ) {
    throw new Error(
      `provider-capabilities.json: ${path} must be one of ${VALID_THINKING_STRATEGIES.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as KodaXThinkingWireStrategy;
}

function validateReasoningProfile(
  raw: unknown,
  path: string,
): KodaXReasoningProfile | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error(`provider-capabilities.json: ${path} must be an object`);
  }
  const effortStrategy = requireEffortStrategy(
    raw.effortStrategy,
    `${path}.effortStrategy`,
  );
  const reasoningPreset = optionalReasoningPreset(
    raw.reasoningPreset,
    `${path}.reasoningPreset`,
  );
  const thinkingStrategy = optionalThinkingStrategy(
    raw.thinkingStrategy,
    `${path}.thinkingStrategy`,
  );
  const defaultEffort = optionalString(raw.defaultEffort, `${path}.defaultEffort`);
  const effortAliases = optionalStringMap(
    raw.effortAliases,
    `${path}.effortAliases`,
  );
  const disabledEfforts = optionalStringArray(
    raw.disabledEfforts,
    `${path}.disabledEfforts`,
  );
  const localRejectEfforts = optionalStringArray(
    raw.localRejectEfforts,
    `${path}.localRejectEfforts`,
  );
  const allowCustomEffort = optionalBoolean(raw.allowCustomEffort, `${path}.allowCustomEffort`);
  const supportsReasoningEffort = optionalBoolean(
    raw.supportsReasoningEffort,
    `${path}.supportsReasoningEffort`,
  );
  const supportsReasoningSummary = optionalBoolean(
    raw.supportsReasoningSummary,
    `${path}.supportsReasoningSummary`,
  );
  const supportsEncryptedReasoningReplay = optionalBoolean(
    raw.supportsEncryptedReasoningReplay,
    `${path}.supportsEncryptedReasoningReplay`,
  );
  const supportsAdaptiveThinking = optionalBoolean(
    raw.supportsAdaptiveThinking,
    `${path}.supportsAdaptiveThinking`,
  );
  const supportsManualThinkingBudget = optionalBoolean(
    raw.supportsManualThinkingBudget,
    `${path}.supportsManualThinkingBudget`,
  );
  const supportsDisabledThinking = optionalBoolean(
    raw.supportsDisabledThinking,
    `${path}.supportsDisabledThinking`,
  );
  const requiresEffortBetaHeader = optionalBoolean(
    raw.requiresEffortBetaHeader,
    `${path}.requiresEffortBetaHeader`,
  );

  const capability: KodaXReasoningProfile = { effortStrategy };
  if (reasoningPreset !== undefined) {
    (capability as { reasoningPreset: KodaXReasoningPresetName }).reasoningPreset = reasoningPreset;
  }
  if (thinkingStrategy !== undefined) {
    (capability as { thinkingStrategy: KodaXThinkingWireStrategy }).thinkingStrategy = thinkingStrategy;
  }
  if (defaultEffort !== undefined) {
    (capability as { defaultEffort: string }).defaultEffort = defaultEffort;
  }
  if (effortAliases !== undefined) {
    (capability as { effortAliases: Record<string, string> }).effortAliases = effortAliases;
  }
  if (disabledEfforts !== undefined) {
    (capability as { disabledEfforts: readonly string[] }).disabledEfforts = disabledEfforts;
  }
  if (localRejectEfforts !== undefined) {
    (capability as { localRejectEfforts: readonly string[] }).localRejectEfforts = localRejectEfforts;
  }
  if (raw.supportedEfforts !== undefined) {
    if (!Array.isArray(raw.supportedEfforts)) {
      throw new Error(`provider-capabilities.json: ${path}.supportedEfforts must be an array`);
    }
    (capability as { supportedEfforts: NonNullable<KodaXReasoningProfile['supportedEfforts']> }).supportedEfforts =
      raw.supportedEfforts.map((entry, index) => {
        if (!isPlainObject(entry)) {
          throw new Error(`provider-capabilities.json: ${path}.supportedEfforts[${index}] must be an object`);
        }
        const value = requireString(entry.value, `${path}.supportedEfforts[${index}].value`);
        return {
          value,
          ...(optionalString(entry.description, `${path}.supportedEfforts[${index}].description`) !== undefined
            ? { description: optionalString(entry.description, `${path}.supportedEfforts[${index}].description`) }
            : {}),
          ...(optionalBoolean(entry.isDefault, `${path}.supportedEfforts[${index}].isDefault`) !== undefined
            ? { isDefault: optionalBoolean(entry.isDefault, `${path}.supportedEfforts[${index}].isDefault`) }
            : {}),
          ...(optionalBoolean(entry.isUserVisible, `${path}.supportedEfforts[${index}].isUserVisible`) !== undefined
            ? { isUserVisible: optionalBoolean(entry.isUserVisible, `${path}.supportedEfforts[${index}].isUserVisible`) }
            : {}),
        };
      });
  }
  if (raw.budgetByEffort !== undefined) {
    if (!isPlainObject(raw.budgetByEffort)) {
      throw new Error(`provider-capabilities.json: ${path}.budgetByEffort must be an object`);
    }
    const budgetByEffort: Record<string, number> = {};
    for (const [effort, budget] of Object.entries(raw.budgetByEffort)) {
      budgetByEffort[effort] = optionalNumber(budget, `${path}.budgetByEffort.${effort}`) ?? 0;
    }
    (capability as { budgetByEffort: Record<string, number> }).budgetByEffort = budgetByEffort;
  }
  if (allowCustomEffort !== undefined) {
    (capability as { allowCustomEffort: boolean }).allowCustomEffort = allowCustomEffort;
  }
  if (supportsReasoningEffort !== undefined) {
    (capability as { supportsReasoningEffort: boolean }).supportsReasoningEffort = supportsReasoningEffort;
  }
  if (supportsReasoningSummary !== undefined) {
    (capability as { supportsReasoningSummary: boolean }).supportsReasoningSummary = supportsReasoningSummary;
  }
  if (supportsEncryptedReasoningReplay !== undefined) {
    (capability as { supportsEncryptedReasoningReplay: boolean }).supportsEncryptedReasoningReplay = supportsEncryptedReasoningReplay;
  }
  if (supportsAdaptiveThinking !== undefined) {
    (capability as { supportsAdaptiveThinking: boolean }).supportsAdaptiveThinking = supportsAdaptiveThinking;
  }
  if (supportsManualThinkingBudget !== undefined) {
    (capability as { supportsManualThinkingBudget: boolean }).supportsManualThinkingBudget = supportsManualThinkingBudget;
  }
  if (supportsDisabledThinking !== undefined) {
    (capability as { supportsDisabledThinking: boolean }).supportsDisabledThinking = supportsDisabledThinking;
  }
  if (requiresEffortBetaHeader !== undefined) {
    (capability as { requiresEffortBetaHeader: boolean }).requiresEffortBetaHeader = requiresEffortBetaHeader;
  }
  return capability;
}

function validateReasoningProfileField(
  raw: Record<string, unknown>,
  path: string,
): KodaXReasoningProfile | undefined {
  const canonical = raw.reasoningProfile;
  const legacy = raw.reasoningCapabilityV2;
  if (canonical !== undefined && legacy !== undefined) {
    throw new Error(
      `provider-capabilities.json: ${path} must not define both reasoningProfile and deprecated reasoningCapabilityV2`,
    );
  }
  if (canonical !== undefined) {
    return validateReasoningProfile(canonical, `${path}.reasoningProfile`);
  }
  return validateReasoningProfile(legacy, `${path}.reasoningCapabilityV2`);
}

function requireProfileName(value: unknown, path: string): CapabilityProfileName {
  if (
    typeof value !== 'string' ||
    !VALID_PROFILE_NAMES.includes(value as CapabilityProfileName)
  ) {
    throw new Error(
      `provider-capabilities.json: ${path} must be one of ${VALID_PROFILE_NAMES.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as CapabilityProfileName;
}

function requireVerifyStrategy(value: unknown, path: string): KodaXVerifyStrategy {
  if (
    typeof value !== 'string' ||
    !VALID_VERIFY_STRATEGIES.includes(value as KodaXVerifyStrategy)
  ) {
    throw new Error(
      `provider-capabilities.json: ${path} must be one of ${VALID_VERIFY_STRATEGIES.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as KodaXVerifyStrategy;
}

function validateModelDescriptor(
  raw: unknown,
  path: string,
): KodaXModelDescriptor {
  if (!isPlainObject(raw)) {
    throw new Error(`provider-capabilities.json: ${path} must be an object`);
  }
  const id = requireString(raw.id, `${path}.id`);
  const wireModel = optionalString(raw.wireModel, `${path}.wireModel`);
  const displayName = optionalString(raw.displayName, `${path}.displayName`);
  const contextWindow = optionalNumber(raw.contextWindow, `${path}.contextWindow`);
  const maxOutputTokens = optionalNumber(
    raw.maxOutputTokens,
    `${path}.maxOutputTokens`,
  );
  const maxOutputTokensField = optionalMaxOutputTokensField(
    raw.maxOutputTokensField,
    `${path}.maxOutputTokensField`,
  );
  const thinkingBudgetCap = optionalNumber(
    raw.thinkingBudgetCap,
    `${path}.thinkingBudgetCap`,
  );
  const replayReasoningContent = optionalBoolean(
    raw.replayReasoningContent,
    `${path}.replayReasoningContent`,
  );
  const strictThinkingSignature = optionalBoolean(
    raw.strictThinkingSignature,
    `${path}.strictThinkingSignature`,
  );
  const streamMaxDurationMs = optionalNumber(
    raw.streamMaxDurationMs,
    `${path}.streamMaxDurationMs`,
  );
  const reasoningCapability =
    raw.reasoningCapability === undefined
      ? undefined
      : requireReasoningCapability(
          raw.reasoningCapability,
          `${path}.reasoningCapability`,
        );
  const reasoningProfile = validateReasoningProfileField(raw, path);
  const descriptor: KodaXModelDescriptor = { id };
  if (wireModel !== undefined) descriptor.wireModel = wireModel;
  if (displayName !== undefined) descriptor.displayName = displayName;
  if (contextWindow !== undefined) descriptor.contextWindow = contextWindow;
  if (maxOutputTokens !== undefined) descriptor.maxOutputTokens = maxOutputTokens;
  if (maxOutputTokensField !== undefined) {
    descriptor.maxOutputTokensField = maxOutputTokensField;
  }
  if (thinkingBudgetCap !== undefined) {
    descriptor.thinkingBudgetCap = thinkingBudgetCap;
  }
  if (reasoningCapability !== undefined) {
    descriptor.reasoningCapability = reasoningCapability;
  }
  if (reasoningProfile !== undefined) {
    descriptor.reasoningProfile = reasoningProfile;
  }
  if (replayReasoningContent !== undefined) {
    descriptor.replayReasoningContent = replayReasoningContent;
  }
  if (strictThinkingSignature !== undefined) {
    descriptor.strictThinkingSignature = strictThinkingSignature;
  }
  if (streamMaxDurationMs !== undefined) {
    descriptor.streamMaxDurationMs = streamMaxDurationMs;
  }
  return descriptor;
}

function validateModelReasoningCapabilities(
  raw: unknown,
  path: string,
): Record<string, KodaXReasoningCapability> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error(`provider-capabilities.json: ${path} must be an object`);
  }
  const out: Record<string, KodaXReasoningCapability> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = requireReasoningCapability(value, `${path}.${key}`);
  }
  return out;
}

function validateProviderEntry(
  raw: unknown,
  name: string,
): ProviderCapabilityJsonEntry {
  if (!isPlainObject(raw)) {
    throw new Error(
      `provider-capabilities.json: providers.${name} must be an object`,
    );
  }
  const cliBridge = optionalBoolean(raw.cliBridge, `providers.${name}.cliBridge`);
  const apiKeyEnv = requireString(raw.apiKeyEnv, `providers.${name}.apiKeyEnv`);
  const reasoningCapability = requireReasoningCapability(
    raw.reasoningCapability,
    `providers.${name}.reasoningCapability`,
  );
  const reasoningProfile = validateReasoningProfileField(raw, `providers.${name}`);
  const capabilityProfile = requireProfileName(
    raw.capabilityProfile,
    `providers.${name}.capabilityProfile`,
  );
  const verifyStrategy = requireVerifyStrategy(
    raw.verifyStrategy,
    `providers.${name}.verifyStrategy`,
  );
  // cliBridge providers' credentials live in the CLI binary's own token
  // store, outside SDK reach — there is no HTTP primitive to probe.
  if (cliBridge && verifyStrategy !== 'unsupported') {
    throw new Error(
      `provider-capabilities.json: providers.${name} is a cliBridge entry but verifyStrategy="${verifyStrategy}" — must be "unsupported" (CLI binary owns credentials)`,
    );
  }
  const contextWindow = optionalNumber(
    raw.contextWindow,
    `providers.${name}.contextWindow`,
  );
  const maxOutputTokens = optionalNumber(
    raw.maxOutputTokens,
    `providers.${name}.maxOutputTokens`,
  );
  const maxOutputTokensField = optionalMaxOutputTokensField(
    raw.maxOutputTokensField,
    `providers.${name}.maxOutputTokensField`,
  );
  const thinkingBudgetCap = optionalNumber(
    raw.thinkingBudgetCap,
    `providers.${name}.thinkingBudgetCap`,
  );
  const supportsThinking = optionalBoolean(
    raw.supportsThinking,
    `providers.${name}.supportsThinking`,
  );
  const modelReasoningCapabilities = validateModelReasoningCapabilities(
    raw.modelReasoningCapabilities,
    `providers.${name}.modelReasoningCapabilities`,
  );

  // CLI-bridge providers MUST omit model/models — they're filled at load
  // time from the local CLI config. Static providers MUST provide model.
  const model = optionalString(raw.model, `providers.${name}.model`);
  if (cliBridge && (model !== undefined || raw.models !== undefined)) {
    throw new Error(
      `provider-capabilities.json: providers.${name} is a cliBridge entry but defines model/models — must be omitted (filled at load time)`,
    );
  }
  if (!cliBridge && model === undefined) {
    throw new Error(
      `provider-capabilities.json: providers.${name}.model is required (only cliBridge entries may omit)`,
    );
  }
  let models: ReadonlyArray<KodaXModelDescriptor> | undefined;
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) {
      throw new Error(
        `provider-capabilities.json: providers.${name}.models must be an array`,
      );
    }
    models = raw.models.map((entry, index) =>
      validateModelDescriptor(entry, `providers.${name}.models[${index}]`),
    );
    const declaredModels = new Set([
      ...(model === undefined ? [] : [model]),
      ...models.map((descriptor) => descriptor.id),
    ]);
    for (const [index, descriptor] of models.entries()) {
      if (
        descriptor.wireModel !== undefined &&
        !declaredModels.has(descriptor.wireModel)
      ) {
        throw new Error(
          `provider-capabilities.json: providers.${name}.models[${index}].wireModel must reference a declared model, got ${JSON.stringify(descriptor.wireModel)}`,
        );
      }
    }
  }

  const entry: ProviderCapabilityJsonEntry = {
    apiKeyEnv,
    reasoningCapability,
    capabilityProfile,
    verifyStrategy,
  };
  if (reasoningProfile !== undefined) {
    (entry as { reasoningProfile: KodaXReasoningProfile }).reasoningProfile =
      reasoningProfile;
  }
  if (model !== undefined) (entry as { model: string }).model = model;
  if (models !== undefined) (entry as { models: typeof models }).models = models;
  if (contextWindow !== undefined) {
    (entry as { contextWindow: number }).contextWindow = contextWindow;
  }
  if (maxOutputTokens !== undefined) {
    (entry as { maxOutputTokens: number }).maxOutputTokens = maxOutputTokens;
  }
  if (maxOutputTokensField !== undefined) {
    (
      entry as { maxOutputTokensField: KodaXOpenAICompatMaxOutputTokensField }
    ).maxOutputTokensField = maxOutputTokensField;
  }
  if (thinkingBudgetCap !== undefined) {
    (entry as { thinkingBudgetCap: number }).thinkingBudgetCap = thinkingBudgetCap;
  }
  if (supportsThinking !== undefined) {
    (entry as { supportsThinking: boolean }).supportsThinking = supportsThinking;
  }
  if (modelReasoningCapabilities !== undefined) {
    (
      entry as { modelReasoningCapabilities: typeof modelReasoningCapabilities }
    ).modelReasoningCapabilities = modelReasoningCapabilities;
  }
  if (cliBridge) {
    (entry as { cliBridge: boolean }).cliBridge = true;
  }
  return entry;
}

/**
 * Validate the parsed JSON object. Throws with a path-qualified error
 * on the first schema violation. Returns a structurally-typed clone
 * suitable for downstream resolution.
 */
export function validateProviderCapabilitiesJson(
  raw: unknown,
): ProviderCapabilitiesJson {
  if (!isPlainObject(raw)) {
    throw new Error('provider-capabilities.json: root must be an object');
  }
  if (raw.version !== 1) {
    throw new Error(
      `provider-capabilities.json: version must be 1, got ${JSON.stringify(raw.version)}`,
    );
  }
  const updatedAt = requireString(raw.updatedAt, 'updatedAt');
  if (!isPlainObject(raw.providers)) {
    throw new Error('provider-capabilities.json: providers must be an object');
  }
  const providers: Record<string, ProviderCapabilityJsonEntry> = {};
  for (const [name, entry] of Object.entries(raw.providers)) {
    providers[name] = validateProviderEntry(entry, name);
  }
  return { version: 1, updatedAt, providers };
}
