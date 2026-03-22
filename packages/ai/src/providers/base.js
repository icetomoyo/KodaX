/**
 * KodaX Base Provider
 *
 * Provider 抽象基类 - 所有 Provider 的公共基础
 */
import { getReasoningCapability, normalizeReasoningRequest, } from '../reasoning.js';
import { KodaXError, KodaXRateLimitError, KodaXProviderError } from '../errors.js';
import { cloneCapabilityProfile, NATIVE_PROVIDER_CAPABILITY_PROFILE, } from './capability-profile.js';
import {
    buildReasoningOverrideKey,
    loadReasoningOverride,
    reasoningCapabilityToOverride,
    reasoningOverrideToCapability,
    saveReasoningOverride,
} from '../reasoning-overrides.js';
export class KodaXBaseProvider {
    isConfigured() {
        return !!process.env[this.config.apiKeyEnv];
    }
    getModel() {
        return this.config.model;
    }
    getAvailableModels() {
        if (!this.config.models?.length)
            return [this.config.model];
        return [...new Set([this.config.model, ...this.config.models.map(m => m.id)])];
    }
    getModelDescriptor(modelId) {
        if (!modelId || modelId === this.config.model) {
            return { id: this.config.model };
        }
        return this.config.models?.find(m => m.id === modelId);
    }
    getBaseUrl() {
        return this.config.baseUrl;
    }
    getCapabilityProfile() {
        return cloneCapabilityProfile(this.config.capabilityProfile ?? NATIVE_PROVIDER_CAPABILITY_PROFILE);
    }
    getConfiguredReasoningCapability(modelOverride) {
        const descriptor = this.getModelDescriptor(modelOverride);
        if (descriptor?.reasoningCapability) {
            return descriptor.reasoningCapability;
        }
        return getReasoningCapability(this.config);
    }
    getReasoningCapability(modelOverride) {
        const override = loadReasoningOverride(this.name, this.config, modelOverride);
        return override
            ? reasoningOverrideToCapability(override)
            : this.getConfiguredReasoningCapability(modelOverride);
    }
    getReasoningOverride(modelOverride) {
        return loadReasoningOverride(this.name, this.config, modelOverride);
    }
    getReasoningOverrideKey(modelOverride) {
        return buildReasoningOverrideKey(this.name, this.config, modelOverride);
    }
    persistReasoningCapabilityOverride(capability, modelOverride) {
        const override = reasoningCapabilityToOverride(capability);
        if (!override) {
            return;
        }
        saveReasoningOverride(this.name, this.config, override, modelOverride);
    }
    shouldFallbackForReasoningError(error, ...terms) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        const normalizedTerms = terms.map(term => term.toLowerCase());
        const matchesSpecificTerm = normalizedTerms.some((term) => message.includes(term));
        const mentionsParameter = message.includes('parameter') || matchesSpecificTerm;
        return (message.includes('unknown parameter') ||
            message.includes('invalid parameter') ||
            (message.includes('unsupported') && mentionsParameter));
    }
    getReasoningFallbackChain(capability) {
        switch (capability) {
            case 'native-budget':
                return ['native-budget', 'native-toggle', 'none'];
            case 'native-effort':
                return ['native-effort', 'none'];
            case 'native-toggle':
                return ['native-toggle', 'none'];
            case 'none':
            case 'prompt-only':
            case 'unknown':
            default:
                return ['none'];
        }
    }
    /**
     * 获取模型的上下文窗口大小
     * @returns 上下文窗口大小 (tokens)
     */
    getContextWindow() {
        return this.config.contextWindow ?? 200000; // 默认 200k
    }
    getApiKey() {
        const key = process.env[this.config.apiKeyEnv];
        if (!key)
            throw new Error(`${this.config.apiKeyEnv} not set`);
        return key;
    }
    normalizeReasoning(reasoning) {
        return normalizeReasoningRequest(reasoning);
    }
    isRateLimitError(error) {
        if (!(error instanceof Error))
            return false;
        const s = error.message.toLowerCase();
        return ['rate', 'limit', '速率', '频率', '1302', '429', 'too many'].some(k => s.includes(k));
    }
    async withRateLimit(fn, signal, retries = 3, onRateLimit) {
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            }
            catch (e) {
                if (this.isRateLimitError(e)) {
                    const delay = (i + 1) * 2000;
                    // 最后一次重试失败，抛出错误
                    if (i === retries - 1) {
                        throw new KodaXRateLimitError(`API rate limit exceeded after ${retries} retries. Please wait and try again later.`, 60000);
                    }
                    // 显示重试信息
                    if (onRateLimit) {
                        onRateLimit(i + 1, retries, delay);
                    }
                    else {
                        console.log(`[Rate Limit] Retrying in ${delay / 1000}s (${i + 1}/${retries})...`);
                    }
                    // 检查是否已被取消
                    if (signal?.aborted) {
                        throw new DOMException('Request aborted', 'AbortError');
                    }
                    // 等待后再重试
                    await new Promise(resolve => setTimeout(resolve, delay));
                    // 等待后再次检查（防止等待期间被取消）
                    if (signal?.aborted) {
                        throw new DOMException('Request aborted', 'AbortError');
                    }
                    // 继续循环，执行下一次 fn()
                    continue;
                }
                // 对于其他错误，包装成 Provider 错误
                if (e instanceof Error) {
                    // 区分用户主动取消和网络层面的 Abort 
                    // (包含标准的 AbortError 以及部分 SDK 特有的 APIUserAbortError)
                    if ((e.name === 'AbortError' || e.name === 'APIUserAbortError') && signal?.aborted) {
                        // 将其规范化为 AbortError 抛出，让分类器将其统一识别为 USER_ABORT
                        if (e.name === 'AbortError') {
                            throw e;
                        }
                        throw new DOMException(e.message || 'Request aborted', 'AbortError');
                    }
                    throw new KodaXProviderError(`${this.name} API error: ${e.message}`, this.name);
                }
                throw e;
            }
        }
        // TypeScript 需要返回值，但这个代码理论上不会被执行
        throw new KodaXError('Unexpected end of withRateLimit');
    }
}
//# sourceMappingURL=base.js.map
