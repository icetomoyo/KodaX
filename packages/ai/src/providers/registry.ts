/**
 * KodaX Provider Registry
 *
 * Provider 注册表 - 统一管理所有 Provider
 */

import { KodaXBaseProvider } from './base.js';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { KodaXGeminiCliProvider } from './gemini-cli.js';
import { KodaXCodexCliProvider } from './codex-cli.js';
import {
  KodaXProviderCapabilityProfile,
  KodaXProviderConfig,
  KodaXReasoningCapability,
} from '../types.js';
import { KodaXProviderError } from '../errors.js';
import {
  CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  cloneCapabilityProfile,
  IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
  NATIVE_PROVIDER_CAPABILITY_PROFILE,
  normalizeCapabilityProfile,
} from './capability-profile.js';
import {
  getCodexCliDefaultModel,
  getCodexCliKnownModels,
  getGeminiCliDefaultModel,
  getGeminiCliKnownModels,
} from './cli-bridge-models.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const GEMINI_CLI_DEFAULT_MODEL = getGeminiCliDefaultModel();
const GEMINI_CLI_MODELS = getGeminiCliKnownModels();
const CODEX_CLI_DEFAULT_MODEL = getCodexCliDefaultModel();
const CODEX_CLI_MODELS = getCodexCliKnownModels();

// ============== Provider 名称类型 ==============

export type ProviderName =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'kimi'
  | 'kimi-code'
  | 'qwen'
  | 'zhipu'
  | 'zhipu-coding'
  | 'minimax-coding'
  | 'gemini-cli'
  | 'codex-cli';

type ProviderSnapshot = {
  model: string;
  models?: readonly string[];
  apiKeyEnv: string;
  reasoningCapability: KodaXReasoningCapability;
  modelReasoningCapabilities?: Partial<Record<string, KodaXReasoningCapability>>;
  capabilityProfile: KodaXProviderCapabilityProfile;
};

// ============== 具体 Provider 实现 ==============

class AnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'anthropic';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-6',
    models: [
      { id: 'claude-opus-4-6', displayName: 'Opus 4.6', thinkingBudgetCap: 28000 },
      { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', thinkingBudgetCap: 10000 },
    ],
    supportsThinking: true,
    reasoningCapability: 'native-budget',
    contextWindow: 200000,  // 200K tokens
    // Anthropic API: max_tokens = thinking + output combined budget.
    // With thinkingBudgetCap=28000, 32768 left only ~4768 for actual output.
    // 64000 ensures ~36000+ tokens for output even at maximum thinking.
    maxOutputTokens: 64000,
    thinkingBudgetCap: 28000,
  };
  constructor() { super(); this.client = new Anthropic({ apiKey: this.getApiKey() }); }
}

class ZhipuCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'zhipu-coding';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5',
    models: [
      { id: 'glm-5.1', displayName: 'GLM-5.1' },
      { id: 'glm-5-turbo', displayName: 'GLM-5 Turbo' },
    ],
    supportsThinking: true,
    reasoningCapability: 'native-budget',
    contextWindow: 200000,
    // GLM-5/5.1/4.7/4.6 all support 128K max output per Zhipu docs
    maxOutputTokens: 128000,
    thinkingBudgetCap: 16000,
  };
  constructor() { super(); this.initClient(); }
}

class KimiCodeProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'kimi-code';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KIMI_API_KEY',
    baseUrl: 'https://api.kimi.com/coding/',
    model: 'k2.5',
    supportsThinking: true,
    reasoningCapability: 'native-budget',
    contextWindow: 256000,
    maxOutputTokens: 64000,
  };
  constructor() { super(); this.initClient(); }
}

class MiniMaxCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'minimax-coding';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'MINIMAX_API_KEY',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    model: 'MiniMax-M2.7',
    models: [
      { id: 'MiniMax-M2.7-highspeed', displayName: 'MiniMax M2.7 Highspeed' },
      { id: 'MiniMax-M2.5', displayName: 'MiniMax M2.5' },
      { id: 'MiniMax-M2.5-highspeed', displayName: 'MiniMax M2.5 Highspeed' },
      { id: 'MiniMax-M2.1', displayName: 'MiniMax M2.1' },
      { id: 'MiniMax-M2.1-highspeed', displayName: 'MiniMax M2.1 Highspeed' },
      { id: 'MiniMax-M2', displayName: 'MiniMax M2' },
    ],
    supportsThinking: true,
    reasoningCapability: 'native-budget',
    contextWindow: 204800,
    // MiniMax M2.7 supports 128K max output
    maxOutputTokens: 128000,
  };
  constructor() { super(); this.initClient(); }
}

class OpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'openai';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-5.3-codex',
    models: [
      { id: 'gpt-5.4', displayName: 'GPT-5.4' },
      { id: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3 Codex Spark' },
    ],
    supportsThinking: true,
    reasoningCapability: 'native-effort',
    contextWindow: 400000,
    maxOutputTokens: 32768,
  };
  constructor() { super(); this.initClient(); }
}

class DeepSeekProvider extends KodaXOpenAICompatProvider {
  readonly name = 'deepseek';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    models: [
      {
        id: 'deepseek-reasoner',
        displayName: 'DeepSeek Reasoner',
        reasoningCapability: 'none',
      },
    ],
    supportsThinking: true,
    reasoningCapability: 'native-toggle',
    contextWindow: 128000,
    // DeepSeek V3.2: 32k max output
    maxOutputTokens: 32768,
  };
  constructor() { super(); this.initClient(); }
}

class KimiProvider extends KodaXOpenAICompatProvider {
  readonly name = 'kimi';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KIMI_API_KEY',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'k2.5',
    supportsThinking: true,
    reasoningCapability: 'native-effort',
    contextWindow: 256000,
    maxOutputTokens: 32768,
  };
  constructor() { super(); this.initClient(); }
}

class QwenProvider extends KodaXOpenAICompatProvider {
  readonly name = 'qwen';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'QWEN_API_KEY',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.5-plus',
    supportsThinking: true,
    reasoningCapability: 'native-budget',
    contextWindow: 256000,
    maxOutputTokens: 32768,
  };
  constructor() { super(); this.initClient(); }
}

class ZhipuProvider extends KodaXOpenAICompatProvider {
  readonly name = 'zhipu';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5',
    models: [
      { id: 'glm-5.1', displayName: 'GLM-5.1' },
      { id: 'glm-5-turbo', displayName: 'GLM-5 Turbo' },
    ],
    supportsThinking: true,
    reasoningCapability: 'native-budget',
    contextWindow: 200000,
    maxOutputTokens: 32768,
  };
  constructor() { super(); this.initClient(); }
}

// ============== Provider 工厂 ==============

export const KODAX_PROVIDERS: Record<string, () => KodaXBaseProvider> = {
  anthropic: () => new AnthropicProvider(),
  openai: () => new OpenAIProvider(),
  deepseek: () => new DeepSeekProvider(),
  kimi: () => new KimiProvider(),
  'kimi-code': () => new KimiCodeProvider(),
  qwen: () => new QwenProvider(),
  zhipu: () => new ZhipuProvider(),
  'zhipu-coding': () => new ZhipuCodingProvider(),
  'minimax-coding': () => new MiniMaxCodingProvider(),
  'gemini-cli': () => new KodaXGeminiCliProvider(),
  'codex-cli': () => new KodaXCodexCliProvider(),
};

