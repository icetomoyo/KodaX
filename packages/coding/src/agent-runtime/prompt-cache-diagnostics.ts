import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type {
  KodaXBaseProvider,
  KodaXContentBlock,
  KodaXEphemeralSuffix,
  KodaXMessage,
  KodaXReasoningRequest,
  KodaXTokenUsage,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import {
  KodaXAnthropicCompatProvider,
  KodaXAcpProvider,
  KodaXOpenAICompatProvider,
  KODAX_INTERRUPTED_TOOL_RESULT_MARKER,
  resolvePromptCacheDisabled,
} from '@kodax-ai/llm';
import type {
  CompactionProviderObserver,
  CompactionProviderRequest,
} from '@kodax-ai/agent';

import type {
  KodaXEvents,
  KodaXPromptCacheDiagnosticEvent,
} from '../types.js';
import { emitResilienceDebug } from './resilience-debug.js';

function hashPromptCacheValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
}

function hashImageFile(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return `unreadable:${hashPromptCacheValue(path)}`;
  }
}

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function resolveDiagnosticImageMediaType(filePath: string, fallback?: string): string {
  return fallback
    ?? IMAGE_MEDIA_TYPES[path.extname(filePath).toLowerCase()]
    ?? 'image/png';
}

function projectImage(block: Extract<KodaXContentBlock, { type: 'image' }>): unknown {
  return {
    type: 'image',
    mediaType: resolveDiagnosticImageMediaType(block.path, block.mediaType),
    dataHash: hashImageFile(block.path),
  };
}

function projectToolResultContent(
  block: Extract<KodaXContentBlock, { type: 'tool_result' }>,
): unknown {
  if (typeof block.content === 'string') return block.content;
  return block.content.map((item) => item.type === 'image'
    ? {
        type: 'image',
        mediaType: resolveDiagnosticImageMediaType(item.path, item.mediaType),
        dataHash: hashImageFile(item.path),
      }
    : { type: 'text', text: item.text });
}

function projectProviderVisibleBlock(block: KodaXContentBlock): unknown | undefined {
  switch (block.type) {
    case 'cache-boundary':
      return undefined;
    case 'image':
      return projectImage(block);
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: projectToolResultContent(block),
        ...(block.is_error === true ? { is_error: true } : {}),
      };
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.signature !== undefined ? { signature: block.signature } : {}),
      };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data };
  }
}

function projectGenericMessages(messages: readonly KodaXMessage[]): readonly unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : message.content
          .map(projectProviderVisibleBlock)
          .filter((block): block is unknown => block !== undefined),
  }));
}

interface DiagnosticOpenAIWireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: unknown;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: 'function';
    readonly function: {
      readonly name: string;
      readonly arguments: string;
    };
  }[];
  readonly reasoning_content?: string;
}

function diagnosticImageMissing(filePath: string): boolean {
  try { statSync(filePath); return false; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return true;
    throw error;
  }
}

function projectOpenAIToolResult(
  block: Extract<KodaXContentBlock, { type: 'tool_result' }>,
  supportsImages: boolean,
  attachments: Map<DiagnosticOpenAIWireMessage, DiagnosticOpenAIWireMessage>,
): DiagnosticOpenAIWireMessage {
  const text: string[] = [];
  const images: unknown[] = [];
  if (typeof block.content === 'string') text.push(block.content);
  else for (const item of block.content) {
    if (item.type === 'text') text.push(item.text);
    else if (diagnosticImageMissing(item.path)) {
      text.push('[Historical image unavailable: the local attachment file is missing.]');
    } else if (supportsImages) images.push({ type: 'image_url',
      mediaType: resolveDiagnosticImageMediaType(item.path, item.mediaType), dataHash: hashImageFile(item.path) });
    else text.push('[Image content omitted: this provider does not support inline images in tool results.]');
  }
  if (images.length > 0) text.push('[Images from this tool result follow in a user message.]');
  const message: DiagnosticOpenAIWireMessage = {
    role: 'tool', tool_call_id: block.tool_use_id, content: text.join('\n'),
  };
  if (images.length > 0) attachments.set(message, { role: 'user', content: [
    { type: 'text', text: `Images from tool result ${block.tool_use_id}:` }, ...images,
  ] });
  return message;
}

