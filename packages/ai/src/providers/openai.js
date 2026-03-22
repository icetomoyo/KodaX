/**
 * KodaX OpenAI Compatible Provider
 *
 * 支持 OpenAI API 格式的 Provider 基类
 */
import OpenAI from 'openai';
import { KodaXBaseProvider } from './base.js';
import { KodaXProviderError } from '../errors.js';
import { KODAX_MAX_TOKENS } from '../constants.js';
import { clampThinkingBudget, isReasoningEnabled, mapDepthToOpenAIReasoningEffort, resolveThinkingBudget, } from '../reasoning.js';
export class KodaXOpenAICompatProvider extends KodaXBaseProvider {
    supportsThinking = true;
    client;
    initClient() {
        this.client = new OpenAI({ apiKey: this.getApiKey(), baseURL: this.config.baseUrl });
    }
    appendExtraBody(params, extraBody) {
        const current = typeof params.extra_body === 'object' && params.extra_body !== null
            ? params.extra_body
            : {};
        params.extra_body = {
            ...current,
            ...extraBody,
        };
    }
    applyReasoningCapability(createParams, capability, reasoning) {
        // The OpenAI SDK types do not expose provider-specific extensions like
        // Qwen's extra_body or Zhipu's thinking block, so we intentionally attach
        // those fields on the raw request object here.
        const params = createParams;
        const maxOutputTokens = this.config.maxOutputTokens ?? KODAX_MAX_TOKENS;
        const requestedBudget = clampThinkingBudget(resolveThinkingBudget(this.config, reasoning.depth, reasoning.taskType), maxOutputTokens);
        switch (capability) {
            case 'native-effort': {
                const reasoningEffort = mapDepthToOpenAIReasoningEffort(reasoning.depth);
                if (reasoningEffort) {
                    params.reasoning_effort = reasoningEffort;
                }
                break;
            }
            case 'native-budget': {
                if (this.name === 'qwen') {
                    this.appendExtraBody(params, {
                        enable_thinking: true,
                        thinking_budget: requestedBudget,
                    });
                }
                else if (this.name === 'zhipu') {
                    params.thinking = {
                        type: 'enabled',
                        budget_tokens: requestedBudget,
                    };
                }
                break;
            }
            case 'native-toggle': {
                if (this.name === 'qwen') {
                    this.appendExtraBody(params, {
                        enable_thinking: true,
                    });
                }
                else if (this.name === 'zhipu') {
                    params.thinking = {
                        type: 'enabled',
                    };
                }
                else if (this.name === 'deepseek' &&
                    createParams.model === 'deepseek-chat') {
                    this.appendExtraBody(params, {
                        thinking: {
                            type: 'enabled',
                        },
                    });
                }
                break;
            }
            default:
                break;
        }
    }
    getFallbackTerms(capability) {
        switch (capability) {
            case 'native-budget':
                return ['thinking_budget', 'budget_tokens', 'thinking'];
            case 'native-effort':
                return ['reasoning_effort'];
            case 'native-toggle':
                return ['enable_thinking', 'thinking'];
            default:
                return [];
        }
    }
    async stream(messages, tools, system, reasoning, streamOptions, signal) {
        return this.withRateLimit(async () => {
            const fullMessages = [
                { role: 'system', content: system },
                ...this.convertMessages(messages),
            ];
            const openaiTools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
            // 检查是否已被取消
            if (signal?.aborted) {
                throw new DOMException('Request aborted', 'AbortError');
            }
            const toolCallsMap = new Map();
            let textContent = '';
            let thinkingContent = '';
            // Issue 084 fix: Track stream completion
            let finishReason = null;
            const streamStartTime = Date.now();
            // 传递 signal 给 SDK，确保底层 HTTP 请求能被取消
            const normalizedReasoning = this.normalizeReasoning(reasoning);
            const model = streamOptions?.modelOverride ?? this.config.model;
            const initialCapability = isReasoningEnabled(normalizedReasoning)
                ? this.getReasoningCapability(model)
                : 'none';
            const attempts = isReasoningEnabled(normalizedReasoning)
                ? this.getReasoningFallbackChain(initialCapability)
                    .filter((capability) => capability === 'native-budget' ||
                    capability === 'native-effort' ||
                    capability === 'native-toggle' ||
                    capability === 'none')
                : ['none'];
            const createParams = {
                model,
                messages: fullMessages,
                tools: openaiTools,
                max_completion_tokens: this.config.maxOutputTokens ?? KODAX_MAX_TOKENS,
                stream: true,
            };
            let stream;
            let lastError;
            for (const capability of attempts) {
                const attemptParams = {
                    ...createParams,
                };
                this.applyReasoningCapability(attemptParams, capability, normalizedReasoning);
                try {
                    stream = await this.client.chat.completions.create(attemptParams, signal ? { signal } : {});
                    if (capability !== initialCapability) {
                        this.persistReasoningCapabilityOverride(capability, model);
                    }
                    break;
                }
                catch (error) {
                    lastError = error;
                    if (!this.shouldFallbackForReasoningError(error, ...this.getFallbackTerms(capability))) {
                        throw error;
                    }
                }
            }
            if (!stream) {
                throw lastError ?? new KodaXProviderError('All reasoning capability attempts failed without a captured error', this.name);
            }
            for await (const chunk of stream) {
                // 检查是否被中断 (双重保险)
                if (signal?.aborted) {
                    throw new DOMException('Request aborted', 'AbortError');
                }
                const choice = chunk.choices[0];
                const delta = choice?.delta;
                // Issue 084 fix: Track finish_reason to detect stream completion
                if (choice?.finish_reason) {
                    finishReason = choice.finish_reason;
                    if (process.env.KODAX_DEBUG_STREAM) {
                        const duration = Date.now() - streamStartTime;
                        console.error(`[Stream] finish_reason: ${finishReason} after ${duration}ms`);
                    }
                }
                if (delta?.content) {
                    textContent += delta.content;
                    streamOptions?.onTextDelta?.(delta.content);
                }
                const reasoningDelta = this.extractReasoningDelta(delta);
                if (reasoningDelta) {
                    thinkingContent += reasoningDelta;
                    streamOptions?.onThinkingDelta?.(reasoningDelta);
                }
                if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const existing = toolCallsMap.get(tc.index) ?? { id: '', name: '', arguments: '' };
                        if (tc.id)
                            existing.id = tc.id;
                        if (tc.function?.name)
                            existing.name = tc.function.name;
                        if (tc.function?.arguments) {
                            existing.arguments += tc.function.arguments;
                            streamOptions?.onToolInputDelta?.(existing.name, tc.function.arguments);
                        }
                        toolCallsMap.set(tc.index, existing);
                    }
                }
            }
            // Issue 084 fix: Validate stream completed successfully
            // If finish_reason was never received, the stream was likely interrupted
            if (!finishReason) {
                const duration = Date.now() - streamStartTime;
                if (signal?.aborted) {
                    const reason = signal.reason instanceof Error
                        ? signal.reason.message
                        : typeof signal.reason === 'string'
                            ? signal.reason
                            : 'Request aborted';
                    console.error('[Stream] Stream ended after abort before finish_reason:', {
                        duration,
                        reason,
                        textContentLength: textContent.length,
                        toolCallsCount: toolCallsMap.size
                    });
                    throw new DOMException(reason, 'AbortError');
                }
                const error = new Error(`Stream incomplete: finish_reason not received. ` +
                    `Duration: ${duration}ms. ` +
                    `This may indicate a network disconnection or API timeout.`);
                error.name = 'StreamIncompleteError';
                console.error('[Stream] Incomplete stream detected:', {
                    duration,
                    textContentLength: textContent.length,
                    toolCallsCount: toolCallsMap.size
                });
                throw error;
            }
            const textBlocks = textContent ? [{ type: 'text', text: textContent }] : [];
            const toolBlocks = [];
            const thinkingBlocks = [];
            if (thinkingContent) {
                thinkingBlocks.push({ type: 'thinking', thinking: thinkingContent });
                streamOptions?.onThinkingEnd?.(thinkingContent);
            }
            for (const [, tc] of toolCallsMap) {
                if (tc.id && tc.name) {
                    try {
                        toolBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: JSON.parse(tc.arguments) });
                    }
                    catch {
                        toolBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: {} });
                    }
                }
            }
            return { textBlocks, toolBlocks, thinkingBlocks };
        }, signal, 3, streamOptions?.onRateLimit);
    }
    extractReasoningDelta(delta) {
        const raw = delta?.reasoning_content;
        if (typeof raw === 'string') {
            return raw;
        }
        if (!Array.isArray(raw)) {
            return '';
        }
        return raw
            .map((part) => {
            if (typeof part === 'string') {
                return part;
            }
            if (typeof part === 'object' &&
                part !== null &&
                'text' in part &&
                typeof part.text === 'string') {
                return part.text;
            }
            return '';
        })
            .join('');
    }
    serializeAssistantMessage(contentBlocks) {
        const text = contentBlocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
        const toolCalls = contentBlocks
            .filter((block) => block.type === 'tool_use')
            .map((block) => ({
            id: block.id,
            type: 'function',
            function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
            },
        }));
        const thinking = contentBlocks
            .filter((block) => block.type === 'thinking' || block.type === 'redacted_thinking')
            .map((block) => block.type === 'thinking' ? block.thinking : '')
            .filter(Boolean)
            .join('\n\n');
        if (!text && toolCalls.length === 0) {
            return [];
        }
        const message = {
            role: 'assistant',
            content: text || null,
        };
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
            if (this.name === 'deepseek' && thinking) {
                message.reasoning_content = thinking;
            }
        }
        return [message];
    }
    serializeUserMessage(contentBlocks) {
        const results = [];
        const text = contentBlocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
        for (const block of contentBlocks) {
            if (block.type === 'tool_result') {
                results.push({
                    role: 'tool',
                    tool_call_id: block.tool_use_id,
                    content: block.content,
                });
            }
        }
        if (text) {
            results.push({
                role: 'user',
                content: text,
            });
        }
        return results;
    }
    serializeSystemMessage(content) {
        if (typeof content === 'string') {
            return [{
                    role: 'system',
                    content,
                }];
        }
        const text = content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
        return text
            ? [{
                    role: 'system',
                    content: text,
                }]
            : [];
    }
    convertMessages(messages) {
        return messages.flatMap((message) => {
            if (message.role === 'system') {
                return this.serializeSystemMessage(message.content);
            }
            if (typeof message.content === 'string') {
                return [{
                        role: message.role,
                        content: message.content,
                    }];
            }
            if (message.role === 'assistant') {
                return this.serializeAssistantMessage(message.content);
            }
            return this.serializeUserMessage(message.content);
        });
    }
}
//# sourceMappingURL=openai.js.map