export const KODAX_PROVIDER_SNAPSHOTS: Record<ProviderName, ProviderSnapshot> = {
  anthropic: {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-6',
    models: ['claude-opus-4-6', 'claude-haiku-4-5'],
    reasoningCapability: 'native-budget',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-5.3-codex',
    models: ['gpt-5.4', 'gpt-5.3-codex-spark'],
    reasoningCapability: 'native-effort',
    capabilityProfile: IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  deepseek: {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
    models: ['deepseek-reasoner'],
    reasoningCapability: 'native-toggle',
    modelReasoningCapabilities: {
      'deepseek-chat': 'native-toggle',
      'deepseek-reasoner': 'none',
    },
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  kimi: {
    apiKeyEnv: 'KIMI_API_KEY',
    model: 'k2.5',
    reasoningCapability: 'native-effort',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  'kimi-code': {
    apiKeyEnv: 'KIMI_API_KEY',
    model: 'k2.5',
    reasoningCapability: 'native-budget',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  qwen: {
    apiKeyEnv: 'QWEN_API_KEY',
    model: 'qwen3.5-plus',
    reasoningCapability: 'native-budget',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  zhipu: {
    apiKeyEnv: 'ZHIPU_API_KEY',
    model: 'glm-5',
    models: ['glm-5.1', 'glm-5-turbo'],
    reasoningCapability: 'native-budget',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  'zhipu-coding': {
    apiKeyEnv: 'ZHIPU_API_KEY',
    model: 'glm-5',
    models: ['glm-5.1', 'glm-5-turbo'],
    reasoningCapability: 'native-budget',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  'minimax-coding': {
    apiKeyEnv: 'MINIMAX_API_KEY',
    model: 'MiniMax-M2.7',
    models: [
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2',
    ],
    reasoningCapability: 'native-budget',
    capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
  },
  'gemini-cli': {
    apiKeyEnv: 'GEMINI_API_KEY',
    model: GEMINI_CLI_DEFAULT_MODEL,
    models: GEMINI_CLI_MODELS.filter((model) => model !== GEMINI_CLI_DEFAULT_MODEL),
    reasoningCapability: 'prompt-only',
    capabilityProfile: CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  },
  'codex-cli': {
    apiKeyEnv: 'OPENAI_API_KEY',
    model: CODEX_CLI_DEFAULT_MODEL,
    models: CODEX_CLI_MODELS.filter((model) => model !== CODEX_CLI_DEFAULT_MODEL),
    reasoningCapability: 'prompt-only',
    capabilityProfile: CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  },
};

export const KODAX_DEFAULT_PROVIDER = process.env.KODAX_PROVIDER ?? 'zhipu-coding';

export function getProvider(name?: string): KodaXBaseProvider {
  const n = name ?? KODAX_DEFAULT_PROVIDER;
  const factory = KODAX_PROVIDERS[n];
  if (!factory) throw new KodaXProviderError(`Unknown provider: ${n}. Available: ${Object.keys(KODAX_PROVIDERS).join(', ')}`, n);
  return factory();
}

// 检查 Provider 是否已配置 API Key
export function isProviderConfigured(name: string): boolean {
  if (!isProviderName(name)) {
    return false;
  }
  return !!process.env[KODAX_PROVIDER_SNAPSHOTS[name].apiKeyEnv];
}

// 获取 Provider 使用的模型名称
export function getProviderModel(name: string): string | null {
  return isProviderName(name)
    ? KODAX_PROVIDER_SNAPSHOTS[name].model
    : null;
}

export function getProviderConfiguredReasoningCapability(
  name: string,
  modelOverride?: string,
): KodaXReasoningCapability | 'unknown' {
  if (!isProviderName(name)) {
    return 'unknown';
  }

  const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
  const effectiveModel = modelOverride ?? snapshot.model;

  return snapshot.modelReasoningCapabilities?.[effectiveModel]
    ?? snapshot.reasoningCapability;
}

export function getProviderConfiguredCapabilityProfile(
  name: string,
): KodaXProviderCapabilityProfile | null {
  return isProviderName(name)
    ? cloneCapabilityProfile(KODAX_PROVIDER_SNAPSHOTS[name].capabilityProfile)
    : null;
}

// 获取所有可用的 Provider 列表（带配置状态）
export function getProviderList(): Array<{
  name: string;
  model: string;
  models: string[];
  configured: boolean;
  reasoningCapability: KodaXReasoningCapability;
  capabilityProfile: KodaXProviderCapabilityProfile;
}> {
  const result: Array<{
    name: string;
    model: string;
    models: string[];
    configured: boolean;
    reasoningCapability: KodaXReasoningCapability;
    capabilityProfile: KodaXProviderCapabilityProfile;
  }> = [];
  for (const name of Object.keys(KODAX_PROVIDERS) as ProviderName[]) {
    const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
    result.push({
      name,
      model: snapshot.model,
      models: snapshot.models ? [snapshot.model, ...snapshot.models] : [snapshot.model],
      configured: !!process.env[snapshot.apiKeyEnv],
      reasoningCapability: snapshot.reasoningCapability,
      capabilityProfile: cloneCapabilityProfile(snapshot.capabilityProfile),
    });
  }
  return result;
}

// 获取内置 Provider 的可用模型列表（不需要实例化 Provider，不依赖 API Key）
export function getProviderModels(name: string): string[] {
  const snapshot = KODAX_PROVIDER_SNAPSHOTS[name as ProviderName];
  if (!snapshot) return [];
  return snapshot.models ? [snapshot.model, ...snapshot.models] : [snapshot.model];
}

// 类型守卫函数：检查字符串是否为有效的 Provider 名称
export function isProviderName(name: string): name is ProviderName {
  return name in KODAX_PROVIDERS;
}

export { normalizeCapabilityProfile };