function projectOpenAIMessages(
  messages: readonly KodaXMessage[],
  provider: KodaXOpenAICompatProvider,
  model?: string,
): readonly DiagnosticOpenAIWireMessage[] {
  const projected: DiagnosticOpenAIWireMessage[] = [];
  const attachments = new Map<DiagnosticOpenAIWireMessage, DiagnosticOpenAIWireMessage>();
  const multimodal = provider.getCapabilityProfile().multimodalSupport;
  const supportsImages = multimodal === 'image-input' || multimodal === 'full';
  for (const message of messages) {
    if (typeof message.content === 'string') {
      projected.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks = message.content.filter((block) => block.type !== 'cache-boundary');
    if (message.role === 'system') {
      const text = blocks
        .filter((block): block is Extract<KodaXContentBlock, { type: 'text' }> =>
          block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (text) projected.push({ role: 'system', content: text });
      continue;
    }
    if (message.role === 'assistant') {
      const textBlocks = blocks.filter(
        (block): block is Extract<KodaXContentBlock, { type: 'text' }> =>
          block.type === 'text',
      );
      const text = textBlocks.map((block) => block.text).join('\n');
      const toolCalls = blocks
        .filter((block): block is Extract<KodaXContentBlock, { type: 'tool_use' }> =>
          block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          type: 'function' as const,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        }));
      const thinkingBlocks = blocks.filter(
        (block): block is Extract<KodaXContentBlock, { type: 'thinking' }> =>
          block.type === 'thinking',
      );
      const hasThinkingBlock = blocks.some(
        (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
      );
      if (!text && toolCalls.length === 0 && !hasThinkingBlock && textBlocks.length === 0) {
        continue;
      }
      projected.push({
        role: 'assistant',
        content: text || (toolCalls.length > 0 ? null : '...'),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(provider.getEffectiveReplayReasoningContent(model)
          ? { reasoning_content: thinkingBlocks.map((block) => block.thinking).join('\n\n') }
          : {}),
      });
      continue;
    }
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      projected.push(projectOpenAIToolResult(block, supportsImages, attachments));
    }
    const text = blocks
      .filter((block): block is Extract<KodaXContentBlock, { type: 'text' }> =>
        block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const images = blocks.filter(
      (block): block is Extract<KodaXContentBlock, { type: 'image' }> =>
        block.type === 'image',
    );
    if (images.length === 0) {
      if (text) projected.push({ role: 'user', content: text });
      continue;
    }
    projected.push({
      role: 'user',
      content: [
        ...(text ? [{ type: 'text', text }] : []),
        ...images.map((block) => ({
          type: 'image_url',
          mediaType: resolveDiagnosticImageMediaType(block.path, block.mediaType),
          dataHash: hashImageFile(block.path),
        })),
      ],
    });
  }
  return repairOpenAIToolHistory(projected, attachments);
}

function repairOpenAIToolHistory(
  messages: readonly DiagnosticOpenAIWireMessage[],
  attachments: ReadonlyMap<DiagnosticOpenAIWireMessage, DiagnosticOpenAIWireMessage>,
): readonly DiagnosticOpenAIWireMessage[] {
  const repaired: DiagnosticOpenAIWireMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (message.role !== 'assistant') {
      if (message.role !== 'tool') repaired.push(message);
      index += 1;
      continue;
    }
    const validToolCalls = (message.tool_calls ?? []).filter((call) => call.id.trim().length > 0);
    const expectedIds = new Set(validToolCalls.map((call) => call.id));
    const answers = new Map<string, DiagnosticOpenAIWireMessage>();
    const carried: DiagnosticOpenAIWireMessage[] = [];
    let nextIndex = index + 1;
    while (validToolCalls.length > 0 && nextIndex < messages.length && messages[nextIndex]!.role !== 'assistant') {
      const toolMessage = messages[nextIndex]!;
      if (toolMessage.role !== 'tool') {
        carried.push(toolMessage);
      } else if (toolMessage.tool_call_id !== undefined
        && expectedIds.has(toolMessage.tool_call_id)
        && !answers.has(toolMessage.tool_call_id)
      ) {
        answers.set(toolMessage.tool_call_id, toolMessage);
        const images = attachments.get(toolMessage);
        if (images) carried.push(images);
      }
      nextIndex += 1;
    }
    if (validToolCalls.length > 0) {
      repaired.push({ ...message, tool_calls: validToolCalls });
    } else {
      const { tool_calls: _toolCalls, ...withoutToolCalls } = message;
      repaired.push({
        ...withoutToolCalls,
        content: message.content == null || message.content === '' ? '...' : message.content,
      });
    }
    repaired.push(...validToolCalls.map((call) => answers.get(call.id) ?? {
      role: 'tool' as const, tool_call_id: call.id, content: KODAX_INTERRUPTED_TOOL_RESULT_MARKER,
    }), ...carried);
    index = nextIndex;
  }
  return repaired;
}

interface DiagnosticAnthropicWireMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly Readonly<Record<string, unknown>>[];
}

function projectAnthropicMessages(
  messages: readonly KodaXMessage[],
  provider: KodaXAnthropicCompatProvider,
  model?: string,
): readonly DiagnosticAnthropicWireMessage[] {
  const strictSignature = provider.getEffectiveStrictThinkingSignature(model);
  const supportsThinking = provider.getProviderSupportsThinking();
  const projected: DiagnosticAnthropicWireMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'user' ? 'user' : 'assistant';
    if (typeof message.content === 'string') {
      projected.push({ role, content: message.content });
      continue;
    }
    const blocks = message.content.filter((block) => block.type !== 'cache-boundary');
    const content: Array<Readonly<Record<string, unknown>>> = [];
    // Match assistant serialization: keep text/reasoning in source order,
    // then append calls. User messages emit results before ordinary content.
    for (const block of role === 'assistant' ? blocks : []) {
      if (block.type === 'thinking') {
        const trusted = !strictSignature
          || (typeof block.signature === 'string' && block.signature.length > 0);
        if (trusted) {
          content.push({
            type: 'thinking',
            thinking: block.thinking,
            signature: block.signature ?? '',
          });
        } else if (block.thinking) {
          content.push({ type: 'text', text: `<prior_reasoning>\n${block.thinking}\n</prior_reasoning>` });
        }
      } else if (block.type === 'redacted_thinking' && !strictSignature) {
        content.push({ type: 'redacted_thinking', data: block.data });
      } else if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      }
    }
    if (role === 'user') {
      for (const block of blocks) {
        if (block.type !== 'tool_result') continue;
        content.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: projectToolResultContent(block),
          ...(block.is_error === true ? { is_error: true } : {}),
        });
      }
    } else {
      for (const block of blocks) {
        if (block.type !== 'tool_use') continue;
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }
    for (const block of role === 'user' ? blocks : []) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && role === 'user') {
        content.push(projectImage(block) as Readonly<Record<string, unknown>>);
      }
    }
    if (
      role === 'assistant'
      && supportsThinking
      && !strictSignature
      && content.some((block) => block.type === 'tool_use')
      && !content.some((block) =>
        block.type === 'thinking' || block.type === 'redacted_thinking')
    ) {
      content.unshift({ type: 'thinking', thinking: '...', signature: '' });
    }
    const effectivelyEmpty = content.length === 0 || content.every((block) =>
      (block.type === 'thinking' && !block.thinking)
      || (block.type === 'text' && !block.text));
    projected.push({
      role,
      content: effectivelyEmpty ? [{ type: 'text', text: '...' }] : content,
    });
  }
  return repairAnthropicToolHistory(projected);
}

