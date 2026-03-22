/**
 * KodaX Anthropic Compatible Provider
 *
 * 支持 Anthropic API 格式的 Provider 基类
 */

import Anthropic from '@anthropic-ai/sdk';
import { KodaXBaseProvider } from './base.js';
import { KodaXProviderError } from '../errors.js';
import {
  KodaXContentBlock,
  KodaXProviderConfig,
  KodaXMessage,
  KodaXToolDefinition,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
} from '../types.js';
import { KODAX_MAX_TOKENS } from '../constants.js';
import {
  clampThinkingBudget,
  resolveThinkingBudget,
} from '../reasoning.js';

export abstract class KodaXAnthropicCompatProvider extends KodaXBaseProvider {
  abstract override readonly name: string;
  readonly supportsThinking = true;
  protected abstract override readonly config: KodaXProviderConfig;
  protected client!: Anthropic;

  protected initClient(): void {
    this.client = new Anthropic({ apiKey: this.getApiKey(), baseURL: this.config.baseUrl });
  }

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal
  ): Promise<KodaXStreamResult> {
    return this.withRateLimit(async () => {
      const normalizedReasoning = this.normalizeReasoning(reasoning);
      const maxOutputTokens = this.config.maxOutputTokens ?? KODAX_MAX_TOKENS;
      const model = streamOptions?.modelOverride ?? this.config.model;
      const initialCapability = normalizedReasoning.enabled
        ? this.getReasoningCapability(model)
        : 'none';
      const attempts: Array<'native-budget' | 'native-toggle' | 'none'> = normalizedReasoning.enabled
        ? this.getReasoningFallbackChain(initialCapability)
            .filter((capability): capability is 'native-budget' | 'native-toggle' | 'none' =>
              capability === 'native-budget' ||
              capability === 'native-toggle' ||
              capability === 'none',
            )
        : ['none'];

      const buildRequest = (
        capability: 'native-budget' | 'native-toggle' | 'none',
      ): Anthropic.Messages.MessageCreateParams => {
        const kwargs: Anthropic.Messages.MessageCreateParams = {
          model,
          max_tokens: maxOutputTokens,
          system: this.buildSystemPrompt(system, messages),
          messages: this.convertMessages(messages),
          tools: tools as Anthropic.Messages.Tool[],
          stream: true,
        };

        if (capability === 'native-budget') {
          const requestedBudget = resolveThinkingBudget(
            this.config,
            normalizedReasoning.depth,
            normalizedReasoning.taskType,
          );
          kwargs.thinking = {
            type: 'enabled',
            budget_tokens: clampThinkingBudget(requestedBudget, maxOutputTokens),
          };
        } else if (capability === 'native-toggle') {
          kwargs.thinking = {
            type: 'enabled',
          } as Anthropic.Messages.ThinkingConfigParam;
        }

        return kwargs;
      };

      // 检查是否已被取消
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }

      const textBlocks: KodaXTextBlock[] = [];
      const toolBlocks: KodaXToolUseBlock[] = [];
      const thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[] = [];

      let currentBlockType: string | null = null;
      let currentText = '';
      let currentThinking = '';
      let currentThinkingSignature = '';
      let currentToolId = '';
      let currentToolName = '';
      let currentToolInput = '';

      // Issue 084 fix: Track message completion to detect silent disconnections
      let messageStopReceived = false;
      let lastEventTime = Date.now();
      const streamStartTime = Date.now();

      // 传递 signal 给 SDK，确保底层 HTTP 请求能被取消
      // 参考: https://github.com/anthropics/anthropic-sdk-typescript
      let response: Awaited<ReturnType<typeof this.client.messages.create>> | undefined;
      let lastError: unknown;

      for (const capability of attempts) {
        try {
          response = await this.client.messages.create(
            buildRequest(capability),
            signal ? { signal } : {},
          );
          if (capability !== initialCapability) {
            this.persistReasoningCapabilityOverride(capability, model);
          }
          break;
        } catch (error) {
          lastError = error;
          const fallbackTerms =
            capability === 'native-budget'
              ? ['budget_tokens', 'thinking']
              : capability === 'native-toggle'
                ? ['thinking']
                : [];

          if (!this.shouldFallbackForReasoningError(error, ...fallbackTerms)) {
            throw error;
          }
        }
      }

      if (!response) {
        throw lastError ?? new KodaXProviderError(
          'All reasoning capability attempts failed without a captured error',
          this.name,
        );
      }

      for await (const event of response as AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>) {
        // 检查是否被中断 (双重保险)
        if (signal?.aborted) {
          throw new DOMException('Request aborted', 'AbortError');
        }

        if (event.type === 'content_block_start') {
          lastEventTime = Date.now();
          const block = event.content_block;
          currentBlockType = block.type;

          // Debug: Log tool_use block start
          if (process.env.KODAX_DEBUG_TOOL_STREAM && block.type === 'tool_use') {
            console.error('[ToolStream] content_block_start:', {
              type: block.type,
              id: (block as any).id,
              name: (block as any).name
            });
          }

          if (block.type === 'thinking') {
            currentThinking = '';
            currentThinkingSignature = (block as any).signature ?? '';
          } else if (block.type === 'redacted_thinking') {
            currentBlockType = 'redacted_thinking';
          } else if (block.type === 'text') {
            currentText = '';
          } else if (block.type === 'tool_use') {
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolInput = '';
          }
        } else if (event.type === 'content_block_delta') {
          lastEventTime = Date.now();
          const delta = event.delta as any;
          if (delta.type === 'thinking_delta') {
            currentThinking += delta.thinking ?? '';
            streamOptions?.onThinkingDelta?.(delta.thinking ?? '');
          } else if (delta.type === 'text_delta') {
            currentText += delta.text ?? '';
            streamOptions?.onTextDelta?.(delta.text ?? '');
          } else if (delta.type === 'input_json_delta') {
            currentToolInput += delta.partial_json ?? '';
            streamOptions?.onToolInputDelta?.(currentToolName, delta.partial_json ?? '');
          }
        } else if (event.type === 'content_block_stop') {
          lastEventTime = Date.now();  // Issue 084: Track last event time
          if (currentBlockType === 'thinking') {
            if (currentThinking) {
              thinkingBlocks.push({ type: 'thinking', thinking: currentThinking, signature: currentThinkingSignature });
              // thinking block 结束时通知 CLI 层
              streamOptions?.onThinkingEnd?.(currentThinking);
            }
          } else if (currentBlockType === 'redacted_thinking') {
            const block = (event as any).content_block;
            if (block?.data) {
              thinkingBlocks.push({ type: 'redacted_thinking', data: block.data });
            }
          } else if (currentBlockType === 'text') {
            if (currentText) textBlocks.push({ type: 'text', text: currentText });
          } else if (currentBlockType === 'tool_use') {
            // CRITICAL FIX: Validate tool_use has non-empty id and name
            // Prevents "tool_call_id is not found" errors with empty id
            if (!currentToolId || !currentToolName) {
              console.error('[Tool Block Invalid] Missing tool id or name:', {
                id: JSON.stringify(currentToolId),
                name: JSON.stringify(currentToolName),
                input: currentToolInput.slice(0, 100)
              });
              // Skip this invalid tool_use block - do not add to toolBlocks
            } else {
              try {
                const input = currentToolInput ? JSON.parse(currentToolInput) : {};
                toolBlocks.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input });
              } catch (parseError) {
                console.error('[Tool Block Parse Error] Failed to parse input JSON:', {
                  id: currentToolId,
                  name: currentToolName,
                  error: parseError
                });
                // Still add the tool_use with empty input to maintain consistency
                toolBlocks.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input: {} });
              }
            }
          }
          currentBlockType = null;
        } else if (event.type === 'message_stop') {
          // Issue 084 fix: Mark message as complete
          messageStopReceived = true;
          lastEventTime = Date.now();
          if (process.env.KODAX_DEBUG_STREAM) {
            const duration = Date.now() - streamStartTime;
            console.error(`[Stream] message_stop received after ${duration}ms`);
          }
        } else if (event.type === 'message_delta') {
          // Issue 084 fix: Track message_delta events (contain stop_reason, usage)
          lastEventTime = Date.now();
          if (process.env.KODAX_DEBUG_STREAM) {
            const delta = (event as any).delta;
            if (delta?.stop_reason) {
              console.error(`[Stream] message_delta with stop_reason: ${delta.stop_reason}`);
            }
          }
        } else if (event.type === 'message_start') {
          // Issue 084 fix: Track message start
          lastEventTime = Date.now();
          if (process.env.KODAX_DEBUG_STREAM) {
            console.error('[Stream] message_start received');
          }
        }
      }

      // Issue 084 fix: Validate stream completed successfully
      // If message_stop was never received, the stream was likely interrupted
      if (!messageStopReceived) {
        const duration = Date.now() - streamStartTime;
        const lastEventAge = Date.now() - lastEventTime;

        // If our upstream caller already aborted the request, surface it as an abort
        // instead of a generic incomplete stream so the retry classifier can distinguish
        // watchdog/user cancellation from provider-side truncation.
        if (signal?.aborted) {
          const reason = signal.reason instanceof Error
            ? signal.reason.message
            : typeof signal.reason === 'string'
              ? signal.reason
              : 'Request aborted';
          console.error('[Stream] Stream ended after abort before message_stop:', {
            duration,
            lastEventAge,
            reason,
            textBlocks: textBlocks.length,
            toolBlocks: toolBlocks.length,
            thinkingBlocks: thinkingBlocks.length
          });
          throw new DOMException(reason, 'AbortError');
        }

        const error = new Error(
          `Stream incomplete: message_stop event not received. ` +
          `Duration: ${duration}ms, Last event: ${lastEventAge}ms ago. ` +
          `This may indicate a network disconnection or API timeout.`
        );
        error.name = 'StreamIncompleteError';
        console.error('[Stream] Incomplete stream detected:', {
          duration,
          lastEventAge,
          textBlocks: textBlocks.length,
          toolBlocks: toolBlocks.length,
          thinkingBlocks: thinkingBlocks.length
        });
        throw error;
      }

      return { textBlocks, toolBlocks, thinkingBlocks };
    }, signal, 3, streamOptions?.onRateLimit);
  }

  private serializeSystemMessageContent(content: string | KodaXContentBlock[]): string {
    if (typeof content === 'string') {
      return content.trim();
    }

    return content
      .filter((block): block is KodaXTextBlock => block.type === 'text')
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join('\n');
  }

  private buildSystemPrompt(baseSystem: string, messages: KodaXMessage[]): string {
    const inlineSystemMessages = messages
      .filter((message) => message.role === 'system')
      .map((message) => this.serializeSystemMessageContent(message.content))
      .filter(Boolean);

    return [baseSystem, ...inlineSystemMessages]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n');
  }

  private convertMessages(messages: KodaXMessage[]): Anthropic.Messages.MessageParam[] {
    // Filter out 'system' role messages - Anthropic API only supports 'user' and 'assistant' in messages array
    // System messages are handled via the separate 'system' parameter
    return messages.filter(m => m.role !== 'system').map(m => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const content: Anthropic.Messages.ContentBlockParam[] = [];

      // CRITICAL: Anthropic requires tool_result to be FIRST in user messages
      // Order must be: thinking -> tool_result -> tool_use -> text
      // Reference: https://docs.anthropic.com/en/docs/build-with-claude/tool-use

      // 1. thinking blocks (must be first for assistant messages)
      for (const b of m.content) {
        if (b.type === 'thinking') {
          content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature ?? '' } as any);
        } else if (b.type === 'redacted_thinking') {
          content.push({ type: 'redacted_thinking', data: b.data } as any);
        }
      }

      // 2. tool_result MUST come before text in user messages
      for (const b of m.content) {
        if (b.type === 'tool_result' && m.role === 'user') {
          content.push({
            type: 'tool_result',
            tool_use_id: b.tool_use_id,
            content: b.content,
            ...(b.is_error === true ? { is_error: true } : {}),
          } as Anthropic.Messages.ToolResultBlockParam);
        }
      }

      // 3. tool_use in assistant messages
      for (const b of m.content) {
        if (b.type === 'tool_use' && m.role === 'assistant') {
          content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        }
      }

      // 4. text blocks (must come after tool_result in user messages)
      for (const b of m.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
      }

      return { role: m.role, content };
    }) as Anthropic.Messages.MessageParam[];
  }
}
