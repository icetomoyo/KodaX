/**
 * KodaX Provider Registry
 *
 * Provider 注册表 - 统一管理所有 Provider
 */
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { KodaXGeminiCliProvider } from './gemini-cli.js';
import { KodaXCodexCliProvider } from './codex-cli.js';
import { KodaXProviderError } from '../errors.js';
import Anthropic from '@anthropic-ai/sdk';
// ============== 具体 Provider 实现 ==============
class AnthropicProvider extends KodaXAnthropicCompatProvider {
    name = 'anthropic';
    config = {
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        model: 'claude-sonnet-4-6',
        supportsThinking: true,
        contextWindow: 200000, // 200K tokens
    };
    constructor() { super(); this.client = new Anthropic({ apiKey: this.getApiKey() }); }
}
class ZhipuCodingProvider extends KodaXAnthropicCompatProvider {
    name = 'zhipu-coding';
    config = {
        apiKeyEnv: 'ZHIPU_API_KEY',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        model: 'glm-5',
        supportsThinking: true,
        contextWindow: 200000,
    };
    constructor() { super(); this.initClient(); }
}
class KimiCodeProvider extends KodaXAnthropicCompatProvider {
    name = 'kimi-code';
    config = {
        apiKeyEnv: 'KIMI_API_KEY',
        baseUrl: 'https://api.kimi.com/coding/',
        model: 'k2.5',
        supportsThinking: true,
        contextWindow: 256000,
    };
    constructor() { super(); this.initClient(); }
}
class MiniMaxCodingProvider extends KodaXAnthropicCompatProvider {
    name = 'minimax-coding';
    config = {
        apiKeyEnv: 'MINIMAX_API_KEY',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        model: 'MiniMax-M2.5',
        supportsThinking: true,
        contextWindow: 204800,
    };
    constructor() { super(); this.initClient(); }
}
class OpenAIProvider extends KodaXOpenAICompatProvider {
    name = 'openai';
    config = {
        apiKeyEnv: 'OPENAI_API_KEY',
        model: 'gpt-5.3-codex',
        supportsThinking: false,
        contextWindow: 400000,
    };
    constructor() { super(); this.initClient(); }
}
class KimiProvider extends KodaXOpenAICompatProvider {
    name = 'kimi';
    config = {
        apiKeyEnv: 'KIMI_API_KEY',
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'moonshot-v1-128k',
        supportsThinking: false,
        contextWindow: 128000,
    };
    constructor() { super(); this.initClient(); }
}
class QwenProvider extends KodaXOpenAICompatProvider {
    name = 'qwen';
    config = {
        apiKeyEnv: 'QWEN_API_KEY',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.5-plus',
        supportsThinking: false,
        contextWindow: 256000,
    };
    constructor() { super(); this.initClient(); }
}
class ZhipuProvider extends KodaXOpenAICompatProvider {
    name = 'zhipu';
    config = {
        apiKeyEnv: 'ZHIPU_API_KEY',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-5',
        supportsThinking: false,
        contextWindow: 200000,
    };
    constructor() { super(); this.initClient(); }
}
// ============== Provider 工厂 ==============
export const KODAX_PROVIDERS = {
    anthropic: () => new AnthropicProvider(),
    openai: () => new OpenAIProvider(),
    kimi: () => new KimiProvider(),
    'kimi-code': () => new KimiCodeProvider(),
    qwen: () => new QwenProvider(),
    zhipu: () => new ZhipuProvider(),
    'zhipu-coding': () => new ZhipuCodingProvider(),
    'minimax-coding': () => new MiniMaxCodingProvider(),
    'gemini-cli': () => new KodaXGeminiCliProvider(),
    'codex-cli': () => new KodaXCodexCliProvider(),
};
export const KODAX_DEFAULT_PROVIDER = process.env.KODAX_PROVIDER ?? 'zhipu-coding';
export function getProvider(name) {
    const n = name ?? KODAX_DEFAULT_PROVIDER;
    const factory = KODAX_PROVIDERS[n];
    if (!factory)
        throw new KodaXProviderError(`Unknown provider: ${n}. Available: ${Object.keys(KODAX_PROVIDERS).join(', ')}`, n);
    return factory();
}
// 检查 Provider 是否已配置 API Key
export function isProviderConfigured(name) {
    try {
        const provider = getProvider(name);
        return provider.isConfigured();
    }
    catch {
        return false;
    }
}
// 获取 Provider 使用的模型名称
export function getProviderModel(name) {
    try {
        const provider = getProvider(name);
        return provider.getModel();
    }
    catch {
        return null;
    }
}
// 获取所有可用的 Provider 列表（带配置状态）
export function getProviderList() {
    const result = [];
    for (const [name, factory] of Object.entries(KODAX_PROVIDERS)) {
        try {
            const p = factory();
            result.push({ name, model: p.getModel(), configured: p.isConfigured() });
        }
        catch {
            result.push({ name, model: 'unknown', configured: false });
        }
    }
    return result;
}
// 类型守卫函数：检查字符串是否为有效的 Provider 名称
export function isProviderName(name) {
    return name in KODAX_PROVIDERS;
}
//# sourceMappingURL=registry.js.map