/**
 * Custom Provider Factory
 *
 * Creates KodaXBaseProvider instances from KodaXCustomProviderConfig.
 * Supports both OpenAI and Anthropic protocol families.
 */

import {
  type KodaXCustomProviderConfig,
  type KodaXProviderConfig,
} from '../types.js';
import { KodaXBaseProvider } from './base.js';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';

const VALID_CUSTOM_PROVIDER_USER_AGENT_MODES = new Set(['compat', 'sdk']);

export function validateCustomProviderConfig(
  custom: KodaXCustomProviderConfig,
): void {
  if (!custom.name || !custom.baseUrl || !custom.apiKeyEnv || !custom.model) {
    throw new Error(
      `Custom provider requires name, baseUrl, apiKeyEnv, and model. Got: ${JSON.stringify({ name: custom.name, baseUrl: custom.baseUrl, apiKeyEnv: custom.apiKeyEnv, model: custom.model })}`,
    );
  }

  if (custom.protocol !== 'anthropic' && custom.protocol !== 'openai') {
    throw new Error(
      `Unknown protocol "${custom.protocol}" for custom provider "${custom.name}". Must be "anthropic" or "openai".`,
    );
  }

  if (
    custom.userAgentMode !== undefined
    && !VALID_CUSTOM_PROVIDER_USER_AGENT_MODES.has(custom.userAgentMode)
  ) {
    throw new Error(
      `Unknown userAgentMode "${custom.userAgentMode}" for custom provider "${custom.name}". Must be "compat" or "sdk".`,
    );
  }
}

function buildProviderConfig(custom: KodaXCustomProviderConfig): KodaXProviderConfig {
  // Accept both legacy string ids and KodaXModelDescriptor objects.
  // FEATURE_098: descriptor objects carry per-model contextWindow /
  // maxOutputTokens / reasoningCapability so cross-model providers
  // can express real differences instead of a single provider-wide
  // value.
  const models = custom.models?.length
    ? custom.models.map(entry => (typeof entry === 'string' ? { id: entry } : entry))
    : undefined;

  return {
    apiKeyEnv: custom.apiKeyEnv,
    model: custom.model,
    baseUrl: custom.baseUrl,
    models,
    userAgentMode: custom.userAgentMode,
    supportsThinking: custom.supportsThinking ?? false,
    reasoningCapability: custom.reasoningCapability ?? 'none',
    capabilityProfile: custom.capabilityProfile,
    contextWindow: custom.contextWindow,
    maxOutputTokens: custom.maxOutputTokens,
    thinkingBudgetCap: custom.thinkingBudgetCap,
  };
}

export function createCustomProvider(custom: KodaXCustomProviderConfig): KodaXBaseProvider {
  validateCustomProviderConfig(custom);

  const config = buildProviderConfig(custom);

  if (custom.protocol === 'anthropic') {
    return new DynamicAnthropicProvider(custom.name, config);
  }

  return new DynamicOpenAIProvider(custom.name, config);
}

class DynamicAnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name: string;
  protected readonly config: KodaXProviderConfig;

  constructor(name: string, config: KodaXProviderConfig) {
    super();
    this.name = name;
    this.config = config;
    this.initClient();
  }
}

class DynamicOpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name: string;
  protected readonly config: KodaXProviderConfig;

  constructor(name: string, config: KodaXProviderConfig) {
    super();
    this.name = name;
    this.config = config;
    this.initClient();
  }
}
