/**
 * SA Refactor Goldens — Recorder and Replay Providers
 *
 * Companion: docs/features/v0.7.29.md "5 重保险机制 + 3 项加强" (mechanism 2 — golden trace)
 *            tests/sa-refactor-goldens/README.md
 *            tests/sa-refactor-goldens/record.ts (orchestration)
 *
 * Both providers extend KodaXBaseProvider so they are drop-in substitutes for
 * any concrete provider on the agent loop's provider seat. The agent loop only
 * sees the abstract interface (stream / supportsNonStreamingFallback /
 * complete / getEffectiveMaxOutputTokens / getReasoningCapability / ...), so a
 * plain wrapper that delegates configuration calls to the inner provider is
 * sufficient.
 *
 * Design notes
 * ============
 *
 * 1. Sequence-based matching, not request-hash equality.
 *    The 1st provider call during replay is matched against the 1st recorded
 *    call, the 2nd against the 2nd, and so on. We deliberately do NOT hash the
 *    full request envelope and look up by hash, because:
 *      a) Tiny non-semantic drift (wall-clock timestamps embedded in system
 *         prompts, identity-only object differences, etc.) would break hash
 *         equality but is irrelevant to the capability we are protecting.
 *      b) The agent loop's deterministic structure means call-N is always
 *         "the N-th model call in this run". A divergence at call N tells us
 *         exactly where the post-refactor flow drifted from the pre-refactor
 *         baseline, which is the signal goldens are designed to surface.
 *    Note: tool *order* IS treated as semantic — re-ordering the tool array
 *    changes model behaviour, so `diffEnvelope` is order-sensitive on
 *    `toolNames`.
 *
 * 2. Shape-checking on replay.
 *    Before returning a recorded result, we assert that the live request has
 *    the same shape as the recorded one (message count + role pattern + tool
 *    names + reasoning depth + modelOverride). A shape mismatch fails the
 *    replay loudly with a structured diff — that IS the regression.
 *
 * 3. Callback timeline replay.
 *    The recorder snapshots the full ordered list of provider-side callbacks
 *    (textDelta, thinkingDelta, thinkingEnd, toolInputDelta, heartbeat,
 *    rateLimit) into the recording. On replay, we invoke the live request's
 *    callbacks in the same order with the recorded payloads, then resolve
 *    with the recorded result. This preserves streaming-shape sensitivity in
 *    consumer code (tool arg parsers, idle watchdogs).
 *
 * 4. Storage format.
 *    One JSON file per session, schema-versioned (`formatVersion: 1`). Bump
 *    the version when shape changes; the verifier rejects mismatched
 *    versions instead of silently misinterpreting old files.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  KodaXMessage,
  KodaXToolDefinition,
  KodaXProviderStreamOptions,
  KodaXProviderCapabilityProfile,
  KodaXReasoningCapability,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXProviderConfig,
} from '@kodax/ai';
import { KodaXBaseProvider } from '@kodax/ai';

// ---------------------------------------------------------------------------
// Recording shape
// ---------------------------------------------------------------------------

export type RecordedCallback =
  | { kind: 'textDelta'; text: string }
  | { kind: 'thinkingDelta'; text: string }
  | { kind: 'thinkingEnd'; thinking: string }
  | {
      kind: 'toolInputDelta';
      toolName: string;
      partialJson: string;
      toolId?: string;
    }
  | { kind: 'rateLimit'; attempt: number; maxRetries: number; delayMs: number }
  | { kind: 'heartbeat'; pause?: boolean };

export interface RecordedRequestEnvelope {
  /** Number of messages in `messages` */
  messageCount: number;
  /** Per-message role + content kind, in order. Used for shape check. */
  messageShape: Array<{
    role: KodaXMessage['role'];
    contentKind: 'string' | 'blocks';
    /** When `contentKind === 'blocks'`, the ordered block-type list. */
    blockTypes?: string[];
  }>;
  /** Tool names declared, in order. */
  toolNames: string[];
  /** Length of `system` (cheap fingerprint without leaking content). */
  systemLength: number;
  /** Reasoning request, normalized to a stable shape. */
  reasoning: { enabled?: boolean; mode?: string; depth?: string } | null;
  /** modelOverride from streamOptions, if any. */
  modelOverride?: string;
  /** sessionId from streamOptions, if any. */
  sessionId?: string;
}

