import { randomUUID } from 'node:crypto';
import type { KodaXAssistantBlock, KodaXStreamResult, KodaXTokenUsage } from '../types.js';
import { observeProviderStreamUsage } from '../provider-request-observation.js';
import { KodaXNativeCloudProvider, type NativeCloudRequest } from './native-cloud.js';
import { requireCloudCredential } from './cloud-auth.js';
import { googleBlockHash, projectGoogleMessages, type GooglePart } from './google-messages.js';
import { readCloudSSE } from './cloud-sse.js';
import { nativeResponse } from './native-http.js';

interface GoogleResponse {
  candidates?: { index?: number; content?: { parts?: GooglePart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number };
}
function usageFrom(response: GoogleResponse): KodaXTokenUsage | undefined {
  const u = response.usageMetadata;
  return u ? { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    thoughtTokens: u.thoughtsTokenCount, cachedReadTokens: u.cachedContentTokenCount,
    totalTokens: u.totalTokenCount ?? (u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) } : undefined;
}

export class KodaXGoogleProvider extends KodaXNativeCloudProvider {
  protected async invoke(request: NativeCloudRequest): Promise<KodaXStreamResult> {
    const credential = requireCloudCredential(this.name);
    if (credential.type === 'aws' || (this.cloud.service === 'gemini' && credential.type !== 'api-key')) throw this.protocolError('Google route requires the matching API key or cloud bearer.');
    if (this.cloud.service === 'vertex' && credential.type === 'bearer' && !this.cloud.project) throw this.protocolError('Vertex bearer requires project and location.');
    const url = `${this.config.baseUrl!.replace(/\/$/, '')}/models/${encodeURIComponent(request.model)}:${request.streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
    const response = await nativeResponse(url, { method: 'POST', redirect: 'error', signal: request.signal,
      headers: { 'content-type': 'application/json', ...(credential.type === 'api-key'
        ? this.config.authentication === 'bearer' ? { authorization: `Bearer ${credential.key}` } : { 'x-goog-api-key': credential.key }
        : { authorization: `Bearer ${credential.token}` }) },
      body: JSON.stringify({ contents: await projectGoogleMessages(request.messages, request.source, this.getCapabilityProfile().multimodalSupport !== 'none'),
        ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
        ...(request.tools.length ? { tools: [{ functionDeclarations: request.tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }] } : {}),
        ...(request.options?.forcedToolName ? { toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [request.options.forcedToolName] } } } : {}),
        generationConfig: { maxOutputTokens: request.maxOutputTokens, ...this.thinkingConfig(request) },
      }) });
    const blocks: KodaXAssistantBlock[] = [];
    let usage: KodaXTokenUsage | undefined;
    let finishReason: string | undefined;
    const values = request.streaming ? readCloudSSE(response, request.signal)
      : (async function* () { yield await response.json() as unknown; })();
    for await (const raw of values) {
      request.signal?.throwIfAborted();
      request.options?.onHeartbeat?.();
      const value = raw as GoogleResponse & { error?: { message?: string } };
      if (!value || typeof value !== 'object' || value.error) throw this.protocolError(value?.error?.message ?? 'Invalid Google response event.');
      if (value.promptFeedback?.blockReason) throw this.protocolError(`Google prompt blocked: ${value.promptFeedback.blockReason}`);
      usage = usageFrom(value) ?? usage;
      observeProviderStreamUsage(usage);
      const candidate = value.candidates?.[0];
      if (finishReason && candidate?.content?.parts?.length) throw this.protocolError('Google returned content after its finish reason.');
      const nextBlocks = this.partsToBlocks(candidate?.content?.parts ?? [], request);
      for (const block of nextBlocks) {
        if (block.type === 'tool_use' && blocks.some(prior => prior.type === 'tool_use' && prior.id === block.id)) throw this.protocolError('Google returned duplicate function call IDs.');
        if (request.streaming) {
          if (block.type === 'text') request.options?.onTextDelta?.(block.text);
          if (block.type === 'thinking') request.options?.onThinkingDelta?.(block.thinking);
          if (block.type === 'tool_use') request.options?.onToolInputDelta?.(block.name, JSON.stringify(block.input), { toolId: block.id });
        }
        blocks.push(block);
      }
      if (candidate?.finishReason) {
        if (finishReason && finishReason !== candidate.finishReason) throw this.protocolError('Google returned conflicting finish reasons.');
        finishReason = candidate.finishReason;
      }
    }
    request.signal?.throwIfAborted();
    if (finishReason !== 'STOP') throw this.protocolError(`Google response did not complete: ${finishReason ?? 'missing finishReason'}`, !finishReason);
    return this.finish(request, blocks, usage, 'end_turn');
  }
  private thinkingConfig(request: NativeCloudRequest): Record<string, unknown> {
    if (request.profile?.effortStrategy === 'provider-budget') {
      const requested = request.disabled ? 0 : request.effort ? request.profile.budgetByEffort?.[request.effort] : undefined;
      const budget = requested === undefined ? undefined : this.boundThinkingBudget(request, requested);
      return budget === undefined ? {} : { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } };
    }
    if (request.profile?.effortStrategy !== 'google-thinking-level') return {};
    if (request.disabled) throw this.protocolError('Google thinking levels do not imply a portable off switch. Declare a budget profile if the model supports zero budget.');
    if (!request.effort) return {};
    return { thinkingConfig: { thinkingLevel: request.effort.toUpperCase(), includeThoughts: true } };
  }
  private partsToBlocks(parts: GooglePart[], request: NativeCloudRequest): KodaXAssistantBlock[] {
    const blocks: KodaXAssistantBlock[] = [];
    const ids = new Set<string>();
    for (const part of parts) {
      if ((part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string')
        || (part.thought !== undefined && typeof part.thought !== 'boolean')) throw this.protocolError('Invalid Google Part metadata.');
      let block: KodaXAssistantBlock;
      if (part.functionCall) {
        const call = part.functionCall;
        if (call.partialArgs !== undefined || call.willContinue || typeof call.name !== 'string' || !call.name
          || (call.id !== undefined && typeof call.id !== 'string')
          || (call.args !== undefined && (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)))) throw this.protocolError('Google returned an unfinished function call.');
        const id = call.id ?? `google_${randomUUID()}`;
        if (!id || ids.has(id)) throw this.protocolError('Google returned duplicate function call IDs.');
        ids.add(id);
        block = { type: 'tool_use', id, name: call.name, input: call.args ?? {} };
      } else if (typeof part.text === 'string') block = part.thought ? { type: 'thinking', thinking: part.text, source: request.source } : { type: 'text', text: part.text };
      else throw this.protocolError('Unsupported Google response part.');
      block.googlePart = { source: request.source, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        ...(part.functionCall?.id ? { callId: part.functionCall.id } : {}), contentHash: googleBlockHash(block) };
      blocks.push(block);
    }
    return blocks;
  }
}
