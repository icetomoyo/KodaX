import { createHash } from 'node:crypto';
import type { Response as OpenAIResponse, ResponseCreateParamsBase, ResponseInputContent, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type {
  KodaXAssistantBlock, KodaXGenerationSource, KodaXMessage, KodaXProviderStreamOptions,
  KodaXReasoningRequest, KodaXStreamResult, KodaXTokenUsage, KodaXToolDefinition, KodaXVerifyCredentialResult,
} from '../types.js';
import { KodaXProviderError } from '../errors.js';
import { observeProviderStreamUsage } from '../provider-request-observation.js';
import { withProviderRequestCredential } from '../provider-credential-context.js';
import { resolvePromptCacheDisabled } from '../run-scoped-config.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { prepareImageBlock, UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER } from './image-serialization.js';
import { projectResponsesMessages } from './responses-messages.js';
import { recordRejectedImage } from './rejected-image.js';
import { runVerifyCredential } from './verify-credential.js';
import { classifyReasoningEffortRejection } from './reasoning-effort-rejection.js';
import { isProviderQuotaError } from '../retry/provider-quota.js';
import { buildReasoningEffortLadder, usesReasoningEffortLadder } from '../reasoning-ladder.js';

function usageFrom(response: OpenAIResponse): KodaXTokenUsage | undefined {
  const usage = response.usage;
  return usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens, cachedReadTokens: usage.input_tokens_details?.cached_tokens,
    thoughtTokens: usage.output_tokens_details?.reasoning_tokens } : undefined;
}

/** Native stateless Responses; shares credentials, transport observation and bounded retries with OpenAI. */
export abstract class KodaXOpenAIResponsesProvider extends KodaXOpenAICompatProvider {
  private readonly rejectedResponseEfforts = new Map<string, Set<string>>();
  getGenerationSource(model?: string): KodaXGenerationSource {
    return { provider: this.name, api: 'openai-responses', model: this.getWireModelId(model), baseUrl: this.getBaseUrl() };
  }

