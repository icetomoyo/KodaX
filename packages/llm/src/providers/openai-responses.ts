import { parseResponsesOutput } from './responses-output.js';
import { normalizeResponsesUsage } from './cache-usage.js';
import { withCacheWritePartition } from './request-extensions.js';
import { requestHeaders } from './request-extensions.js';
import { prepareProviderPayload, providerStreamEvent } from './request-extensions.js';
import { responseTools, withoutPreferredToolConstraints } from './tool-constraints.js';
import { createHash } from 'node:crypto';
import type { Response as OpenAIResponse, ResponseCreateParamsBase, ResponseInputContent, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type {
  KodaXAssistantBlock, KodaXGenerationSource, KodaXMessage, KodaXProviderStreamOptions,
  KodaXReasoningRequest, KodaXStreamResult, KodaXTokenUsage, KodaXToolDefinition, KodaXVerifyCredentialResult,
} from '../types.js';
import { KodaXProviderError } from '../errors.js';
import { observeProviderStreamUsage } from '../provider-request-observation.js';
import { withProviderRequestCredential, getScopedProviderCredential } from '../provider-credential-context.js';
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
  return withCacheWritePartition(normalizeResponsesUsage(response.usage));
}

/** Native stateless Responses; shares credentials, transport observation and bounded retries with OpenAI. */
export abstract class KodaXOpenAIResponsesProvider extends KodaXOpenAICompatProvider {
  protected override getReasoningApi(): string { return 'openai-responses'; }
  private readonly rejectedResponseEfforts = new Map<string, Set<string>>();
  protected requiresResponseStream(): boolean { return false; }
  protected prepareResponseRequest(params: ResponseCreateParamsBase): ResponseCreateParamsBase { return params; }
  protected responseRequestHeaders(_messages: readonly KodaXMessage[]): Record<string, string> | undefined { return undefined; }
  protected responseSocketHeaders(messages: readonly KodaXMessage[], _options?: KodaXProviderStreamOptions): Record<string, string> {
    const key = this.getApiKey();
    return Object.fromEntries(requestHeaders({ ...(this.config.authentication === 'cloudflare-gateway' ? { 'cf-aig-authorization': `Bearer ${key}` }
      : { authorization: `Bearer ${key}` }), ...this.responseRequestHeaders(messages) }));
  }
  private async responseEvents(params: ResponseCreateParamsBase, messages: readonly KodaXMessage[], options: KodaXProviderStreamOptions | undefined,
    requestOptions: { signal?: AbortSignal; maxRetries: number; headers?: Record<string, string> }, customProperties: ReadonlyMap<string, string>): Promise<AsyncIterable<ResponseStreamEvent>> {
    const http = async () => (await this.getClient()).responses.create(await prepareProviderPayload({ ...params, stream: true as const }), requestOptions);
    if (options?.transport === undefined || options.transport === 'sse') return http();
    const url = new URL(`${this.getBaseUrl()?.replace(/\/$/, '') ?? 'https://api.openai.com/v1'}/responses`);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:'
      && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw this.protocolError('Invalid WebSocket endpoint.');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const { background: _background, ...body } = params;
    const frame = await prepareProviderPayload({ type: 'response.create', ...body }, 'root', false);
    const { responsesWebSocketEvents } = await import('./responses-websocket.js');
    return responsesWebSocketEvents({ provider: this.name, url: url.href, headers: this.responseSocketHeaders(messages, options), frame,
      options, signal: requestOptions.signal, scope: this.getReasoningLearningScope(options?.modelOverride)!,
      validateCompleted: response => projectResponsesMessages([{ role: 'assistant', content: this.parseOutput(response,
        this.getGenerationSource(options?.modelOverride), customProperties) }], this.getGenerationSource(options?.modelOverride), () => [], { settleTrailing: false }),
      ...(options.transport === 'auto' ? { fallback: http } : {}) });
  }
  protected acceptsResponseToolNamespace(_namespace?: string): boolean { return true; }
  getGenerationSource(model?: string): KodaXGenerationSource {
    const fingerprint = this.getRequestCredentialFingerprint();
    return { provider: this.name, api: 'openai-responses', model: this.getWireModelId(model), baseUrl: this.getBaseUrl(),
      ...(fingerprint ? { credentialScope: fingerprint } : this.config.credentialSource === 'broker' ? { credentialScope: 'unavailable' } : {}) };
  }

