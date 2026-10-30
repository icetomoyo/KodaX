import { withoutPreferredToolConstraints } from './tool-constraints.js';
import type { KodaXAssistantBlock, KodaXGenerationSource, KodaXMessage, KodaXProviderConfig,
  KodaXProviderStreamOptions, KodaXReasoningProfile, KodaXReasoningRequest, KodaXStreamResult, KodaXTokenUsage, KodaXToolDefinition, KodaXToolCapabilities } from '../types.js';
import { KodaXBaseProvider } from './base.js';
import { KodaXProviderError } from '../errors.js';
import { createHash } from 'node:crypto';
import { withProviderRequestCredential } from '../provider-credential-context.js';
import { runVerifyCredential } from './verify-credential.js';
import { classifyReasoningEffortRejection } from './reasoning-effort-rejection.js';

export interface NativeRequest {
  streaming: boolean; messages: KodaXMessage[]; tools: KodaXToolDefinition[]; system: string;
  model: string; source: KodaXGenerationSource; maxOutputTokens: number;
  profile?: KodaXReasoningProfile; effort?: string; disabled: boolean;
  thinkingBudgetCap?: number;
  requestedEffort: string;
  logicalModel: string;
  reasoningFallbacks?: NonNullable<KodaXStreamResult['reasoningResolution']>['fallbacks'];
  /** Set only by the adapter that actually lowers a reasoning control. */
  sentReasoningEffort?: string;
  toolCapabilities: KodaXToolCapabilities;
  options?: KodaXProviderStreamOptions; signal?: AbortSignal;
}