  override async verifyCredential(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<KodaXVerifyCredentialResult> {
    if (this.config.verifyStrategy !== 'minimal-message') return super.verifyCredential(opts);
    return runVerifyCredential({ strategy: 'minimal-message', providerName: this.name, ...opts, runners: [{
      strategy: 'minimal-message', approxTokensSpent: 22,
      run: signal => withProviderRequestCredential(this.name, 'utility', signal, async requestSignal => {
        const client = await this.getClient();
        await client.responses.create({ model: this.getWireModelId(), input: 'hi', store: false,
          max_output_tokens: 16, stream: false }, { signal: requestSignal, maxRetries: 0 });
      }),
    }] });
  }

  override stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string,
    reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult> {
    return this.generate(true, messages, tools, system, reasoning, options, signal);
  }

  override complete(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string,
    reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult> {
    return this.generate(false, messages, tools, system, reasoning, options, signal);
  }

  private protocolError(message: string): KodaXProviderError {
    return new KodaXProviderError(message, this.name, { failureCode: 'response_stream_error', stage: 'response_stream', retryable: false });
  }

  private upstreamError(message: string, code?: string | null): KodaXProviderError {
    const transient = code === 'server_error' || code === 'rate_limit_exceeded';
    const label = code === 'server_error' ? 'server error' : code === 'rate_limit_exceeded' ? 'rate limit' : 'failed';
    return new KodaXProviderError(`Responses ${label}: ${message}`, this.name, {
      failureCode: 'response_stream_error', stage: 'response_stream', upstreamCode: code ?? undefined,
      ...(!transient || isProviderQuotaError({ code, message }) ? { retryable: false } : {}),
    });
  }

  private async generate(streaming: boolean, messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string,
    reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult> {
    if (options?.forcedToolName && !tools.some(t => t.name === options.forcedToolName)) {
      throw this.protocolError('Responses forced tool is absent from the current tool definitions.');
    }
    const model = options?.modelOverride ?? this.getModel();
    const normalized = this.normalizeReasoning(reasoning);
    this.validateExplicitReasoningEffort(normalized, model);
    const profile = this.getReasoningProfile(model);
    const intent = profile ? this.resolveReasoningProfileIntent(normalized, profile, model) : undefined;
    const requested = normalized.effortSource === 'omitted' ? 'auto' : normalized.effort;
    const effort = profile?.effortStrategy === 'none' || profile?.effortStrategy === 'prompt-only' ? undefined
      : requested === 'auto' ? profile?.defaultEffort ?? profile?.supportedEfforts?.find(entry => entry.isDefault)?.value
      : intent?.disabled ? (profile?.supportsDisabledThinking === true ? 'none' : undefined) : intent?.effort;
    const source = this.getGenerationSource(model);
    const candidates = effort !== undefined && usesReasoningEffortLadder(profile)
      ? buildReasoningEffortLadder(profile, effort) : effort === undefined ? [undefined] : [effort, undefined];
    return this.withRateLimit(async retry => {
      if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      const envelope = this.normalizeSystemForWire(system, messages);
      const images = new Map<object, ResponseInputContent[]>();
      const supportsImages = this.getCapabilityProfile().multimodalSupport !== 'none';
      for (const message of envelope.rest) {
        if (typeof message.content === 'string') continue;
        for (const block of message.content) {
          const candidates = block.type === 'image' ? [block]
            : block.type === 'tool_result' && typeof block.content !== 'string' ? block.content.filter(item => item.type === 'image') : [];
          for (const image of candidates) {
            if (!supportsImages) { images.set(image, [{ type: 'input_text', text: UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER }]); continue; }
            const prepared = await prepareImageBlock(image);
            images.set(image, 'placeholder' in prepared ? [{ type: 'input_text', text: prepared.placeholder }]
              : [...(prepared.notice ? [{ type: 'input_text' as const, text: prepared.notice }] : []),
                { type: 'input_image', image_url: `data:${prepared.mediaType};base64,${prepared.data}`, detail: 'auto' }]);
          }
        }
      }
      const input = projectResponsesMessages(envelope.rest, source, image => images.get(image)!);
      if (options?.ephemeralSuffix?.content) input.push({ role: 'user', content: options.ephemeralSuffix.content });
      const budget = this.getEffectiveMaxOutputTokens(model, options?.maxOutputTokensOverride);
      retry.maxOutputTokensLimit ??= budget;
      // Only one-way hard evidence is retained. Identity and declaration changes cannot inherit it.
      const learningKey = createHash('sha256').update(JSON.stringify([source, profile, this.getApiKey()])).digest('hex');
      const rejected = [...(this.rejectedResponseEfforts.get(learningKey) ?? []),
        ...(options?.resolveRejectedReasoningEfforts?.(learningKey) ?? options?.rejectedReasoningEfforts ?? [])];
      const fallbacks: NonNullable<KodaXStreamResult['reasoningResolution']>['fallbacks'] = [];
      for (const candidate of candidates) {
        const cachedRejection = rejected.includes('*') || rejected.includes('parameter:reasoning')
          || rejected.includes('parameter:effort') || (candidate !== undefined && rejected.includes(candidate));
        if (candidate !== undefined && cachedRejection) {
          fallbacks.push({ effort: candidate, reason: 'cached-rejection' });
          continue;
        }
        const sentEffort = retry.suppressReasoningEffort ? undefined : candidate;
        const params: ResponseCreateParamsBase = {
          model: source.model, input, instructions: envelope.system, store: false,
          include: ['reasoning.encrypted_content'],
          max_output_tokens: Math.min(retry.maxOutputTokensOverride ?? budget, budget),
          ...(tools.length ? { tools: tools.map(t => ({ type: 'function' as const, name: t.name,
            description: t.description, parameters: t.input_schema, strict: false })) } : {}),
          ...(options?.forcedToolName && tools.length ? { tool_choice: { type: 'function', name: options.forcedToolName } as const } : {}),
          ...(sentEffort ? { reasoning: { effort: sentEffort as NonNullable<ResponseCreateParamsBase['reasoning']>['effort'] } } : {}),
          ...(this.config.promptCacheAffinity && options?.promptCacheKey && !resolvePromptCacheDisabled()
            ? { prompt_cache_key: options.promptCacheKey } : {}),
        };
        const client = await this.getClient();
        let response: OpenAIResponse | undefined;
        try {
          if (streaming) {
            const events = await client.responses.create({ ...params, stream: true }, { signal, maxRetries: 0 });
            const toolInputs = new Map<string, { name: string; callId: string }>();
            for await (const event of events) {
              if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
              options?.onHeartbeat?.();
              if ('response' in event) observeProviderStreamUsage(usageFrom(event.response));
              if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
                response = event.response;
                break;
              }
              this.emitDelta(event, options, toolInputs);
            }
            if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
            if (!response) throw new KodaXProviderError('Stream incomplete: Responses ended without a terminal response.', this.name,
              { failureCode: 'response_stream_error', stage: 'response_stream' });
          } else {
            response = await client.responses.create({ ...params, stream: false }, { signal, maxRetries: 0 });
            observeProviderStreamUsage(usageFrom(response));
          }
        } catch (error) {
          recordRejectedImage(error, params);
          const rejection = sentEffort === undefined ? null : classifyReasoningEffortRejection(error, sentEffort);
          if (rejection) {
            const value = rejection.parameterRejected ? '*' : rejection.rejectedEffort;
            const learned = this.rejectedResponseEfforts.get(learningKey) ?? new Set<string>();
            learned.add(value);
            this.rejectedResponseEfforts.set(learningKey, learned);
            rejected.push(value);
            fallbacks.push({ effort: sentEffort, reason: rejection.parameterRejected ? 'unsupported-parameter' : 'unsupported-effort' });
            options?.onReasoningEffortRejected?.({ provider: this.name, model, effort: value, cacheScope: learningKey });
            if (!options?.singleAttempt && !signal?.aborted) continue;
          }
          throw error;
        }
        if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        if (response.error) throw this.upstreamError(response.error.message, response.error.code);
        if (response.status !== 'completed') {
          throw this.protocolError(`Responses ${response.status}: ${response.incomplete_details?.reason ?? 'no completed output'}`);
        }
        const contentBlocks = this.parseOutput(response, source);
        const textBlocks = contentBlocks.filter(b => b.type === 'text');
        const thinkingBlocks = contentBlocks.filter(b => b.type === 'thinking');
        const toolBlocks = contentBlocks.filter(b => b.type === 'tool_use');
        if (!streaming) {
          for (const block of textBlocks) options?.onTextDelta?.(block.text);
          for (const block of thinkingBlocks) if (block.thinking) options?.onThinkingDelta?.(block.thinking);
        }
        const thinking = thinkingBlocks.map(b => b.thinking).join('');
        if (thinking) options?.onThinkingEnd?.(thinking);
        const reasoningResolution = { provider: this.name, model,
          requestedEffort: requested,
          sentEffort, verified: false as const,
          fallbacks: fallbacks.length ? fallbacks
            : requested !== 'auto' && requested !== sentEffort ? [{ effort: requested, reason: 'profile' as const }] : [] };
        options?.onReasoningResolved?.(reasoningResolution);
        return { contentBlocks, textBlocks, thinkingBlocks, toolBlocks, usage: usageFrom(response),
          stopReason: toolBlocks.length ? 'tool_use' : 'end_turn', reasoningResolution };
      }
      throw this.protocolError('Responses exhausted reasoning negotiation without a completed response.');
    }, signal, options?.singleAttempt ? 1 : 3, options?.onRateLimit, options?.onRetryAfter,
    { model, effort });
  }

  private emitDelta(event: ResponseStreamEvent, options: KodaXProviderStreamOptions | undefined,
    tools: Map<string, { name: string; callId: string }>): void {
    switch (event.type) {
      case 'error': throw this.upstreamError(event.message, event.code);
      case 'response.output_text.delta': case 'response.refusal.delta': options?.onTextDelta?.(event.delta); break;
      case 'response.reasoning_summary_text.delta': options?.onThinkingDelta?.(event.delta); break;
      case 'response.output_item.added':
        if (event.item.type === 'function_call') tools.set(event.item.id!, { name: event.item.name, callId: event.item.call_id });
        break;
      case 'response.function_call_arguments.delta': {
        const tool = tools.get(event.item_id);
        if (tool) options?.onToolInputDelta?.(tool.name, event.delta, { toolId: tool.callId });
        break;
      }
    }
  }

  private parseOutput(response: OpenAIResponse, source: KodaXGenerationSource): KodaXAssistantBlock[] {
    const blocks: KodaXAssistantBlock[] = [];
    const calls = new Set<string>();
    for (const item of response.output) {
      if (item.type === 'message') {
        if (item.status !== 'completed') throw this.protocolError('Responses returned an unfinished message.');
        for (const part of item.content) blocks.push({ type: 'text', text: part.type === 'output_text' ? part.text : part.refusal });
      } else if (item.type === 'reasoning') {
        if (item.status && item.status !== 'completed') throw this.protocolError('Responses returned unfinished reasoning.');
        blocks.push({ type: 'thinking', thinking: item.summary.map(part => part.text).join('\n'),
          responsesReasoning: { source, id: item.id, summary: item.summary, encrypted_content: item.encrypted_content } });
      } else if (item.type === 'function_call') {
        if ((item.status && item.status !== 'completed') || !item.call_id || !item.name || calls.has(item.call_id)) {
          throw this.protocolError('Responses returned an unfinished or duplicate function call.');
        }
        let parsed: unknown;
        try { parsed = JSON.parse(item.arguments); }
        catch { throw this.protocolError('Responses returned invalid final function arguments.'); }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw this.protocolError('Responses function arguments must be a JSON object.');
        }
        calls.add(item.call_id);
        blocks.push({ type: 'tool_use', id: item.call_id, name: item.name, input: parsed as Record<string, unknown> });
      } else {
        throw this.protocolError(`Unsupported Responses output item: ${item.type}`);
      }
    }
    return blocks;
  }
}
