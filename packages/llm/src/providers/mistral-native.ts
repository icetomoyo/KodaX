import { prepareProviderPayload } from './request-extensions.js';
import type { KodaXAssistantBlock, KodaXProviderConfig, KodaXStreamResult, KodaXTokenUsage, KodaXToolUseBlock } from '../types.js';
import { observeProviderStreamUsage } from '../provider-request-observation.js';
import { KodaXNativeProvider, type NativeRequest } from './native-provider.js';
import { projectMistralMessages } from './mistral-messages.js';
import { nativeResponse } from './native-http.js';
import { readCloudSSE } from './cloud-sse.js';
import { resolvePromptCacheDisabled } from '../run-scoped-config.js';
import { openAIChatTools } from './tool-constraints.js';

interface ContentPart { type: string; text?: string; thinking?: { type?: string; text?: string }[] }
interface Delta { content?: string | ContentPart[] | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }[] }
interface Completion { choices?: { delta?: Delta; message?: Delta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }

export class KodaXMistralProvider extends KodaXNativeProvider {
  constructor(name: string, config: KodaXProviderConfig) { super(name, config, 'mistral-chat'); }
  override usesPromptCacheAffinity(): boolean { return this.config.promptCacheAffinity === true; }
  protected async invoke(request: NativeRequest): Promise<KodaXStreamResult> {
    const key = this.usesPromptCacheAffinity() && !resolvePromptCacheDisabled() ? request.options?.promptCacheKey : undefined;
    const profile = request.profile;
    const effort = request.disabled && profile?.effortStrategy === 'openai-chat-effort' ? 'none' : request.effort;
    if (request.disabled && profile?.effortStrategy === 'provider-toggle') throw this.protocolError('Mistral prompt_mode has no documented off control.');
    const reasoning = !effort ? {} : profile?.effortStrategy === 'openai-chat-effort'
      ? { reasoning_effort: effort } : profile?.effortStrategy === 'provider-toggle' ? { prompt_mode: 'reasoning' } : {};
    if (Object.keys(reasoning).length) request.sentReasoningEffort = effort;
    const response = await nativeResponse(`${this.config.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: request.signal, headers: { authorization: `Bearer ${this.getApiKey()}`, 'content-type': 'application/json', ...(key ? { 'x-affinity': key } : {}) },
      body: JSON.stringify(await prepareProviderPayload({ model: request.model, messages: [...(request.system ? [{ role: 'system', content: request.system }] : []),
        ...await projectMistralMessages(request.messages, request.source, this.getCapabilityProfile().multimodalSupport !== 'none')],
      stream: request.streaming, max_tokens: request.maxOutputTokens, ...reasoning, ...(key ? { prompt_cache_key: key } : {}),
      ...(request.tools.length ? { tools: openAIChatTools(request.tools, request.toolCapabilities, this.name) } : {}),
      ...(request.options?.forcedToolName ? { tool_choice: { type: 'function', function: { name: request.options.forcedToolName } } } : {}) })) });
    return this.consume(request, response);
  }
  private async consume(request: NativeRequest, response: Response): Promise<KodaXStreamResult> {
    const blocks: KodaXAssistantBlock[] = [];
    const tools = new Map<number, { block: KodaXToolUseBlock; args: string | Record<string, unknown> }>();
    let terminal: string | undefined;
    let usage: KodaXTokenUsage | undefined;
    const values = request.streaming ? readCloudSSE(response, request.signal) : (async function* () { yield await response.json() as unknown; })();
    for await (const raw of values) {
      request.signal?.throwIfAborted();
      request.options?.onHeartbeat?.();
      const event = raw as Completion;
      if (!event || typeof event !== 'object') throw this.protocolError('Invalid Mistral event.');
      if (event.usage) {
        const u = event.usage;
        usage = { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0), cachedReadTokens: u.prompt_tokens_details?.cached_tokens };
        observeProviderStreamUsage(usage);
      }
      const choice = event.choices?.[0];
      const delta = choice?.delta ?? choice?.message;
      if (terminal && (delta?.content || delta?.tool_calls?.length)) throw this.protocolError('Mistral content followed its terminal.');
      if (delta) this.consumeDelta(request, blocks, tools, delta);
      if (choice?.finish_reason) {
        if (terminal && terminal !== choice.finish_reason) throw this.protocolError('Conflicting Mistral terminals.');
        terminal = choice.finish_reason;
      }
    }
    if (terminal !== 'stop' && terminal !== 'tool_calls') throw this.protocolError(`Mistral response did not complete: ${terminal ?? 'missing terminal'}`, !terminal);
    const seen = new Set<string>();
    for (const { block, args } of tools.values()) {
      if (!/^[A-Za-z0-9]{9}$/.test(block.id) || !block.name || seen.has(block.id)) throw this.protocolError('Invalid Mistral tool identity.');
      seen.add(block.id);
      let value: unknown;
      try { value = typeof args === 'string' ? JSON.parse(args) as unknown : args; } catch { throw this.protocolError('Invalid Mistral tool arguments.'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw this.protocolError('Mistral tool arguments require an object.');
      block.input = value as Record<string, unknown>;
    }
    return this.finish(request, blocks, usage, 'end_turn');
  }
  private consumeDelta(request: NativeRequest, blocks: KodaXAssistantBlock[], tools: Map<number, { block: KodaXToolUseBlock; args: string | Record<string, unknown> }>, delta: Delta): void {
    if (delta.content != null && typeof delta.content !== 'string' && !Array.isArray(delta.content)) throw this.protocolError('Invalid Mistral content.');
    if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) throw this.protocolError('Invalid Mistral tool calls.');
    const parts = typeof delta.content === 'string' ? [{ type: 'text', text: delta.content }] : delta.content ?? [];
    for (const part of parts) {
      if (part.type !== 'text' && part.type !== 'thinking') throw this.protocolError('Unsupported Mistral content.');
      if ((part.type === 'text' && typeof part.text !== 'string') || (part.type === 'thinking' && (!Array.isArray(part.thinking)
        || part.thinking.some(p => !p || (p.text !== undefined && typeof p.text !== 'string'))))) throw this.protocolError('Invalid Mistral text chunk.');
      const text = part.type === 'text' ? part.text : part.thinking?.map(p => p.text ?? '').join('');
      if (!text) continue;
      const previous = blocks.at(-1);
      if (part.type === 'thinking') {
        if (previous?.type === 'thinking') previous.thinking += text; else blocks.push({ type: 'thinking', thinking: text, source: request.source });
        if (request.streaming) request.options?.onThinkingDelta?.(text);
      } else {
        if (previous?.type === 'text') previous.text += text; else blocks.push({ type: 'text', text });
        if (request.streaming) request.options?.onTextDelta?.(text);
      }
    }
    for (const [position, call] of (delta.tool_calls ?? []).entries()) {
      if (!call || (call.id !== undefined && typeof call.id !== 'string') || (call.function?.name !== undefined && typeof call.function.name !== 'string')) throw this.protocolError('Invalid Mistral tool identity.');
      const index = call.index ?? position;
      if (!Number.isSafeInteger(index) || index < 0) throw this.protocolError('Invalid Mistral tool index.');
      let entry = tools.get(index);
      if (!entry) { entry = { block: { type: 'tool_use', id: call.id ?? '', name: call.function?.name ?? '', input: {} }, args: '' }; tools.set(index, entry); blocks.push(entry.block); }
      if (call.id) { if (entry.block.id && entry.block.id !== call.id) throw this.protocolError('Changed Mistral tool identity.'); entry.block.id = call.id; }
      if (call.function?.name) {
        if (entry.block.name && entry.block.name !== call.function.name) throw this.protocolError('Changed Mistral tool name.');
        entry.block.name = call.function.name;
      }
      const args = call.function?.arguments;
      if (args !== undefined) {
        if (typeof args === 'string' && typeof entry.args === 'string') entry.args += args;
        else if (typeof args === 'object' && entry.args === '') entry.args = args;
        else throw this.protocolError('Conflicting Mistral argument representations.');
        if (request.streaming) request.options?.onToolInputDelta?.(entry.block.name, typeof args === 'string' ? args : JSON.stringify(args), { toolId: entry.block.id });
      }
    }
  }
}
