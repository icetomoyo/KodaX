/**
 * KodaX OpenAI Compatible Provider
 *
 * 支持 OpenAI API 格式的 Provider 基类
 */

import OpenAI from 'openai';
import { KodaXBaseProvider } from './base.js';
import { KodaXProviderConfig, KodaXMessage, KodaXToolDefinition, KodaXProviderStreamOptions, KodaXStreamResult, KodaXTextBlock, KodaXToolUseBlock } from '../types.js';
import { KODAX_MAX_TOKENS } from '../constants.js';

export abstract class KodaXOpenAICompatProvider extends KodaXBaseProvider {
  abstract override readonly name: string;
  readonly supportsThinking = false;
  protected abstract override readonly config: KodaXProviderConfig;
  protected client!: OpenAI;

  protected initClient(): void {
    this.client = new OpenAI({ apiKey: this.getApiKey(), baseURL: this.config.baseUrl });
  }

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    _thinking = false,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal
  ): Promise<KodaXStreamResult> {
    return this.withRateLimit(async () => {
      const fullMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: system },
        ...this.convertMessages(messages),
      ];
      const openaiTools = tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));

      // 检查是否已被取消
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }

      const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
      let textContent = '';

      // 传递 signal 给 SDK，确保底层 HTTP 请求能被取消
      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages: fullMessages,
        tools: openaiTools,
        max_tokens: KODAX_MAX_TOKENS,
        stream: true,
      }, signal ? { signal } : {});

      for await (const chunk of stream) {
        // 检查是否被中断 (双重保险)
        if (signal?.aborted) {
          throw new DOMException('Request aborted', 'AbortError');
        }

        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          textContent += delta.content;
          streamOptions?.onTextDelta?.(delta.content);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallsMap.get(tc.index) ?? { id: '', name: '', arguments: '' };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
              streamOptions?.onToolInputDelta?.(existing.name, tc.function.arguments);
            }
            toolCallsMap.set(tc.index, existing);
          }
        }
      }

      const textBlocks: KodaXTextBlock[] = textContent ? [{ type: 'text', text: textContent }] : [];
      const toolBlocks: KodaXToolUseBlock[] = [];
      for (const [, tc] of toolCallsMap) {
        if (tc.id && tc.name) {
          try { toolBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: JSON.parse(tc.arguments) }); }
          catch { toolBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: {} }); }
        }
      }
      return { textBlocks, toolBlocks, thinkingBlocks: [] };
    });
  }

  private convertMessages(messages: KodaXMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map(m => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const text = (m.content as { type: 'text'; text: string }[]).filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('\n');
      return { role: m.role, content: text };
    });
  }
}
