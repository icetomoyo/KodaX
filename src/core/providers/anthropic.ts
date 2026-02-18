/**
 * KodaX Anthropic Compatible Provider
 *
 * 支持 Anthropic API 格式的 Provider 基类
 */

import Anthropic from '@anthropic-ai/sdk';
import { KodaXBaseProvider } from './base.js';
import { KodaXProviderConfig, KodaXMessage, KodaXToolDefinition, KodaXProviderStreamOptions, KodaXStreamResult, KodaXTextBlock, KodaXToolUseBlock, KodaXThinkingBlock, KodaXRedactedThinkingBlock } from '../types.js';
import { KODAX_MAX_TOKENS } from '../constants.js';

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
    thinking = false,
    streamOptions?: KodaXProviderStreamOptions
  ): Promise<KodaXStreamResult> {
    return this.withRateLimit(async () => {
      const kwargs: Anthropic.Messages.MessageCreateParams = {
        model: this.config.model,
        max_tokens: KODAX_MAX_TOKENS,
        system,
        messages: this.convertMessages(messages),
        tools: tools as Anthropic.Messages.Tool[],
        stream: true,
      };
      if (thinking) kwargs.thinking = { type: 'enabled', budget_tokens: 10000 };

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

      const response = await this.client.messages.create(kwargs);

      for await (const event of response as AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>) {
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          currentBlockType = block.type;
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
            try {
              const input = currentToolInput ? JSON.parse(currentToolInput) : {};
              toolBlocks.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input });
            } catch {
              toolBlocks.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input: {} });
            }
          }
          currentBlockType = null;
        }
      }

      return { textBlocks, toolBlocks, thinkingBlocks };
    });
  }

  private convertMessages(messages: KodaXMessage[]): Anthropic.Messages.MessageParam[] {
    return messages.map(m => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const content: Anthropic.Messages.ContentBlockParam[] = [];
      // thinking blocks 必须放在最前面
      for (const b of m.content) {
        if (b.type === 'thinking') {
          content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature ?? '' } as any);
        } else if (b.type === 'redacted_thinking') {
          content.push({ type: 'redacted_thinking', data: b.data } as any);
        }
      }
      for (const b of m.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
      }
      for (const b of m.content) {
        if (b.type === 'tool_use' && m.role === 'assistant') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        else if (b.type === 'tool_result' && m.role === 'user') content.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content });
      }
      return { role: m.role, content } as Anthropic.Messages.MessageParam;
    });
  }
}