/** Shared request/authority/terminal contract; each subclass owns its native wire format. */
export abstract class KodaXNativeProvider extends KodaXBaseProvider {
  override usesScopedReasoningLearning(): boolean { return true; }
  protected override getReasoningApi(): string { return this.nativeApi; }
  readonly supportsThinking = true;
  protected override readonly requestObservationBoundary = 'physical_attempt' as const;
  protected override readonly useLegacyReasoningFallback = false;
  constructor(readonly name: string, protected readonly config: KodaXProviderConfig, private readonly nativeApi: KodaXGenerationSource['api']) { super(); }
  override supportsEphemeralSuffix(): boolean { return true; }
  override usesPromptCacheAffinity(): boolean { return false; } // Native cache checkpoints are not a request affinity key.
  override supportsNonStreamingFallback(): boolean { return true; }
  getGenerationSource(model?: string): KodaXGenerationSource {
    return { provider: this.name, api: this.nativeApi,
      model: this.getWireModelId(model), baseUrl: this.config.baseUrl, credentialScope: this.getRequestCredentialFingerprint() ?? 'unavailable' };
  }
  stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string, reasoning?: boolean | KodaXReasoningRequest,
    options?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult> {
    return this.run(true, messages, tools, system, reasoning, options, signal);
  }
  override complete(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string, reasoning?: boolean | KodaXReasoningRequest,
    options?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult> {
    return this.run(false, messages, tools, system, reasoning, options, signal);
  }
  override verifyCredential(opts?: { timeoutMs?: number; signal?: AbortSignal }) {
    if (this.config.verifyStrategy === 'unsupported') return super.verifyCredential(opts);
    return runVerifyCredential({ strategy: 'minimal-message', providerName: this.name, ...opts, runners: [{
      strategy: 'minimal-message', approxTokensSpent: 22,
      run: signal => withProviderRequestCredential(this.name, 'utility', signal, requestSignal =>
        this.complete([{ role: 'user', content: 'hi' }], [], '', undefined, { singleAttempt: true, maxOutputTokensOverride: 16 }, requestSignal).then(() => undefined)),
    }] });
  }
  protected protocolError(message: string, retryable = false): KodaXProviderError {
    return new KodaXProviderError(message, this.name, { failureCode: 'response_stream_error', stage: 'response_stream', retryable });
  }
  protected assertCredential(): void { this.getApiKey(); }
  protected abstract invoke(request: NativeRequest): Promise<KodaXStreamResult>;
  /** Internal lazy transport entry; the outer provider already owns auth, retries and observations. */
  invokeNative(request: NativeRequest): Promise<KodaXStreamResult> { return this.invoke(request); }
  protected boundThinkingBudget(request: NativeRequest, budget: number): number {
    const cap = request.thinkingBudgetCap;
    if (!Number.isSafeInteger(budget) || budget < -1 || (cap !== undefined && (!Number.isSafeInteger(cap) || cap <= 0))) throw this.protocolError('Invalid declared thinking budget or cap.');
    return cap === undefined ? budget : budget === -1 ? cap : Math.min(budget, cap);
  }
  protected finish(request: NativeRequest, contentBlocks: KodaXAssistantBlock[], usage: KodaXTokenUsage | undefined, stopReason: string): KodaXStreamResult {
    request.signal?.throwIfAborted();
    const textBlocks = contentBlocks.filter(b => b.type === 'text');
    const thinkingBlocks = contentBlocks.filter(b => b.type === 'thinking' || b.type === 'redacted_thinking');
    const toolBlocks = contentBlocks.filter(b => b.type === 'tool_use');
    if (!request.streaming) {
      for (const block of textBlocks) request.options?.onTextDelta?.(block.text);
      for (const block of thinkingBlocks) if (block.type === 'thinking') request.options?.onThinkingDelta?.(block.thinking);
    }
    const thinking = thinkingBlocks.filter(b => b.type === 'thinking').map(b => b.thinking).join('');
    if (thinking) request.options?.onThinkingEnd?.(thinking);
    request.signal?.throwIfAborted();
    const reasoningResolution = { provider: this.name, model: request.logicalModel, requestedEffort: request.requestedEffort,
      sentEffort: request.sentReasoningEffort, verified: false as const,
      fallbacks: request.reasoningFallbacks?.length ? request.reasoningFallbacks : request.requestedEffort !== 'auto' && request.requestedEffort !== request.sentReasoningEffort
        ? [{ effort: request.requestedEffort, reason: 'profile' as const }] : [] };
    request.options?.onReasoningResolved?.(reasoningResolution);
    return { contentBlocks, textBlocks, thinkingBlocks, toolBlocks, usage,
      stopReason: stopReason === 'end_turn' && toolBlocks.length ? 'tool_use' : stopReason, reasoningResolution };
  }
  private async run(streaming: boolean, messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string,
    reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult> {
    if (options?.forcedToolName && !tools.some(t => t.name === options.forcedToolName)) throw this.protocolError('Forced tool is absent from current tools.');
    const model = options?.modelOverride ?? this.getModel();
    const normalized = this.normalizeReasoning(reasoning);
    this.validateExplicitReasoningEffort(normalized, model);
    const profile = this.getReasoningProfile(model);
    const intent = profile ? this.resolveReasoningProfileIntent(normalized, profile, model) : undefined;
    const implicit = normalized.effortSource === 'omitted' || normalized.effort === 'auto';
    const desired = profile?.effortStrategy === 'none' || profile?.effortStrategy === 'prompt-only' ? undefined
      : implicit ? profile?.defaultEffort ?? profile?.supportedEfforts?.find(entry => entry.isDefault)?.value : intent?.effort;
    const disabled = desired === 'none' || (desired !== undefined && profile?.disabledEfforts?.includes(desired) === true) || (!implicit && intent?.disabled === true);
    const effort = disabled ? undefined : desired === undefined ? undefined : profile?.effortAliases?.[desired] ?? desired;
    const systemParts = [system, ...messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content
      : m.content.filter(b => b.type === 'text').map(b => b.text).join('\n'))].filter(s => s.trim());
    const rest = messages.filter(m => m.role !== 'system');
    if (options?.ephemeralSuffix?.content) rest.push({ role: 'user', content: options.ephemeralSuffix.content });
    return this.withRequestContext(options, signal, signal => this.withRateLimit(async retry => {
      signal?.throwIfAborted();
      this.assertCredential();
      const budget = this.getEffectiveMaxOutputTokens(model, options?.maxOutputTokensOverride);
      retry.maxOutputTokensLimit ??= budget;
      const rejected = this.knownReasoningRejections(model, options);
      const suppress = retry.suppressReasoningEffort || rejected.includes('*') || (desired !== undefined && rejected.includes(desired));
      const request: NativeRequest = { streaming, messages: rest, tools: withoutPreferredToolConstraints(tools, retry.disablePreferredToolConstraints), system: systemParts.join('\n\n'), model: this.getWireModelId(model),
        source: this.getGenerationSource(model), maxOutputTokens: Math.min(retry.maxOutputTokensOverride ?? budget, budget), profile,
        toolCapabilities: this.getToolCapabilities(model),
        requestedEffort: normalized.effortSource === 'omitted' ? 'auto' : normalized.effort,
        logicalModel: model,
        ...(suppress && !retry.suppressReasoningEffort ? { reasoningFallbacks: [{ effort: desired, reason: 'cached-rejection' as const }] } : {}),
        effort: suppress ? undefined : effort, disabled: suppress ? false : disabled,
        thinkingBudgetCap: this.getEffectiveThinkingBudgetCap(model), options, signal };
      if (suppress) request.profile = undefined;
      try { return await this.invoke(request); }
      catch (error) {
        const rejection = request.sentReasoningEffort === undefined ? null : classifyReasoningEffortRejection(error, request.sentReasoningEffort);
        if (!rejection) throw error;
        this.rememberReasoningRejection(model, rejection.parameterRejected ? '*' : rejection.rejectedEffort, options);
        if (options?.singleAttempt || signal?.aborted || suppress) throw error;
        return this.invoke({ ...request, profile: undefined, effort: undefined, disabled: false, sentReasoningEffort: undefined,
          reasoningFallbacks: [{ effort: request.sentReasoningEffort, reason: rejection.parameterRejected ? 'unsupported-parameter' : 'unsupported-effort' }] });
      }
    }, signal, options?.singleAttempt ? 1 : 3, options?.onRateLimit, options?.onRetryAfter, { model, tools }));
  }
}
