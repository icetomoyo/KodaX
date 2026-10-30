import type { KodaXAssistantBlock, KodaXProviderConfig, KodaXStreamResult, KodaXTokenUsage } from '../types.js';
import { observeProviderStreamUsage } from '../provider-request-observation.js';
import { KodaXNativeProvider, type NativeRequest } from './native-provider.js';
import { nativeResponse } from './native-http.js';
import { readCloudSSE } from './cloud-sse.js';
import { piBlockHash, projectPiMessages } from './pi-messages-history.js';
import { resolvePromptCacheDisabled } from '../run-scoped-config.js';

interface PiEvent {
  type: string; contentIndex?: number; delta?: string; content?: string; contentSignature?: string; redacted?: boolean;
  id?: string; toolName?: string; toolCall?: { id?: string; name?: string; arguments?: unknown; argumentsError?: string };
  reason?: string; errorMessage?: string; responseId?: string; responseModel?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens?: number; [key: string]: unknown };
}
interface PendingPart { block: KodaXAssistantBlock; ended: boolean }
export class KodaXPiMessagesProvider extends KodaXNativeProvider {
  constructor(name: string, config: KodaXProviderConfig) { super(name, config, 'pi-messages'); }
  override supportsNonStreamingFallback(): boolean { return false; }
  protected async invoke(request: NativeRequest): Promise<KodaXStreamResult> {
    const cacheOff = resolvePromptCacheDisabled();
    const messages = await projectPiMessages(request.messages, request.source, this.getCapabilityProfile().multimodalSupport !== 'none');
    const response = await nativeResponse(`${this.config.baseUrl!.replace(/\/$/, '')}/messages`, {
      method: 'POST', signal: request.signal, headers: { authorization: `Bearer ${this.getApiKey()}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model: request.model, context: { messages: [{ role: 'system', content: request.system,
        toolsAdded: request.tools.map(t => ({ name: t.name, description: t.description, parameters: t.input_schema })), timestamp: 0 }, ...messages] },
      options: { maxTokens: request.maxOutputTokens, ...(request.effort ? { reasoning: request.effort } : {}),
        ...(cacheOff ? { cacheRetention: 'none' } : {}),
        ...(this.config.promptCacheAffinity && !cacheOff && request.options?.promptCacheKey ? { sessionId: request.options.promptCacheKey } : {}),
        ...(request.options?.forcedToolName ? { toolChoice: { type: 'function', function: { name: request.options.forcedToolName } } } : {}) } }) });
    return this.consume(request, response);
  }
  private async consume(request: NativeRequest, response: Response): Promise<KodaXStreamResult> {
    const parts: PendingPart[] = [];
    let started = false, terminal = false;
    let usage: KodaXTokenUsage | undefined;
    const ids = new Set<string>();
    for await (const raw of readCloudSSE(response, request.signal)) {
      request.signal?.throwIfAborted();
      request.options?.onHeartbeat?.();
      const event = raw as PiEvent;
      if (!event || typeof event !== 'object' || typeof event.type !== 'string' || terminal) throw this.protocolError('Invalid Pi Messages event after terminal.');
      if (event.usage) {
        const u = event.usage;
        usage = { inputTokens: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), outputTokens: u.output ?? 0,
          cachedReadTokens: u.cacheRead, cachedWriteTokens: u.cacheWrite, thoughtTokens: u.reasoning,
          totalTokens: u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) };
        observeProviderStreamUsage(usage);
      }
      if (event.type === 'start') { if (started) throw this.protocolError('Duplicate Pi Messages start.'); started = true; continue; }
      if (!started) throw this.protocolError('Pi Messages content precedes start.');
      if (event.type === 'error') throw this.protocolError(event.errorMessage ?? 'Pi Messages upstream error.');
      if (event.type === 'done') {
        if (!['stop', 'toolUse'].includes(event.reason ?? '') || parts.some(p => !p.ended)) throw this.protocolError('Pi Messages response is incomplete.');
        this.attachReplayMetadata(parts, event);
        terminal = true; continue;
      }
      const index = event.contentIndex;
      if (!Number.isSafeInteger(index) || index! < 0 || index! > parts.length) throw this.protocolError('Invalid Pi Messages content index.');
      if (event.type.endsWith('_start')) {
        if (index !== parts.length) throw this.protocolError('Duplicate Pi Messages block.');
        const block: KodaXAssistantBlock = event.type === 'text_start' ? { type: 'text', text: '' }
          : event.type === 'thinking_start' ? { type: 'thinking', thinking: '', source: request.source }
          : event.type === 'toolcall_start' && typeof event.id === 'string' && event.id.trim() && typeof event.toolName === 'string' && event.toolName.trim()
            ? { type: 'tool_use', id: event.id, name: event.toolName, input: {} }
          : (() => { throw this.protocolError('Invalid Pi Messages block start.'); })();
        if (block.type === 'tool_use') { if (ids.has(block.id)) throw this.protocolError('Duplicate Pi Messages tool ID.'); ids.add(block.id); }
        parts.push({ block, ended: false }); continue;
      }
      const part = parts[index!];
      if (!part || part.ended) throw this.protocolError('Pi Messages event has no open block.');
      this.updatePart(request, part, event);
    }
    if (!terminal) throw this.protocolError('Pi Messages stream has no terminal.', true);
    return this.finish(request, parts.map(p => p.block), usage, 'end_turn');
  }
  private attachReplayMetadata(parts: PendingPart[], event: PiEvent): void {
    if (!event.usage || !['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => typeof event.usage?.[key] === 'number')
      || !event.usage.cost || typeof event.usage.cost !== 'object') return;
    const message = { usage: event.usage, stopReason: event.reason!, timestamp: Date.now(),
      ...(event.responseId ? { responseId: event.responseId } : {}), ...(event.responseModel ? { responseModel: event.responseModel } : {}) };
    for (const part of parts) if (part.block.piPart) part.block.piPart.message = message;
  }
  private updatePart(request: NativeRequest, part: PendingPart, event: PiEvent): void {
    const block = part.block;
    const prefix = block.type === 'text' ? 'text' : block.type === 'thinking' ? 'thinking' : 'toolcall';
    if (event.type === `${prefix}_delta`) {
      if (typeof event.delta !== 'string') throw this.protocolError('Invalid Pi Messages delta.');
      if (block.type === 'text') { block.text += event.delta; if (request.streaming) request.options?.onTextDelta?.(event.delta); }
      if (block.type === 'thinking') { block.thinking += event.delta; if (request.streaming) request.options?.onThinkingDelta?.(event.delta); }
      if (block.type === 'tool_use' && request.streaming) request.options?.onToolInputDelta?.(block.name, event.delta, { toolId: block.id });
      return;
    }
    if (event.type !== `${prefix}_end`) throw this.protocolError('Pi Messages block event type mismatch.');
    if (event.contentSignature !== undefined && typeof event.contentSignature !== 'string') throw this.protocolError('Invalid Pi Messages signature.');
    if (block.type === 'tool_use') {
      const tool = event.toolCall;
      if (!tool || tool.id !== block.id || tool.name !== block.name || tool.argumentsError || !tool.arguments || typeof tool.arguments !== 'object' || Array.isArray(tool.arguments)) throw this.protocolError('Invalid Pi Messages final tool arguments.');
      block.input = tool.arguments as Record<string, unknown>;
    } else {
      if (typeof event.content !== 'string') throw this.protocolError('Invalid Pi Messages final content.');
      if (event.redacted !== undefined && (typeof event.redacted !== 'boolean' || block.type !== 'thinking')) throw this.protocolError('Invalid Pi Messages redaction.');
      if (event.redacted && !event.contentSignature) throw this.protocolError('Redacted Pi Messages thinking requires its opaque signature.');
      if (block.type === 'text') block.text = event.content;
      if (block.type === 'thinking') block.thinking = event.content;
      if (event.redacted) part.block = { type: 'redacted_thinking', data: event.contentSignature ?? '', source: request.source };
    }
    part.ended = true;
    part.block.piPart = { source: request.source, contentHash: piBlockHash(part.block), ...(event.contentSignature ? { contentSignature: event.contentSignature } : {}) };
  }
}
