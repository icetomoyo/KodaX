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

function buildProviderConfig(custom: KodaXCustomProviderConfig): KodaXProviderConfig {
  const models = custom.models?.length
    ? custom.models.map(id => ({ id }))
    : undefined;

  return {
    apiKeyEnv: custom.apiKeyEnv,
    model: custom.model,
    baseUrl: custom.baseUrl,
    models,
    supportsThinking: custom.supportsThinking ?? false,
    reasoningCapability: custom.reasoningCapability ?? 'none',
    capabilityProfile: custom.capabilityProfile,
    contextWindow: custom.contextWindow,
    maxOutputTokens: custom.maxOutputTokens,
    thinkingBudgetCap: custom.thinkingBudgetCap,
  };
}

export function createCustomProvider(custom: KodaXCustomProviderConfig): KodaXBaseProvider {
  if (!custom.name || !custom.baseUrl || !custom.apiKeyEnv || !custom.model) {
    throw new Error(
      `Custom provider requires name, baseUrl, apiKeyEnv, and model. Got: ${JSON.stringify({ name: custom.name, baseUrl: custom.baseUrl, apiKeyEnv: custom.apiKeyEnv, model: custom.model })}`
    );
  }
  if (custom.protocol !== 'anthropic' && custom.protocol !== 'openai') {
    throw new Error(`Unknown protocol "${custom.protocol}" for custom provider "${custom.name}". Must be "anthropic" or "openai".`);
  }

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
