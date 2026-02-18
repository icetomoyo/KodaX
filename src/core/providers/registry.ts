/**
 * KodaX Provider Registry
 *
 * Provider 注册表 - 统一管理所有 Provider
 */

import { KodaXBaseProvider } from './base.js';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { KodaXProviderConfig } from '../types.js';
import { KodaXProviderError } from '../errors.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// ============== 具体 Provider 实现 ==============

class AnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'anthropic';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-20250514',
    supportsThinking: true,
  };
  constructor() { super(); this.client = new Anthropic({ apiKey: this.getApiKey() }); }
}

class ZhipuCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'zhipu-coding';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5',
    supportsThinking: true,
  };
  constructor() { super(); this.initClient(); }
}

class KimiCodeProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'kimi-code';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KIMI_API_KEY',
    baseUrl: 'https://api.kimi.com/coding/',
    model: 'k2p5',
    supportsThinking: true,
  };
  constructor() { super(); this.initClient(); }
}

class MiniMaxCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'minimax-coding';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'MINIMAX_API_KEY',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    model: 'MiniMax-M2.5',
    supportsThinking: true,
  };
  constructor() { super(); this.initClient(); }
}

class OpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'openai';
  protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-4o', supportsThinking: false };
  constructor() { super(); this.initClient(); }
}

class KimiProvider extends KodaXOpenAICompatProvider {
  readonly name = 'kimi';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KIMI_API_KEY', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-128k', supportsThinking: false,
  };
  constructor() { super(); this.initClient(); }
}

class QwenProvider extends KodaXOpenAICompatProvider {
  readonly name = 'qwen';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'QWEN_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max', supportsThinking: false,
  };
  constructor() { super(); this.initClient(); }
}

class ZhipuProvider extends KodaXOpenAICompatProvider {
  readonly name = 'zhipu';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'ZHIPU_API_KEY', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', supportsThinking: false,
  };
  constructor() { super(); this.initClient(); }
}

// ============== Provider 工厂 ==============

export const KODAX_PROVIDERS: Record<string, () => KodaXBaseProvider> = {
  anthropic: () => new AnthropicProvider(),
  openai: () => new OpenAIProvider(),
  kimi: () => new KimiProvider(),
  'kimi-code': () => new KimiCodeProvider(),
  qwen: () => new QwenProvider(),
  zhipu: () => new ZhipuProvider(),
  'zhipu-coding': () => new ZhipuCodingProvider(),
  'minimax-coding': () => new MiniMaxCodingProvider(),
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
  try {
    const provider = getProvider(name);
    return provider.isConfigured();
  } catch {
    return false;
  }
}

// 获取 Provider 使用的模型名称
export function getProviderModel(name: string): string | null {
  try {
    const provider = getProvider(name);
    return provider.getModel();
  } catch {
    return null;
  }
}

// 获取所有可用的 Provider 列表（带配置状态）
export function getProviderList(): Array<{ name: string; model: string; configured: boolean }> {
  const result: Array<{ name: string; model: string; configured: boolean }> = [];
  for (const [name, factory] of Object.entries(KODAX_PROVIDERS)) {
    try {
      const p = factory();
      result.push({ name, model: p.getModel(), configured: p.isConfigured() });
    } catch {
      result.push({ name, model: 'unknown', configured: false });
    }
  }
  return result;
}