  override async verifyCredential(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<KodaXVerifyCredentialResult> {
    if (this.config.verifyStrategy !== 'minimal-message') return super.verifyCredential(opts);
    return runVerifyCredential({ strategy: 'minimal-message', providerName: this.name, ...opts, runners: [{
      strategy: 'minimal-message', approxTokensSpent: 22,
      run: signal => withProviderRequestCredential(this, 'utility', signal, async requestSignal => {
        const client = await this.getClient();
        await client.responses.create({ model: this.getWireModelId(), input: 'hi', store: false,
          max_output_tokens: 16, stream: false }, { signal: requestSignal, maxRetries: 0 });
      }),
    }] });
  }

  override stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string,
    reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult> {
    return this.withRequestContext(options, signal, requestSignal => this.generate(true, messages, tools, system, reasoning, options, requestSignal));
  }

  override complete(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string,
    reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult> {
    return this.withRequestContext(options, signal, requestSignal => this.generate(false, messages, tools, system, reasoning, options, requestSignal));
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
      const input = projectResponsesMessages(envelope.rest, source, image => images.get(image)!,
        { cacheBreakpoints: this.getCacheCapabilities(model)?.dialect === 'openai-options' && !resolvePromptCacheDisabled() && options?.cacheRetention !== 'none' });
      if (options?.ephemeralSuffix?.content) input.push({ role: 'user', content: options.ephemeralSuffix.content });
      const budget = this.getEffectiveMaxOutputTokens(model, options?.maxOutputTokensOverride);
      retry.maxOutputTokensLimit ??= budget;
      // Only one-way hard evidence is retained. Identity and declaration changes cannot inherit it.
      const learningKey = this.getReasoningLearningScope(model) ?? createHash('sha256').update(this.getApiKey()).digest('hex');
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
        const toolPlan = responseTools(withoutPreferredToolConstraints(tools, retry.disablePreferredToolConstraints), this.getToolCapabilities(model), this.name);
        const params = this.prepareResponseRequest({
          model: source.model, input, instructions: envelope.system, store: false,
          include: ['reasoning.encrypted_content'],
          max_output_tokens: Math.min(retry.maxOutputTokensOverride ?? budget, budget),
          ...(tools.length ? { tools: toolPlan.tools } : {}),
          ...(options?.forcedToolName && tools.length ? { tool_choice: { type: toolPlan.customProperties.has(options.forcedToolName) ? 'custom' as const : 'function' as const, name: options.forcedToolName } } : {}),
          ...(sentEffort ? { reasoning: { effort: sentEffort as NonNullable<ResponseCreateParamsBase['reasoning']>['effort'] } } : {}),
          ...(this.config.promptCacheAffinity && options?.promptCacheKey && !resolvePromptCacheDisabled()
            ? { prompt_cache_key: options.promptCacheKey } : {}),
        });
        const requestOptions = { signal, maxRetries: 0, headers: this.responseRequestHeaders(messages) };
        let response: OpenAIResponse | undefined;
        try {
          if (streaming || this.requiresResponseStream() || (options?.transport !== undefined && options.transport !== 'sse')) {
            const events = await this.responseEvents(params, messages, options, requestOptions, toolPlan.customProperties);
            const toolInputs = new Map<string, { name: string; callId: string; property?: string }>();
            for await (const event of events) {
              providerStreamEvent(event);
              if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
              options?.onHeartbeat?.();
              if ('response' in event) observeProviderStreamUsage(usageFrom(event.response));
              if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
                response = event.response;
                break;
              }
              this.emitDelta(event, streaming ? options : undefined, toolInputs, toolPlan.customProperties);
            }
            if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
            if (!response) throw new KodaXProviderError('Stream incomplete: Responses ended without a terminal response.', this.name,
              { failureCode: 'response_stream_error', stage: 'response_stream' });
          } else {
            const client = await this.getClient();
            response = await client.responses.create(await prepareProviderPayload({ ...params, stream: false as const }), requestOptions);
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
        const contentBlocks = this.parseOutput(response, source, toolPlan.customProperties);
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
    { model, effort, tools });
  }

  private emitDelta(event: ResponseStreamEvent, options: KodaXProviderStreamOptions | undefined,
    tools: Map<string, { name: string; callId: string; property?: string }>, customProperties: ReadonlyMap<string, string>): void {
    switch (event.type) {
      case 'error': throw this.upstreamError(event.message, event.code);
      case 'response.output_text.delta': case 'response.refusal.delta': options?.onTextDelta?.(event.delta); break;
      case 'response.reasoning_summary_text.delta': options?.onThinkingDelta?.(event.delta); break;
      case 'response.output_item.added':
        if (event.item.type === 'function_call') tools.set(event.item.id!, { name: event.item.name, callId: event.item.call_id });
        if (event.item.type === 'custom_tool_call') {
          const property = customProperties.get(event.item.name);
          if (!property) throw this.protocolError('Responses started an undeclared custom tool.');
          if (event.item.id) tools.set(event.item.id, { name: event.item.name, callId: event.item.call_id, property });
        }
        break;
      case 'response.custom_tool_call_input.delta': {
        const tool = tools.get(event.item_id);
        if (!tool?.property) throw this.protocolError('Custom tool delta has no declared input property.');
        options?.onToolInputDelta?.(tool.name, event.delta, { toolId: tool.callId, format: 'text', inputProperty: tool.property });
        break;
      }
      case 'response.function_call_arguments.delta': {
        const tool = tools.get(event.item_id);
        if (tool) options?.onToolInputDelta?.(tool.name, event.delta, { toolId: tool.callId });
        break;
      }
    }
  }

  private parseOutput(response: OpenAIResponse, source: KodaXGenerationSource, customProperties: ReadonlyMap<string, string>): KodaXAssistantBlock[] {
    return parseResponsesOutput(response, source, namespace => this.acceptsResponseToolNamespace(namespace), customProperties);
  }
}
