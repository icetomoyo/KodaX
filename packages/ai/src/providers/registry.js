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
import { CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE, cloneCapabilityProfile, NATIVE_PROVIDER_CAPABILITY_PROFILE, } from './capability-profile.js';
import Anthropic from '@anthropic-ai/sdk';
// ============== 具体 Provider 实现 ==============
class AnthropicProvider extends KodaXAnthropicCompatProvider {
    name = 'anthropic';
    config = {
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        model: 'claude-sonnet-4-6',
        models: [
            { id: 'claude-opus-4-6', displayName: 'Opus 4.6', thinkingBudgetCap: 28000 },
            { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', thinkingBudgetCap: 10000 },
        ],
        supportsThinking: true,
        reasoningCapability: 'native-budget',
        contextWindow: 200000, // 200K tokens
        maxOutputTokens: 32768,
        thinkingBudgetCap: 28000,
    };
    constructor() { super(); this.client = new Anthropic({ apiKey: this.getApiKey() }); }
}
class ZhipuCodingProvider extends KodaXAnthropicCompatProvider {
    name = 'zhipu-coding';
    config = {
        apiKeyEnv: 'ZHIPU_API_KEY',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        model: 'glm-5',
        models: [
            { id: 'glm-5-turbo', displayName: 'GLM-5 Turbo' },
            { id: 'glm-4.7', displayName: 'GLM-4.7' },
        ],
        supportsThinking: true,
        reasoningCapability: 'native-budget',
        contextWindow: 200000,
        maxOutputTokens: 32768,
        thinkingBudgetCap: 16000,
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
        reasoningCapability: 'native-budget',
        contextWindow: 256000,
        maxOutputTokens: 32768,
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
        reasoningCapability: 'native-budget',
        contextWindow: 204800,
        maxOutputTokens: 32768,
    };
    constructor() { super(); this.initClient(); }
}
class OpenAIProvider extends KodaXOpenAICompatProvider {
    name = 'openai';
    config = {
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
    name = 'deepseek';
    config = {
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
        maxOutputTokens: 64000,
    };
    constructor() { super(); this.initClient(); }
}
class KimiProvider extends KodaXOpenAICompatProvider {
    name = 'kimi';
    config = {
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
    name = 'qwen';
    config = {
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
    name = 'zhipu';
    config = {
        apiKeyEnv: 'ZHIPU_API_KEY',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-5',
        models: [
            { id: 'glm-5-turbo', displayName: 'GLM-5 Turbo' },
            { id: 'glm-4.7', displayName: 'GLM-4.7' },
        ],
        supportsThinking: true,
        reasoningCapability: 'native-budget',
        contextWindow: 200000,
        maxOutputTokens: 32768,
    };
    constructor() { super(); this.initClient(); }
}
// ============== Provider 工厂 ==============
export const KODAX_PROVIDERS = {
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
export const KODAX_PROVIDER_SNAPSHOTS = {
    anthropic: {
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        model: 'claude-sonnet-4-6',
        models: ['claude-opus-4-6', 'claude-haiku-4-5'],
        reasoningCapability: 'native-budget',
        capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
    },
    openai: {
        apiKeyEnv: 'OPENAI_API_KEY',
        model: 'gpt-5.3-codex',
        models: ['gpt-5.4', 'gpt-5.3-codex-spark'],
        reasoningCapability: 'native-effort',
        capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
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
        models: ['glm-5-turbo', 'glm-4.7'],
        reasoningCapability: 'native-budget',
        capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
    },
    'zhipu-coding': {
        apiKeyEnv: 'ZHIPU_API_KEY',
        model: 'glm-5',
        models: ['glm-5-turbo', 'glm-4.7'],
        reasoningCapability: 'native-budget',
        capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
    },
    'minimax-coding': {
        apiKeyEnv: 'MINIMAX_API_KEY',
        model: 'MiniMax-M2.5',
        reasoningCapability: 'native-budget',
        capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE,
    },
    'gemini-cli': {
        apiKeyEnv: 'GEMINI_API_KEY',
        model: 'gemini-cli',
        reasoningCapability: 'prompt-only',
        capabilityProfile: CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
    },
    'codex-cli': {
        apiKeyEnv: 'OPENAI_API_KEY',
        model: 'codex-cli',
        reasoningCapability: 'prompt-only',
        capabilityProfile: CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
    },
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
    if (!isProviderName(name)) {
        return false;
    }
    return !!process.env[KODAX_PROVIDER_SNAPSHOTS[name].apiKeyEnv];
}
// 获取 Provider 使用的模型名称
export function getProviderModel(name) {
    return isProviderName(name)
        ? KODAX_PROVIDER_SNAPSHOTS[name].model
        : null;
}
export function getProviderConfiguredReasoningCapability(name, modelOverride) {
    if (!isProviderName(name)) {
        return 'unknown';
    }
    const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
    const effectiveModel = modelOverride ?? snapshot.model;
    return snapshot.modelReasoningCapabilities?.[effectiveModel]
        ?? snapshot.reasoningCapability;
}
export function getProviderConfiguredCapabilityProfile(name) {
    return isProviderName(name)
        ? cloneCapabilityProfile(KODAX_PROVIDER_SNAPSHOTS[name].capabilityProfile)
        : null;
}
// 获取所有可用的 Provider 列表（带配置状态）
export function getProviderList() {
    const result = [];
    for (const name of Object.keys(KODAX_PROVIDERS)) {
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
export function getProviderModels(name) {
    const snapshot = KODAX_PROVIDER_SNAPSHOTS[name];
    if (!snapshot)
        return [];
    return snapshot.models ? [snapshot.model, ...snapshot.models] : [snapshot.model];
}
// 类型守卫函数：检查字符串是否为有效的 Provider 名称
export function isProviderName(name) {
    return name in KODAX_PROVIDERS;
}
//# sourceMappingURL=registry.js.map