function repairAnthropicToolHistory(
  messages: readonly DiagnosticAnthropicWireMessage[],
): readonly DiagnosticAnthropicWireMessage[] {
  const repaired: DiagnosticAnthropicWireMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (typeof message.content === 'string') {
      repaired.push(message);
      continue;
    }
    const filtered = message.content.filter((block) => message.role === 'assistant'
      ? block.type !== 'tool_use' || !!block.id : block.type !== 'tool_result');
    if (filtered.length > 0 || filtered.length === message.content.length) {
      repaired.push({ ...message, content: filtered });
    } else if (message.role === 'assistant') {
      repaired.push({ ...message, content: [{ type: 'text', text: '...' }] });
    }
    if (message.role !== 'assistant') continue;
    const callIds = message.content.flatMap((block) => block.type === 'tool_use'
      && typeof block.id === 'string' && block.id.trim().length > 0 ? [block.id] : []);
    if (callIds.length === 0) continue;
    const answers = new Map<string, Readonly<Record<string, unknown>>>();
    const carried: Readonly<Record<string, unknown>>[] = [];
    while (index + 1 < messages.length && messages[index + 1]!.role !== 'assistant') {
      const next = messages[++index]!;
      const blocks = typeof next.content === 'string' ? [{ type: 'text', text: next.content }] : next.content;
      for (const block of blocks) {
        if (block.type !== 'tool_result') carried.push(block);
        else if (typeof block.tool_use_id === 'string' && callIds.includes(block.tool_use_id)
          && !answers.has(block.tool_use_id)) answers.set(block.tool_use_id, block);
      }
    }
    repaired.push({ role: 'user', content: [
      ...callIds.map((id) => answers.get(id) ?? {
        type: 'tool_result', tool_use_id: id, content: KODAX_INTERRUPTED_TOOL_RESULT_MARKER, is_error: true,
      }), ...carried,
    ] });
  }
  return repaired;
}

export function hashProviderVisibleMessages(
  messages: readonly KodaXMessage[],
  provider?: KodaXBaseProvider,
  model?: string,
): string {
  const projected = provider instanceof KodaXOpenAICompatProvider
    ? projectOpenAIMessages(messages, provider, model)
    : provider instanceof KodaXAnthropicCompatProvider
      ? projectAnthropicMessages(messages, provider, model)
      : provider instanceof KodaXAcpProvider
        ? provider.getDiagnosticPromptText(messages)
      : projectGenericMessages(messages);
  return hashPromptCacheValue(projected);
}

function serializeSystemContentForDiagnostics(
  content: KodaXMessage['content'],
  trimInlineSystem: boolean,
): string {
  if (typeof content === 'string') return trimInlineSystem ? content.trim() : content;
  const text = content
    .filter((block): block is Extract<KodaXContentBlock, { type: 'text' }> =>
      block.type === 'text')
    .map((block) => trimInlineSystem ? block.text.trim() : block.text)
    .filter((value) => !trimInlineSystem || value.length > 0)
    .join('\n');
  return text.trim().length > 0 ? text : '';
}

export function normalizeDiagnosticEnvelope(
  system: string,
  messages: readonly KodaXMessage[],
  provider?: KodaXBaseProvider,
): { readonly system: string; readonly messages: readonly KodaXMessage[] } {
  const trimInlineSystem = provider instanceof KodaXAnthropicCompatProvider;
  const systemParts = system.trim().length > 0 ? [system] : [];
  const nonSystemMessages: KodaXMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'system') {
      nonSystemMessages.push(message);
      continue;
    }
    const text = serializeSystemContentForDiagnostics(message.content, trimInlineSystem);
    if (text.length > 0) systemParts.push(text);
  }
  return {
    system: systemParts.join('\n\n'),
    messages: nonSystemMessages,
  };
}