export interface RecordedStreamCall {
  /** Ordinal of this call within the session (0-based). */
  index: number;
  /** Request envelope summary — used for shape validation on replay. */
  request: RecordedRequestEnvelope;
  /** Ordered timeline of callbacks the inner provider fired. */
  callbacks: RecordedCallback[];
  /** Recorded result of the stream. */
  result: KodaXStreamResult;
  /** Wall-clock duration of the inner stream call (informational). */
  durationMs: number;
}

/**
 * Snapshot of the inner provider's configuration query surface, taken once at
 * recording time. ReplayProvider returns these values from the corresponding
 * KodaXBaseProvider methods so the agent loop sees identical context-window /
 * max-output-tokens / reasoning-capability values during replay as it did
 * during recording. Without this, a single skewed value (e.g. context window
 * differing by 50k between record and replay) would change compaction
 * thresholds and produce phantom shape diffs unrelated to the regression
 * being tested.
 */
export interface RecordedProviderSummary {
  name: string;
  supportsThinking: boolean;
  baseUrl?: string;
  apiKeyEnv: string;
  defaultModel: string;
  availableModels: string[];
  capabilityProfile: KodaXProviderCapabilityProfile;
  reasoningCapability: KodaXReasoningCapability;
  contextWindow: number;
  maxOutputTokens: number;
  streamMaxDurationMs?: number;
  supportsNonStreamingFallback: boolean;
  isConfigured: boolean;
}

export interface SessionRecording {
  /** Schema version for this recording shape. Bump on breaking changes. */
  formatVersion: 1;
  /** Source session id (from .kodax/sessions/<id>.json). */
  sessionId: string;
  /** ISO timestamp of when the recording was captured. */
  recordedAt: string;
  /** Inner provider name (e.g. 'anthropic-claude'). */
  innerProvider: string;
  /** Inner provider's effective model at recording time. */
  innerModel: string;
  /** Snapshot of inner provider config queries at recording time. */
  innerSummary: RecordedProviderSummary;
  /** Ordered list of provider stream calls. */
  calls: RecordedStreamCall[];
}

function summariseInnerProvider(inner: KodaXBaseProvider): RecordedProviderSummary {
  return {
    name: inner.name,
    supportsThinking: inner.supportsThinking,
    baseUrl: inner.getBaseUrl(),
    apiKeyEnv: inner.getApiKeyEnv(),
    defaultModel: inner.getModel(),
    availableModels: inner.getAvailableModels(),
    capabilityProfile: inner.getCapabilityProfile(),
    reasoningCapability: inner.getReasoningCapability(),
    contextWindow: inner.getEffectiveContextWindow(),
    maxOutputTokens: inner.getEffectiveMaxOutputTokens(),
    streamMaxDurationMs: inner.getStreamMaxDurationMs(),
    supportsNonStreamingFallback: inner.supportsNonStreamingFallback(),
    isConfigured: inner.isConfigured(),
  };
}

// ---------------------------------------------------------------------------
// Helpers — envelope summarisation, shape diffing
// ---------------------------------------------------------------------------

function summariseEnvelope(
  messages: KodaXMessage[],
  tools: KodaXToolDefinition[],
  system: string,
  reasoning: boolean | KodaXReasoningRequest | undefined,
  streamOptions: KodaXProviderStreamOptions | undefined,
): RecordedRequestEnvelope {
  const messageShape = messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, contentKind: 'string' as const };
    }
    return {
      role: m.role,
      contentKind: 'blocks' as const,
      blockTypes: m.content.map((b) => b.type),
    };
  });

  let normalisedReasoning: RecordedRequestEnvelope['reasoning'] = null;
  if (typeof reasoning === 'boolean') {
    normalisedReasoning = { enabled: reasoning };
  } else if (reasoning && typeof reasoning === 'object') {
    normalisedReasoning = {
      enabled: reasoning.enabled,
      mode: reasoning.mode,
      depth: reasoning.depth,
    };
  }

  return {
    messageCount: messages.length,
    messageShape,
    toolNames: tools.map((t) => t.name),
    systemLength: system.length,
    reasoning: normalisedReasoning,
    modelOverride: streamOptions?.modelOverride,
    sessionId: streamOptions?.sessionId,
  };
}

export interface ShapeDiff {
  field: string;
  recorded: unknown;
  live: unknown;
}

