/**
 * KodaX Provider Registry
 *
 * Provider registry - unified provider management
 */
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { KodaXGeminiCliProvider } from './gemini-cli.js';
import { KodaXCodexCliProvider } from './codex-cli.js';
import { KodaXProviderError } from '../errors.js';
import { CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE, cloneCapabilityProfile, NATIVE_PROVIDER_CAPABILITY_PROFILE } from './capability-profile.js';
import Anthropic from '@anthropic-ai/sdk';
class AnthropicProvider extends KodaXAnthropicCompatProvider {
    name = 'anthropic';
    config = {
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        model: 'claude-sonnet-4-6',
        supportsThinking: true,
        reasoningCapability: 'native-budget',
        contextWindow: 200000,
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
        supportsThinking: true,
        reasoningCapability: 'native-effort',
        contextWindow: 400000,
        maxOutputTokens: 32768,
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
        supportsThinking: true,
        reasoningCapability: 'native-budget',
        contextWindow: 200000,
        maxOutputTokens: 32768,
    };
    constructor() { super(); this.initClient(); }
}
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
export const KODAX_PROVIDER_SNAPSHOTS = {
    anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-6', reasoningCapability: 'native-budget', capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE },
    openai: { apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-5.3-codex', reasoningCapability: 'native-effort', capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE },
    kimi: { apiKeyEnv: 'KIMI_API_KEY', model: 'k2.5', reasoningCapability: 'native-effort', capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE },
    'kimi-code': { apiKeyEnv: 'KIMI_API_KEY', model: 'k2.5', reasoningCapability: 'native-budget', capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE },
    qwen: { apiKeyEnv: 'QWEN_API_KEY', model: 'qwen3.5-plus', reasoningCapability: 'native-budget', capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE },
    zhipu: { apiKeyEnv: 'ZHIPU_API_KEY', model: 'glm-5', reasoningCapability: 'native-budget', capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE },
    'zhipu-coding': { apiKeyEnv: 'ZHIPU_API_KEY', model: 'glm-5', reasoningCapability: 'native-budget', capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE },
    'minimax-coding': { apiKeyEnv: 'MINIMAX_API_KEY', model: 'MiniMax-M2.5', reasoningCapability: 'native-budget', capabilityProfile: NATIVE_PROVIDER_CAPABILITY_PROFILE },
    'gemini-cli': { apiKeyEnv: 'GEMINI_API_KEY', model: 'gemini-cli', reasoningCapability: 'prompt-only', capabilityProfile: CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE },
    'codex-cli': { apiKeyEnv: 'OPENAI_API_KEY', model: 'codex-cli', reasoningCapability: 'prompt-only', capabilityProfile: CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE },
};
export const KODAX_DEFAULT_PROVIDER = process.env.KODAX_PROVIDER ?? 'zhipu-coding';
export function getProvider(name) {
    const n = name ?? KODAX_DEFAULT_PROVIDER;
    const factory = KODAX_PROVIDERS[n];
    if (!factory) {
        throw new KodaXProviderError(`Unknown provider: ${n}. Available: ${Object.keys(KODAX_PROVIDERS).join(', ')}`, n);
    }
    return factory();
}
export function isProviderName(name) {
    return name in KODAX_PROVIDERS;
}
export function isProviderConfigured(name) {
    if (!isProviderName(name)) {
        return false;
    }
    return !!process.env[KODAX_PROVIDER_SNAPSHOTS[name].apiKeyEnv];
}
export function getProviderModel(name) {
    return isProviderName(name)
        ? KODAX_PROVIDER_SNAPSHOTS[name].model
        : null;
}
export function getProviderConfiguredReasoningCapability(name) {
    return isProviderName(name)
        ? KODAX_PROVIDER_SNAPSHOTS[name].reasoningCapability
        : 'unknown';
}
export function getProviderConfiguredCapabilityProfile(name) {
    return isProviderName(name)
        ? cloneCapabilityProfile(KODAX_PROVIDER_SNAPSHOTS[name].capabilityProfile)
        : null;
}
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