function findCurrentTurnStart(messages: readonly KodaXMessage[]): number {
  const currentTurnId = [...messages]
    .reverse()
    .find((message) => message.turnId !== undefined)
    ?.turnId;
  if (currentTurnId !== undefined) {
    const turnStart = messages.findIndex((message) => message.turnId === currentTurnId);
    if (turnStart >= 0) return turnStart;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user' || message._synthetic === true) continue;
    let start = index;
    while (start > 0 && messages[start - 1]?.role === 'user') start -= 1;
    return start;
  }
  return messages.length;
}

function sanitizeProviderEndpoint(
  endpoint: string | undefined,
): { readonly origin: string; readonly pathHash: string } | undefined {
  if (!endpoint) return undefined;
  try {
    const parsed = new URL(endpoint);
    return {
      origin: parsed.origin,
      pathHash: hashPromptCacheValue(`${parsed.pathname}${parsed.search}`),
    };
  } catch {
    return undefined;
  }
}

export interface PromptCacheDiagnosticRequestInput {
  readonly events: KodaXEvents | undefined;
  readonly enabled: boolean;
  readonly provider: KodaXBaseProvider;
  readonly providerName: string;
  readonly contextId?: string;
  readonly contextKind?: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
  readonly model: string;
  readonly reasoning: boolean | KodaXReasoningRequest | undefined;
  readonly disablePromptCache: boolean | undefined;
  readonly system: string;
  readonly tools: readonly KodaXToolDefinition[];
  readonly messages: readonly KodaXMessage[];
  readonly ephemeralSuffix?: KodaXEphemeralSuffix;
  readonly promptCacheKey?: string;
  readonly attempt: number;
  readonly transport?: 'stream' | 'complete';
}

export interface CompactionPromptCacheObserverInput {
  readonly events: KodaXEvents | undefined;
  readonly enabled: boolean;
  readonly provider: KodaXBaseProvider;
  readonly providerName: string;
  readonly contextId?: string;
  readonly contextKind?: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
  readonly model: string;
  readonly disablePromptCache: boolean | undefined;
}