/** Returns `[]` when shapes match, otherwise the offending fields. */
export function diffEnvelope(
  recorded: RecordedRequestEnvelope,
  live: RecordedRequestEnvelope,
): ShapeDiff[] {
  const diffs: ShapeDiff[] = [];

  if (recorded.messageCount !== live.messageCount) {
    diffs.push({
      field: 'messageCount',
      recorded: recorded.messageCount,
      live: live.messageCount,
    });
  }

  const sharedLen = Math.min(
    recorded.messageShape.length,
    live.messageShape.length,
  );
  for (let i = 0; i < sharedLen; i++) {
    const r = recorded.messageShape[i]!;
    const l = live.messageShape[i]!;
    if (r.role !== l.role) {
      diffs.push({
        field: `messageShape[${i}].role`,
        recorded: r.role,
        live: l.role,
      });
    }
    if (r.contentKind !== l.contentKind) {
      diffs.push({
        field: `messageShape[${i}].contentKind`,
        recorded: r.contentKind,
        live: l.contentKind,
      });
    }
    if (r.contentKind === 'blocks' && l.contentKind === 'blocks') {
      const rTypes = (r.blockTypes ?? []).join(',');
      const lTypes = (l.blockTypes ?? []).join(',');
      if (rTypes !== lTypes) {
        diffs.push({
          field: `messageShape[${i}].blockTypes`,
          recorded: r.blockTypes,
          live: l.blockTypes,
        });
      }
    }
  }

  if (recorded.toolNames.join(',') !== live.toolNames.join(',')) {
    diffs.push({
      field: 'toolNames',
      recorded: recorded.toolNames,
      live: live.toolNames,
    });
  }

  if (recorded.modelOverride !== live.modelOverride) {
    diffs.push({
      field: 'modelOverride',
      recorded: recorded.modelOverride,
      live: live.modelOverride,
    });
  }

  const rDepth = recorded.reasoning?.depth ?? null;
  const lDepth = live.reasoning?.depth ?? null;
  if (rDepth !== lDepth) {
    diffs.push({
      field: 'reasoning.depth',
      recorded: rDepth,
      live: lDepth,
    });
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// Default config used by both wrapper providers
// ---------------------------------------------------------------------------

const WRAPPER_CONFIG: KodaXProviderConfig = {
  apiKeyEnv: '__KODAX_GOLDENS_NO_API_KEY__',
  model: 'goldens-wrapper',
  supportsThinking: true,
  reasoningCapability: 'native-budget',
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
};

// ---------------------------------------------------------------------------
// RecorderProvider — wraps an inner provider, captures every stream call
// ---------------------------------------------------------------------------

export class RecorderProvider extends KodaXBaseProvider {
  readonly name: string;
  readonly supportsThinking: boolean;
  protected readonly config: KodaXProviderConfig = WRAPPER_CONFIG;

  private readonly inner: KodaXBaseProvider;
  private readonly calls: RecordedStreamCall[] = [];
  private readonly sessionId: string;

  constructor(inner: KodaXBaseProvider, sessionId: string) {
    super();
    this.inner = inner;
    this.sessionId = sessionId;
    this.name = `recorder(${inner.name})`;
    this.supportsThinking = inner.supportsThinking;
  }

  // ---- KodaXBaseProvider config-query delegation -------------------------
  // The agent loop reads context window, max output tokens, reasoning
  // capability, etc. directly off the provider during a stream call. If we
  // returned the wrapper's WRAPPER_CONFIG defaults for these, the recorded
  // session would diverge from "what the same prompt would do against the
  // real provider", which is exactly what we are recording. So forward every
  // public query through to the inner instance.

  override getModel(): string { return this.inner.getModel(); }
  override getAvailableModels(): string[] { return this.inner.getAvailableModels(); }
  override getModelDescriptor(modelId?: string): ReturnType<KodaXBaseProvider['getModelDescriptor']> {
    return this.inner.getModelDescriptor(modelId);
  }
  override getBaseUrl(): string | undefined { return this.inner.getBaseUrl(); }
  override getApiKeyEnv(): string { return this.inner.getApiKeyEnv(); }
  override getCapabilityProfile(): KodaXProviderCapabilityProfile { return this.inner.getCapabilityProfile(); }
  override getReasoningCapability(modelOverride?: string): KodaXReasoningCapability {
    return this.inner.getReasoningCapability(modelOverride);
  }
  override getConfiguredReasoningCapability(modelOverride?: string): KodaXReasoningCapability {
    return this.inner.getConfiguredReasoningCapability(modelOverride);
  }
  override getReasoningOverride(modelOverride?: string): ReturnType<KodaXBaseProvider['getReasoningOverride']> {
    return this.inner.getReasoningOverride(modelOverride);
  }
  override getReasoningOverrideKey(modelOverride?: string): string {
    return this.inner.getReasoningOverrideKey(modelOverride);
  }
  override getContextWindow(): number { return this.inner.getContextWindow(); }
  override getEffectiveContextWindow(model?: string): number { return this.inner.getEffectiveContextWindow(model); }
  override getEffectiveMaxOutputTokens(model?: string): number { return this.inner.getEffectiveMaxOutputTokens(model); }
  override getStreamMaxDurationMs(): number | undefined { return this.inner.getStreamMaxDurationMs(); }
  override setMaxOutputTokensOverride(value: number | undefined): void {
    this.inner.setMaxOutputTokensOverride(value);
  }
  override isConfigured(): boolean { return this.inner.isConfigured(); }
  override supportsNonStreamingFallback(): boolean { return this.inner.supportsNonStreamingFallback(); }
  override async complete(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    return this.inner.complete(messages, tools, system, reasoning, streamOptions, signal);
  }

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    const callbacks: RecordedCallback[] = [];

    const wrappedOptions: KodaXProviderStreamOptions = {
      ...streamOptions,
      onTextDelta: (text) => {
        callbacks.push({ kind: 'textDelta', text });
        streamOptions?.onTextDelta?.(text);
      },
      onThinkingDelta: (text) => {
        callbacks.push({ kind: 'thinkingDelta', text });
        streamOptions?.onThinkingDelta?.(text);
      },
      onThinkingEnd: (thinking) => {
        callbacks.push({ kind: 'thinkingEnd', thinking });
        streamOptions?.onThinkingEnd?.(thinking);
      },
      onToolInputDelta: (toolName, partialJson, meta) => {
        callbacks.push({
          kind: 'toolInputDelta',
          toolName,
          partialJson,
          toolId: meta?.toolId,
        });
        streamOptions?.onToolInputDelta?.(toolName, partialJson, meta);
      },
      onRateLimit: (attempt, maxRetries, delayMs) => {
        callbacks.push({ kind: 'rateLimit', attempt, maxRetries, delayMs });
        streamOptions?.onRateLimit?.(attempt, maxRetries, delayMs);
      },
      onHeartbeat: (pause) => {
        callbacks.push({ kind: 'heartbeat', pause });
        streamOptions?.onHeartbeat?.(pause);
      },
    };

    const start = Date.now();
    const result = await this.inner.stream(
      messages,
      tools,
      system,
      reasoning,
      wrappedOptions,
      signal,
    );
    const durationMs = Date.now() - start;

    const request = summariseEnvelope(
      messages,
      tools,
      system,
      reasoning,
      streamOptions,
    );

    this.calls.push({
      index: this.calls.length,
      request,
      callbacks,
      result,
      durationMs,
    });

    return result;
  }

  /** Build the JSON-serialisable recording for this session. */
  buildRecording(): SessionRecording {
    return {
      formatVersion: 1,
      sessionId: this.sessionId,
      recordedAt: new Date().toISOString(),
      innerProvider: this.inner.name,
      innerModel: this.inner.getModel(),
      innerSummary: summariseInnerProvider(this.inner),
      calls: this.calls,
    };
  }

  /** Persist this session's recording to `<dir>/<sessionId>.json`. */
  async writeTo(recordingsDir: string): Promise<string> {
    await fs.mkdir(recordingsDir, { recursive: true });
    const filePath = path.join(recordingsDir, `${this.sessionId}.json`);
    const recording = this.buildRecording();
    await fs.writeFile(
      filePath,
      JSON.stringify(recording, null, 2),
      'utf-8',
    );
    return filePath;
  }
}

// ---------------------------------------------------------------------------
// ReplayProvider — returns recorded results in sequence with shape validation
// ---------------------------------------------------------------------------

export class ReplayMismatchError extends Error {
  readonly callIndex: number;
  readonly diffs: ShapeDiff[];

  constructor(callIndex: number, diffs: ShapeDiff[]) {
    super(
      `ReplayProvider: shape mismatch at call ${callIndex}: ` +
        diffs.map((d) => `${d.field} (recorded=${JSON.stringify(d.recorded)}, live=${JSON.stringify(d.live)})`).join('; '),
    );
    this.name = 'ReplayMismatchError';
    this.callIndex = callIndex;
    this.diffs = diffs;
  }
}

export class ReplayExhaustedError extends Error {
  constructor(expectedCalls: number) {
    super(
      `ReplayProvider: stream() called more than ${expectedCalls} times; recording exhausted`,
    );
    this.name = 'ReplayExhaustedError';
  }
}

export class ReplayProvider extends KodaXBaseProvider {
  readonly name: string;
  readonly supportsThinking: boolean;
  protected readonly config: KodaXProviderConfig = WRAPPER_CONFIG;

  private readonly recording: SessionRecording;
  private readonly summary: RecordedProviderSummary;
  private cursor = 0;
  /** Honours setMaxOutputTokensOverride during replay (one-shot, like base). */
  private replayMaxOutputOverride?: number;

  constructor(recording: SessionRecording) {
    super();
    if (recording.formatVersion !== 1) {
      throw new Error(
        `ReplayProvider: unsupported formatVersion ${recording.formatVersion} (expected 1)`,
      );
    }
    if (!recording.innerSummary) {
      throw new Error(
        'ReplayProvider: recording is missing innerSummary; recordings must be produced by RecorderProvider.buildRecording() at formatVersion 1.',
      );
    }
    this.recording = recording;
    this.summary = recording.innerSummary;
    this.name = `replay(${recording.innerProvider})`;
    this.supportsThinking = this.summary.supportsThinking;
  }

  /** Load a recording from disk and return a configured provider. */
  static async fromFile(filePath: string): Promise<ReplayProvider> {
    const raw = await fs.readFile(filePath, 'utf-8');
    const recording = JSON.parse(raw) as SessionRecording;
    return new ReplayProvider(recording);
  }

  /** Number of recorded calls remaining for replay. */
  get remaining(): number {
    return this.recording.calls.length - this.cursor;
  }

  // ---- KodaXBaseProvider config-query surface, served from innerSummary ---
  // Returns the values the inner provider returned at recording time so the
  // agent loop's routing decisions (compaction window, max-tokens budget,
  // reasoning capability) are identical between record and replay runs.

  override getModel(): string { return this.summary.defaultModel; }
  override getAvailableModels(): string[] { return [...this.summary.availableModels]; }
  override getBaseUrl(): string | undefined { return this.summary.baseUrl; }
  override getApiKeyEnv(): string { return this.summary.apiKeyEnv; }
  override getCapabilityProfile(): KodaXProviderCapabilityProfile {
    return { ...this.summary.capabilityProfile };
  }
  override getReasoningCapability(_modelOverride?: string): KodaXReasoningCapability {
    return this.summary.reasoningCapability;
  }
  override getConfiguredReasoningCapability(_modelOverride?: string): KodaXReasoningCapability {
    return this.summary.reasoningCapability;
  }
  override getContextWindow(): number { return this.summary.contextWindow; }
  override getEffectiveContextWindow(_model?: string): number { return this.summary.contextWindow; }
  override getEffectiveMaxOutputTokens(_model?: string): number {
    return this.replayMaxOutputOverride ?? this.summary.maxOutputTokens;
  }
  override getStreamMaxDurationMs(): number | undefined { return this.summary.streamMaxDurationMs; }
  override setMaxOutputTokensOverride(value: number | undefined): void {
    this.replayMaxOutputOverride = value;
  }
  override isConfigured(): boolean { return this.summary.isConfigured; }
  override supportsNonStreamingFallback(): boolean { return this.summary.supportsNonStreamingFallback; }

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    if (this.cursor >= this.recording.calls.length) {
      throw new ReplayExhaustedError(this.recording.calls.length);
    }

    const recorded = this.recording.calls[this.cursor]!;
    this.cursor += 1;

    const liveEnvelope = summariseEnvelope(
      messages,
      tools,
      system,
      reasoning,
      streamOptions,
    );
    const diffs = diffEnvelope(recorded.request, liveEnvelope);
    if (diffs.length > 0) {
      throw new ReplayMismatchError(recorded.index, diffs);
    }

    for (const cb of recorded.callbacks) {
      switch (cb.kind) {
        case 'textDelta':
          streamOptions?.onTextDelta?.(cb.text);
          break;
        case 'thinkingDelta':
          streamOptions?.onThinkingDelta?.(cb.text);
          break;
        case 'thinkingEnd':
          streamOptions?.onThinkingEnd?.(cb.thinking);
          break;
        case 'toolInputDelta':
          streamOptions?.onToolInputDelta?.(
            cb.toolName,
            cb.partialJson,
            cb.toolId !== undefined ? { toolId: cb.toolId } : undefined,
          );
          break;
        case 'rateLimit':
          streamOptions?.onRateLimit?.(cb.attempt, cb.maxRetries, cb.delayMs);
          break;
        case 'heartbeat':
          streamOptions?.onHeartbeat?.(cb.pause);
          break;
      }
    }

    return recorded.result;
  }
}