export function createCompactionPromptCacheObserver(
  input: CompactionPromptCacheObserverInput,
): CompactionProviderObserver | undefined {
  if (!input.enabled) return undefined;
  const pending = new WeakMap<object, KodaXPromptCacheDiagnosticEvent>();
  return {
    onRequest(request: CompactionProviderRequest) {
      const event = emitPromptCacheDiagnosticRequest({
        events: input.events,
        enabled: true,
        provider: input.provider,
        providerName: input.providerName,
        ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
        ...(input.contextKind !== undefined ? { contextKind: input.contextKind } : {}),
        ...(input.parentContextId !== undefined
          ? { parentContextId: input.parentContextId }
          : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        model: request.modelOverride ?? input.model,
        reasoning: request.reasoning,
        disablePromptCache: input.disablePromptCache,
        system: request.system,
        tools: request.tools,
        messages: request.messages,
        ...(request.ephemeralSuffix ? { ephemeralSuffix: request.ephemeralSuffix } : {}),
        ...(request.promptCacheKey ? { promptCacheKey: request.promptCacheKey } : {}),
        attempt: 1,
      });
      if (event) pending.set(request, event);
    },
    onResponse(request: CompactionProviderRequest, usage: KodaXTokenUsage | undefined) {
      emitPromptCacheDiagnosticResponse(input.events, pending.get(request), usage);
      pending.delete(request);
    },
  };
}

export function emitPromptCacheDiagnosticRequest(
  input: PromptCacheDiagnosticRequestInput,
): KodaXPromptCacheDiagnosticEvent | undefined {
  if (!input.enabled) return undefined;
  let event: KodaXPromptCacheDiagnosticEvent;
  try {
    if (!input.events?.onPromptCacheDiagnostics) return undefined;
    const diagnosticEnvelope = normalizeDiagnosticEnvelope(
      input.system,
      input.messages,
      input.provider,
    );
    const messagePrefixCount = findCurrentTurnStart(diagnosticEnvelope.messages);
    const endpointIdentity = sanitizeProviderEndpoint(input.provider.getBaseUrl());
    const ignoresSystemAndTools = input.provider instanceof KodaXAcpProvider;
    const systemPromptHash = hashPromptCacheValue(
      ignoresSystemAndTools ? null : diagnosticEnvelope.system,
    );
    const toolSchemaHash = hashPromptCacheValue(ignoresSystemAndTools ? null : input.tools);
    const requestMessagesHash = hashProviderVisibleMessages(
      diagnosticEnvelope.messages,
      input.provider,
      input.model,
    );
    const ephemeralSuffixHash = input.ephemeralSuffix?.content
      ? hashPromptCacheValue(input.ephemeralSuffix.content)
      : undefined;
    const promptCacheDisabled = resolvePromptCacheDisabled(input.disablePromptCache);
    const promptCacheAffinityHash = input.promptCacheKey
      && !promptCacheDisabled
      && typeof input.provider.usesPromptCacheAffinity === 'function'
      && input.provider.usesPromptCacheAffinity()
      ? hashPromptCacheValue(input.promptCacheKey)
      : undefined;
    event = {
      phase: 'request',
      transport: input.transport ?? 'stream',
      requestId: randomUUID(),
      requestedAt: new Date().toISOString(),
      provider: input.providerName,
      ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
      ...(input.contextKind !== undefined ? { contextKind: input.contextKind } : {}),
      ...(input.parentContextId !== undefined
        ? { parentContextId: input.parentContextId }
        : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      model: input.model,
      wireModel: input.provider.getWireModel(input.model),
      reasoningHash: hashPromptCacheValue(input.reasoning ?? null),
      maxOutputTokens: input.provider.getEffectiveMaxOutputTokens(input.model),
      kodaxPromptCacheEnabled: !promptCacheDisabled,
      endpoint: endpointIdentity?.origin,
      endpointPathHash: endpointIdentity?.pathHash,
      attempt: input.attempt,
      systemPromptHash,
      toolSchemaHash,
      messagePrefixHash: hashProviderVisibleMessages(
        diagnosticEnvelope.messages.slice(0, messagePrefixCount),
        input.provider,
        input.model,
      ),
      messagePrefixCount,
      requestMessagesHash,
      requestEnvelopeHash: hashPromptCacheValue({
        systemPromptHash,
        toolSchemaHash,
        requestMessagesHash,
        ephemeralSuffixHash: ephemeralSuffixHash ?? null,
      }),
      ...(ephemeralSuffixHash !== undefined
        ? { ephemeralSuffixHash }
        : {}),
      ...(promptCacheAffinityHash !== undefined
        ? { promptCacheAffinityHash }
        : {}),
      messageCount: diagnosticEnvelope.messages.length,
      toolCount: input.tools.length,
    };
  } catch (error) {
    emitResilienceDebug('[context-diagnostics:cache-request-error]', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  try {
    input.events.onPromptCacheDiagnostics(event);
  } catch (error) {
    emitResilienceDebug('[context-diagnostics:cache-callback-error]', {
      phase: event.phase,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return event;
}

export function emitPromptCacheDiagnosticResponse(
  events: KodaXEvents | undefined,
  request: KodaXPromptCacheDiagnosticEvent | undefined,
  usage: KodaXTokenUsage | undefined,
): void {
  try {
    if (!request || !events?.onPromptCacheDiagnostics) return;
    const event: KodaXPromptCacheDiagnosticEvent = {
      ...request,
      phase: 'response',
      completedAt: new Date().toISOString(),
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage?.cachedReadTokens !== undefined
        ? { cachedReadTokens: usage.cachedReadTokens }
        : {}),
      ...(usage?.cachedWriteTokens !== undefined
        ? { cachedWriteTokens: usage.cachedWriteTokens }
        : {}),
    };
    events.onPromptCacheDiagnostics(event);
  } catch (error) {
    emitResilienceDebug('[context-diagnostics:cache-callback-error]', {
      phase: 'response',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
