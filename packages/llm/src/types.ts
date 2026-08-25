/**
 * KodaX AI Types
 *
  * AI 层类型定义 - 所有 Provider 共享的类型接口
 */

// ============== 内容块类型 ==============

export interface KodaXTextBlock {
  type: 'text';
  text: string;
}

export interface KodaXToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Set true when `input` was salvaged from malformed JSON (strict `JSON.parse`
   * threw). RAW signal — set regardless of stop reason. On its own it means the
   * payload is syntactically suspect: even a "complete" turn can carry malformed
   * JSON (e.g. unescaped quotes) that the partial-json salvage silently truncates
   * mid-value. `checkIncompleteToolCalls` therefore treats a salvaged input on a
   * MUTATING tool (write/edit/bash — `isToolMutation`) as incomplete even on a
   * clean stop, because executing a silently-cut payload corrupts files; a
   * salvaged input on a read-only tool is allowed through on a clean stop.
   */
  _salvaged?: boolean;
  /**
   * Set true when `input` was salvaged AND the stream did NOT end on a
   * recognized clean stop (`max_tokens`/`length`, or an ambiguous/`unknown`
   * stop). A truncating stop means the payload may be cut mid-value, so this is
   * unsafe to execute for ANY tool (not just mutating ones) — the agent loop
   * routes it into the incomplete-tool retry (CAP-072). Subset of `_salvaged`.
   *
   * Both markers are internal: provider serializers never write them to the wire
   * (they read only type/id/name/input). They may transiently remain on an
   * assistant tool_use block in session history on the retry-cap path; harmless
   * and never reaches the model. Mirrors the `KodaXMessage._synthetic`
   * convention.
   */
  _truncated?: boolean;
}

/**
 * Tool-result content blocks — a structural subset of the full
 * `KodaXContentBlock` union, restricted to what providers actually accept
 * inside a tool_result envelope. Anthropic / OpenAI multimodal APIs accept
 * text and image blocks inside tool_result; thinking / tool_use / nested
 * tool_result / cache-boundary are not valid there.
 *
 * Carrying these as a stricter subtype (instead of the full union) lets
 * provider serializers narrow without exhaustive type assertions and
 * documents to tool authors what they can actually return.
 */
export interface KodaXToolResultTextItem {
  type: 'text';
  text: string;
}

export interface KodaXToolResultImageItem {
  type: 'image';
  /** Absolute path to the image file. Provider serializers read it into base64 at wire-send time. */
  path: string;
  mediaType?: string;
}

export type KodaXToolResultContentItem =
    | KodaXToolResultTextItem
    | KodaXToolResultImageItem;

export interface KodaXToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  /**
   * Either a plain text string (backwards-compatible default) OR an array
   * of content items. The array form lets multimodal-capable tools (e.g.
   * `read` on an image path) emit images via tool_result, mirroring
   * claudecode's `Read` tool behavior. Providers serialize each variant
   * to their wire format; text-only providers (e.g. older OpenAI-compat
   * gateways) downgrade image items to a placeholder rather than rejecting.
   */
  content: string | readonly KodaXToolResultContentItem[];
  is_error?: boolean;
  /**
   * Local recovery/accounting metadata. Provider serializers intentionally
   * omit this field from the wire payload.
   */
  metadata?: Record<string, unknown>;
}

export interface KodaXImageBlock {
  type: 'image';
  path: string;
  mediaType?: string;
}

export interface KodaXThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface KodaXRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

/**
 * FEATURE_116 (v0.7.37) — Cache boundary marker.
 *
 * Marks the end of a cacheable prefix in a request payload. Provider base
 * classes lower this to the wire-level cache mechanism their API supports:
 *
 * - `KodaXAnthropicCompatProvider`: turns the marker into
 *   `cache_control: { type: 'ephemeral' }` on the immediately preceding
 *   block, then strips the marker itself.
 * - `KodaXOpenAICompatProvider`: strips the marker (OpenAI / DeepSeek
 *   auto prefix-cache; Kimi/Zhipu/通义 self-cache via separate cache_id
 *   endpoint deferred to v0.7.45+).
 * - `KodaXAcpProvider` (CLI bridge): strips the marker (CLI bridge does
 *   not touch wire; avoids leaking marker into subprocess input).
 *
 * Place at the suffix of any stable prefix (system prompt, tools array,
 * role prompt). The marker is purely client-side: it MUST be removed
 * before the request is sent over the wire.
 */
export interface KodaXCacheBoundary {
  type: 'cache-boundary';
  /** Optional hint identifying which logical region this boundary terminates. Diagnostic only. */
  hint?: 'system' | 'tools' | 'role-prompt';
}

export type KodaXContentBlock =
    | KodaXTextBlock
    | KodaXToolUseBlock
    | KodaXToolResultBlock
    | KodaXImageBlock
    | KodaXThinkingBlock
    | KodaXRedactedThinkingBlock
    | KodaXCacheBoundary;

// ============== 消息类型 ==============

export type KodaXTaskResultSource = 'workflow' | 'child_task';

export interface KodaXTaskResultMetadata {
  type: 'task_result';
  source: KodaXTaskResultSource;
  taskId: string;
  runId?: string;
  status: 'completed' | 'failed' | 'cancelled';
  title?: string;
  summary?: string;
  artifactRefs?: string[];
}

export interface KodaXMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | KodaXContentBlock[];
  /** Marks messages injected by the system (auto-continue, retry prompts). Hidden in REPL display. */
  _synthetic?: boolean;
  /**
   * Identifies which subsystem injected a synthetic message so consumers can
   * render/attribute it distinctly instead of treating it like a user query.
   * Absent on genuine user/assistant/system messages. Known values include
   * `'sidecar-verifier'` (Sidecar Verifier revise feedback),
   * `'agent-completed'` (an Actor `<agent-completed>` result banner), and the
   * legacy `'task-completed'` workflow banner. A rare same-wake mix with a
   * system-reminder shares the completion label, content preserved. Exposed
   * verbatim through `KodaXResult.messages`
   * and session-load APIs for SDK consumers.
   */
  _source?: string;
  /** Structured task/workflow result metadata for synthetic completion messages. */
  _taskResult?: KodaXTaskResultMetadata;
  /** Multiple task results when one synthetic wake message contains several banners. */
  _taskResults?: KodaXTaskResultMetadata[];
  /**
   * Stable SDK turn id that owns this transcript message. Optional for older
   * sessions and provider-internal synthetic messages.
   */
  turnId?: string;
  /**
   * ISO-8601 timestamp of when this message was finalized (assistant: when the
   * LLM stream completed; user: when submitted/injected). Optional and
   * best-effort: messages persisted before this field existed, or produced by a
   * path not yet updated to stamp it, will not carry it. `createSessionLineage`
   * prefers this value for the session entry's timestamp and falls back to the
   * accounting-time clock when absent, so a whole managed task no longer
   * collapses to a single save-time millisecond. Not authoritative for ordering
   * (array order is) — treat as display metadata (e.g. per-message "N ago").
   */
  timestamp?: string;
}

export interface KodaXEphemeralSuffix {
  readonly content: string;
}

// ============== 流式结果类型 ==============

export interface KodaXTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}

export interface KodaXStreamResult {
  textBlocks: KodaXTextBlock[];
  toolBlocks: KodaXToolUseBlock[];
  thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[];
  usage?: KodaXTokenUsage;
  /** Provider stop reason: 'end_turn' (normal), 'max_tokens' (truncated), 'stop_sequence', 'tool_use', etc. */
  stopReason?: string;
}

// ============== 工具定义 ==============

export interface KodaXToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ============== 推理策略类型 ==============

export type KodaXReasoningCapability =
  | 'native-effort'
  | 'native-budget'
  | 'native-toggle'
  // Model decides when/how much to think on its own (Anthropic
  // `thinking: { type: 'adaptive' }`). The only on-mode for Opus 4.7+,
  // which 400 on `budget_tokens` / `{ type: 'enabled' }`.
  | 'native-adaptive'
  | 'none'
  | 'prompt-only'
  | 'unknown';

export type KodaXStableEffortIntent =
  | 'auto'
  | 'none'
  | 'low'
  | 'medium'
  | 'high';

export type KodaXWireReasoningEffort = string;

export type KodaXReasoningPresetName =
  | 'zai-glm-5.3'
  | 'zai-glm-5.2'
  | 'zai-glm-toggle'
  | 'deepseek-v4-flash-openai'
  | 'deepseek-v4-pro-openai'
  | 'deepseek-v4-openai'
  | 'deepseek-v4-anthropic'
  | 'deepseek-toggle'
  | 'kimi-k3'
  | 'kimi-k2.7-code'
  | 'kimi-hybrid-toggle'
  | 'minimax-m3'
  | 'minimax-m2-always'
  | 'mimo-v2.5-toggle'
  | 'qwen-hybrid-thinking'
  | 'openai-chat-reasoning'
  | 'openai-responses-reasoning'
  | 'codex-cli-effort'
  | 'claude-adaptive-xhigh'
  | 'claude-adaptive-max'
  | 'anthropic-budget'
  | 'generic-thinking-toggle'
  | 'none';

export interface KodaXReasoningEffortRequest {
  readonly value: KodaXWireReasoningEffort;
  readonly isExplicit: boolean;
}

export interface KodaXReasoningEffortPreset {
  readonly value: KodaXWireReasoningEffort;
  readonly description?: string;
  readonly isDefault?: boolean;
  readonly isUserVisible?: boolean;
}

export type KodaXReasoningEffortWireStrategy =
  | 'openai-responses-effort'
  | 'openai-chat-effort'
  | 'codex-cli-config'
  // Real Claude: thinking:{type:'adaptive'} + output_config.effort.
  | 'anthropic-output-effort'
  // Non-Claude anthropic-compat endpoints (zhipu/deepseek style): thinking:
  // {type:'enabled'} + a top-level reasoning_effort. The friendly reasoning:
  // {efforts} form maps here on anthropic-compat (B1) so non-Claude models get
  // thinking-on + a tunable effort, instead of Claude's adaptive shape.
  | 'anthropic-reasoning-effort'
  | 'provider-budget'
  | 'provider-toggle'
  | 'prompt-only'
  | 'none';

export type KodaXThinkingWireStrategy =
  | 'anthropic-adaptive'
  | 'anthropic-budget'
  | 'provider-budget'
  | 'provider-toggle'
  | 'none';

export interface KodaXReasoningProfile {
  readonly reasoningPreset?: KodaXReasoningPresetName;
  readonly effortStrategy: KodaXReasoningEffortWireStrategy;
  readonly thinkingStrategy?: KodaXThinkingWireStrategy;
  readonly defaultEffort?: KodaXWireReasoningEffort;
  readonly supportedEfforts?: readonly KodaXReasoningEffortPreset[];
  readonly effortAliases?: Partial<Record<KodaXWireReasoningEffort, KodaXWireReasoningEffort>>;
  readonly disabledEfforts?: readonly KodaXWireReasoningEffort[];
  readonly localRejectEfforts?: readonly KodaXWireReasoningEffort[];
  readonly allowCustomEffort?: boolean;
  readonly budgetByEffort?: Partial<Record<KodaXWireReasoningEffort, number>>;
  readonly supportsReasoningEffort?: boolean;
  readonly supportsReasoningSummary?: boolean;
  readonly supportsEncryptedReasoningReplay?: boolean;
  readonly supportsAdaptiveThinking?: boolean;
  readonly supportsManualThinkingBudget?: boolean;
  readonly supportsDisabledThinking?: boolean;
  readonly requiresEffortBetaHeader?: boolean;
}

/**
 * Friendly reasoning declaration for CUSTOM providers / models — the canonical
 * user-facing form. List the effort rungs the model accepts (order = the Ctrl+T
 * ladder; include `"off"` to allow disabling thinking) plus an optional
 * `default`. The wire strategy (effortStrategy / thinkingStrategy) is derived
 * from the provider `protocol`, so users never touch preset names or strategy
 * enums. Use the string `"none"` for a model with no thinking capability. For
 * full, explicit control fall back to `reasoningProfile`.
 *
 * Example: `"reasoning": { "efforts": ["off", "low", "high", "max"], "default": "high" }`
 */
export interface KodaXSimpleReasoningConfig {
  readonly efforts: readonly string[];
  readonly default?: string;
}

/** User-facing reasoning declaration: friendly form, `"none"`, or (advanced) a raw profile override. */
export type KodaXReasoningConfig =
  | KodaXSimpleReasoningConfig
  | 'none'
  | Partial<KodaXReasoningProfile>;

export type KodaXProviderTransport = 'native-api' | 'cli-bridge';

export type KodaXProviderConversationSemantics =
  | 'full-history'
  | 'last-user-message';

export type KodaXProviderMcpSupport = 'native' | 'none';

export type KodaXProviderContextFidelity = 'full' | 'partial' | 'lossy';

export type KodaXProviderToolCallingFidelity = 'full' | 'limited' | 'none';

export type KodaXProviderSessionSupport = 'full' | 'limited' | 'stateless';

export type KodaXProviderLongRunningSupport = 'full' | 'limited' | 'none';

export type KodaXProviderMultimodalSupport = 'none' | 'image-input' | 'full';

export type KodaXProviderEvidenceSupport = 'full' | 'limited' | 'none';

export interface KodaXProviderCapabilityProfile {
  transport: KodaXProviderTransport;
  conversationSemantics: KodaXProviderConversationSemantics;
  mcpSupport: KodaXProviderMcpSupport;
  contextFidelity?: KodaXProviderContextFidelity;
  toolCallingFidelity?: KodaXProviderToolCallingFidelity;
  sessionSupport?: KodaXProviderSessionSupport;
  longRunningSupport?: KodaXProviderLongRunningSupport;
  multimodalSupport?: KodaXProviderMultimodalSupport;
  evidenceSupport?: KodaXProviderEvidenceSupport;
}

export type KodaXReasoningMode =
  | 'off'
  | 'auto'
  | 'quick'
  | 'balanced'
  | 'deep';

export type KodaXThinkingDepth =
  | 'off'
  | 'low'
  | 'medium'
  | 'high';

export type KodaXTaskType =
  | 'conversation'
  | 'lookup'
  | 'review'
  | 'bugfix'
  | 'edit'
  | 'refactor'
  | 'plan'
  | 'qa'
  | 'unknown';

export type KodaXExecutionMode =
  | 'conversation'
  | 'lookup'
  | 'pr-review'
  | 'strict-audit'
  | 'implementation'
  | 'planning'
  | 'investigation';

export type KodaXRiskLevel = 'low' | 'medium' | 'high';

export type KodaXTaskComplexity =
  | 'simple'
  | 'moderate'
  | 'complex'
  | 'systemic';

export type KodaXTaskWorkIntent = 'append' | 'overwrite' | 'new';

export type KodaXTaskFamily =
  | 'conversation'
  | 'lookup'
  | 'review'
  | 'implementation'
  | 'investigation'
  | 'planning'
  | 'ambiguous';

export type KodaXTaskActionability =
  | 'non_actionable'
  | 'actionable'
  | 'ambiguous';

export type KodaXExecutionPattern =
  | 'direct'
  | 'checked-direct'
  | 'coordinated';

export type KodaXMutationSurface =
  | 'read-only'
  | 'docs-only'
  | 'code'
  | 'system';

export type KodaXAssuranceIntent =
  | 'default'
  | 'explicit-check';

export type KodaXHarnessProfile =
  | 'H0_DIRECT'
  | 'H1_EXECUTE_EVAL'
  | 'H2_PLAN_EXECUTE_EVAL'
  // FEATURE_114 v0.7.36: PLANNED is the V2 harness profile that
  // collapses Scout / Planner / Generator into a single Worker. The
  // legacy three profiles stay live during the migration window
  // (KODAX_HARNESS_V2 default off until v0.7.40). PLANNED runs preserve
  // the Evaluator structural gate.
  | 'PLANNED';

export type KodaXReviewScale =
  | 'small'
  | 'large'
  | 'massive';

// KodaXChildFanoutClass is the child-task display/dispatch classification used by
// dispatch_child_task, child bundles/status, and the REPL work strip — it is
// independent of the retired AMA-controller advisory (ADR-043) and stays live.
export type KodaXChildFanoutClass =
  | 'finding-validation'
  | 'evidence-scan'
  | 'module-triage'
  | 'hypothesis-check';

export interface KodaXTaskRoutingDecision {
  primaryTask: KodaXTaskType;
  secondaryTask?: KodaXTaskType;
  taskFamily?: KodaXTaskFamily;
  actionability?: KodaXTaskActionability;
  executionPattern?: KodaXExecutionPattern;
  mutationSurface?: KodaXMutationSurface;
  assuranceIntent?: KodaXAssuranceIntent;
  confidence: number;
  riskLevel: KodaXRiskLevel;
  recommendedMode: KodaXExecutionMode;
  recommendedThinkingDepth: KodaXThinkingDepth;
  complexity: KodaXTaskComplexity;
  workIntent: KodaXTaskWorkIntent;
  requiresBrainstorm: boolean;
  harnessProfile: KodaXHarnessProfile;
  topologyCeiling?: KodaXHarnessProfile;
  upgradeCeiling?: KodaXHarnessProfile;
  reviewScale?: KodaXReviewScale;
  reviewTarget?: 'general' | 'current-worktree' | 'compare-range';
  soloBoundaryConfidence?: number;
  needsIndependentQA?: boolean;
  routingSource?: 'model' | 'fallback' | 'retried-model' | 'retried-fallback';
  routingAttempts?: number;
  routingNotes?: string[];
  reason: string;
}

export interface KodaXThinkingBudgetMap {
  low: number;
  medium: number;
  high: number;
}

export type KodaXTaskBudgetOverrides = Partial<
  Record<KodaXTaskType, Partial<KodaXThinkingBudgetMap>>
>;

export interface KodaXReasoningRequest {
  enabled?: boolean;
  /**
   * Canonical reasoning control. Reasoning single-tracking removed the legacy
   * `mode` (KodaXReasoningMode) + `depth` (KodaXThinkingDepth) request fields —
   * callers pass `effort` (or `enabled` as a boolean shorthand). Providers
   * derive any thinking budget from the effort via `effortToThinkingDepth`.
   */
  effort?: KodaXWireReasoningEffort;
  taskType?: KodaXTaskType;
  executionMode?: KodaXExecutionMode;
}

export interface KodaXNormalizedReasoningRequest {
  enabled: boolean;
  effort: KodaXWireReasoningEffort;
  effortSource?: 'explicit' | 'legacy' | 'omitted';
  taskType: KodaXTaskType;
  executionMode: KodaXExecutionMode;
}

// ============== Provider 配置 ==============

export interface KodaXModelDescriptor {
  id: string;
  /** Optional local alias target sent as the upstream API model id. */
  wireModel?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * Per-model OpenAI Chat Completions field for the output-token limit.
   * Defaults to the provider-level value, then `max_completion_tokens`.
   */
  maxOutputTokensField?: KodaXOpenAICompatMaxOutputTokensField;
  thinkingBudgetCap?: number;
  /** @deprecated Auto-migrated on load. Prefer `reasoning: { efforts, default }`. */
  reasoningCapability?: KodaXReasoningCapability;
  /** @deprecated Internal preset name; auto-migrated on load. Prefer `reasoning`. */
  reasoningPreset?: KodaXReasoningPresetName;
  /**
   * Canonical reasoning declaration: friendly `{ efforts, default }`, `"none"`,
   * or (advanced) a raw `Partial<KodaXReasoningProfile>` override. See
   * `KodaXReasoningConfig`.
   */
  reasoning?: KodaXReasoningConfig;
  reasoningProfile?: KodaXReasoningProfile;
  /**
   * Per-model override for `replayReasoningContent`. Falls through to the
   * provider-level flag when undefined. Lets a single gateway endpoint
   * route models that need the flag (DeepSeek V4) alongside models that
   * would 400 if the flag were on (OpenAI proper).
   */
  replayReasoningContent?: boolean;
  /**
   * Per-model override for `strictThinkingSignature`. Falls through to
   * the provider-level flag when undefined.
   */
  strictThinkingSignature?: boolean;
  /**
   * Per-model override for `streamMaxDurationMs`. Falls through to the
   * provider-level cap when undefined; undefined at both levels disables
   * the watchdog.
   */
  streamMaxDurationMs?: number;
}

export type KodaXProtocolFamily = 'anthropic' | 'openai';
export type KodaXProviderUserAgentMode = 'compat' | 'sdk';
export type KodaXOpenAICompatMaxOutputTokensField =
  | 'max_tokens'
  | 'max_completion_tokens';

/**
 * FEATURE_216 v0.7.45 — Strategy KodaX uses to verify a provider's API
 * credentials. Per-provider data-driven (set in `provider-capabilities.json`)
 * because the 14 providers KodaX ships do not share a single zero-token
 * verify primitive — empirically 3 distinct strategies are needed:
 *
 *   - `count-tokens`: Anthropic-protocol `messages.countTokens()` —
 *     true 0-token (input_tokens reported but no model invocation).
 *     Use for Anthropic-compat providers whose upstream implements
 *     `/v1/messages/count_tokens`.
 *   - `models-list`: `models.list()` — 0-token, authenticated GET.
 *     Use ONLY when the provider's `/v1/models` endpoint actually
 *     gates on auth (some compat layers expose it publicly → false
 *     positives; others 401 even for valid keys → false negatives).
 *   - `minimal-message`: `{messages,chat.completions}.create({max_tokens:1})`
 *     — ~6-7 tokens / call. Universal fallback for providers where
 *     the above two are unreliable. Cost is trivial for UI-button
 *     "test connection" use cases (≈ $0.00001 per verify).
 *   - `unsupported`: Provider has no verify primitive (CLI bridges
 *     own credentials in their own subprocess token store; the SDK
 *     does not enter that surface).
 */
export type KodaXVerifyStrategy =
  | 'count-tokens'
  | 'models-list'
  | 'minimal-message'
  | 'unsupported';

/**
 * FEATURE_216 v0.7.45 — Never-throws result envelope for
 * `provider.verifyCredential()` / `verifyProviderCredential(name)`.
 * Mirrors `side-query.ts` `SideQueryResult` pattern: every failure
 * mode is captured in the returned object — no rejection, no throw.
 */
export interface KodaXVerifyCredentialResult {
  readonly ok: boolean;
  /** HTTP status when applicable (verify primitives that hit the wire). */
  readonly status?: number;
  /**
   * Error category. Stable for UI consumers to map to user-facing
   * states ("invalid key", "no network", "provider doesn't support
   * verification", etc.). `unconfigured` is set by the top-level
   * helper when env var is missing — avoids the provider ctor throw
   * (per FEATURE_198 model-capabilities exposure pattern).
   */
  readonly error?:
    | 'unauthorized'
    | 'network'
    | 'timeout'
    | 'unsupported'
    | 'unconfigured'
    | 'server_error'
    | 'rate_limited'
    | 'unknown';
  /** Upstream error body or short diagnostic, capped to 240 chars. */
  readonly message?: string;
  readonly durationMs: number;
  /** Estimated token cost: 0 (count-tokens / models-list) or ~6-7 (minimal-message). */
  readonly approxTokensSpent: number;
  /** Which strategy ran (or 'unsupported' if no primitive was attempted). */
  readonly strategy: KodaXVerifyStrategy;
}

/**
 * FEATURE_216 v0.7.45 — Best-effort upstream model listing. Distinct from
 * credential verification: this is for "model picker" UIs. Mixes upstream
 * `/v1/models` data with static `provider-capabilities.json` fallback when
 * the upstream endpoint is unreliable. NOT a cred test — for that, call
 * `verifyProviderCredential()`.
 */
export interface KodaXListModelsResult {
  readonly ok: boolean;
  readonly source: 'upstream' | 'static' | 'failed';
  readonly models?: readonly string[];
  readonly error?: string;
  readonly durationMs: number;
}

export interface KodaXCustomProviderConfig {
  name: string;
  protocol: KodaXProtocolFamily;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  /** @deprecated Internal preset name; auto-migrated on load. Prefer `reasoning`. */
  reasoningPreset?: KodaXReasoningPresetName;
  /**
   * Canonical reasoning declaration for this provider: friendly
   * `{ efforts, default }`, `"none"`, or (advanced) a raw profile override.
   * See `KodaXReasoningConfig`.
   */
  reasoning?: KodaXReasoningConfig;
  /**
   * Additional available models beyond the default. Accepts either a
   * plain model id string (legacy) or a KodaXModelDescriptor object
   * (FEATURE_098) carrying per-model `contextWindow` / `maxOutputTokens`
   * / `thinkingBudgetCap` / `reasoningCapability` overrides.
   */
  models?: Array<string | KodaXModelDescriptor>;
  /**
   * Controls which User-Agent header compatibility providers send.
   * - compat: send "KodaX" for gateways that block the official SDK UA
   * - sdk: keep the upstream SDK default User-Agent
   */
  userAgentMode?: KodaXProviderUserAgentMode;
  /** @deprecated Auto-migrated on load. Prefer `reasoning: "none"` (off) or `reasoning: { efforts, default }`. */
  supportsThinking?: boolean;
  /** @deprecated Auto-migrated on load. Prefer `reasoning: { efforts, default }`. */
  reasoningCapability?: KodaXReasoningCapability;
  reasoningProfile?: KodaXReasoningProfile;
  /**
   * Friendly image-input opt-in for self-hosted multimodal endpoints
   * (vLLM / SGLang serving Qwen-VL-style models over an OpenAI- or
   * Anthropic-compatible API). `true` forces
   * `capabilityProfile.multimodalSupport: 'image-input'` on every surface
   * (provider instance, capability queries, policy gates); any other value
   * leaves an explicit `capabilityProfile` untouched.
   */
  imageInput?: boolean;
  capabilityProfile?: KodaXProviderCapabilityProfile;
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * OpenAI Chat Completions field used for the output-token limit. Set to
   * `max_tokens` for DeepSeek-compatible endpoints. Defaults to
   * `max_completion_tokens`; model descriptors may override it.
   */
  maxOutputTokensField?: KodaXOpenAICompatMaxOutputTokensField;
  thinkingBudgetCap?: number;
  /**
   * Opt in only when this exact endpoint is known to accept the protocol's
   * cache-affinity field. Anthropic-compatible providers lower it to
   * `metadata.user_id`; OpenAI-compatible providers lower it to
   * `prompt_cache_key`. Disabled by default because strict compatibility
   * gateways may reject unknown request fields.
   */
  promptCacheAffinity?: boolean;
  /**
   * Provider-level default for OpenAI-compat `reasoning_content` echo.
   * Required by DeepSeek V4 thinking mode (replay 400s without it).
   * Defaults to false — must stay false for OpenAI proper or any gateway
   * that rejects unknown fields. Per-model values in `models[]` can
   * override on a model-by-model basis.
   */
  replayReasoningContent?: boolean;
  /**
   * Provider-level default for strict Anthropic thinking-signature
   * verification. Only Anthropic proper cryptographically verifies
   * signatures — third-party Anthropic-compat gateways must keep this
   * false (default). Per-model values in `models[]` can override.
   */
  strictThinkingSignature?: boolean;
  /**
   * Provider-level default streaming wall-clock cap (ms). Set just below
   * a known server-side kill window (zhipu-coding 308s → 300_000). Leave
   * unset to disable the watchdog. Per-model values in `models[]` can
   * override.
   */
  streamMaxDurationMs?: number;
  /**
   * FEATURE_216 v0.7.45 — Which verify primitive this provider supports.
   * Optional: when unset, the SDK derives a default from `protocol`
   * (anthropic → count-tokens / openai → models-list). Set explicitly when
   * the upstream `/v1/models` is public (false-positive risk) or the
   * `messages.count_tokens` endpoint is unimplemented (404), in which
   * case `minimal-message` is the only safe fallback.
   */
  verifyStrategy?: KodaXVerifyStrategy;
}

export interface KodaXProviderConfig {
  apiKeyEnv: string;
  baseUrl?: string;
  model: string;
  /** Additional available models beyond the default */
  models?: readonly KodaXModelDescriptor[];
  /** Compatibility providers may override the SDK User-Agent when needed. */
  userAgentMode?: KodaXProviderUserAgentMode;
  supportsThinking: boolean;
  reasoningCapability?: KodaXReasoningCapability;
  reasoningProfile?: KodaXReasoningProfile;
  capabilityProfile?: KodaXProviderCapabilityProfile;
  /** 模型的上下文窗口大小 (tokens) */
  contextWindow?: number;
  /** Provider 允许的最大输出 token */
  maxOutputTokens?: number;
  /** OpenAI Chat Completions output-token field; model descriptors override it. */
  maxOutputTokensField?: KodaXOpenAICompatMaxOutputTokensField;
  /** Provider thinking budget 上限 */
  thinkingBudgetCap?: number;
  /** Whether this verified endpoint accepts the protocol cache-affinity field. */
  promptCacheAffinity?: boolean;
  /** Provider 默认 thinking budget 映射 */
  defaultThinkingBudgets?: Partial<KodaXThinkingBudgetMap>;
  /** 按任务类型覆盖默认 budget */
  taskBudgetOverrides?: KodaXTaskBudgetOverrides;
  /**
   * Echo the prior turn's `reasoning_content` back on replayed assistant
   * messages. Required by DeepSeek V4 thinking mode (replay 400s without it).
   * Other Chinese OpenAI-compat thinking providers use the same field, but
   * each needs per-provider verification before opting in. Must stay false
   * for OpenAI proper.
   */
  replayReasoningContent?: boolean;
  /**
   * Strictly verify Anthropic-style `signature` on `thinking` blocks at
   * serialise time. Only Anthropic proper (anthropic.com) cryptographically
   * verifies signatures — third-party Anthropic-compat servers (kimi-code /
   * ark-coding / mimo-coding / zhipu-coding / minimax-coding) lack the
   * signing key and accept any signature.
   *
   * When true, thinking blocks with empty/cross-provider signatures get
   * converted to a `<prior_reasoning>` text block instead of being passed
   * through (which would 400 on signature verification). Cross-provider
   * `redacted_thinking` blocks (ciphertext signed by their origin) are
   * dropped silently — there's no plaintext to recover and forging the
   * field would also fail server-side decryption.
   *
   * When false (default), thinking blocks pass through unchanged — matches
   * legacy behaviour and works for all third-party Anthropic-compat
   * providers. v0.7.28.
   */
  strictThinkingSignature?: boolean;
  /**
   * Hard cap on a single streaming request's wall-clock duration (ms).
   * When exceeded, the resilience layer aborts the stream with a
   * StreamIncompleteError, which routes through the existing
   * `non_streaming_fallback` path. Mirrors Claude Code's idle watchdog
   * pattern but uses request duration (not idle time) because some
   * providers emit keepalive pings during long tool_use generation.
   *
   * Set per-provider just below the known server-side kill window
   * (e.g. zhipu-coding observed 308s → set 300s here, accounting for
   * the ~RTT margin between client send and server kill timestamp).
   */
  streamMaxDurationMs?: number;
  /**
   * FEATURE_216 v0.7.45 — Which verify primitive this provider's compat
   * base class uses for `verifyCredential()`. Sourced from
   * `provider-capabilities.json` for built-in providers; for custom
   * providers, falls back to a protocol-derived default
   * (anthropic → count-tokens / openai → models-list) when the custom
   * config does not set it explicitly.
   */
  verifyStrategy?: KodaXVerifyStrategy;
}

export interface KodaXProviderStreamOptions {
  /** Request-only tail context. Providers must not mutate persisted messages. */
  ephemeralSuffix?: KodaXEphemeralSuffix;
  /**
   * Opaque stable logical-context key used only for Provider cache routing.
   * Protocol adapters lower it only when their endpoint explicitly opts in.
   */
  promptCacheKey?: string;
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onThinkingEnd?: (thinking: string) => void;
  onToolInputDelta?: (
    toolName: string,
    partialJson: string,
    meta?: { toolId?: string },
  ) => void;
  /**
   * Fired on provider-side SSE events to manage idle timers.
   *
   * - Called with no argument (or `false`): reset the idle timer.
   *   Fired on every event that indicates active data flow
   *   (content_block_start, content_block_delta, message_delta, etc.).
   *
   * - Called with `true`: **pause** the idle timer (clear without restart).
   *   Fired on `content_block_stop` when the stream has NOT yet ended,
   *   because the server may go silent while generating the next block
   *   (e.g. between text output and tool_use JSON generation).
   *   The hard request timeout still guards against genuinely stuck connections.
   */
  onHeartbeat?: (pause?: boolean) => void;
  /** 当底层 API 遇到 Rate Limit 进行重试时触发 */
  onRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void;
  /**
   * FEATURE_130 (v0.7.36): structured retry-after callback. Carries the
   * parsed source (`retry-after-seconds` / `retry-after-date` /
   * `retry-after-ms` / `exponential-backoff`) so UI surfaces and the
   * cost tracker can distinguish "provider-told us to wait" from
   * "we're guessing with backoff". Coexists with the legacy
   * `onRateLimit` flat callback above — both fire if both are wired.
   */
  onRetryAfter?: (event: {
    provider: string;
    waitMs: number;
    reason: 'rate-limit' | 'overloaded';
    source:
      | 'retry-after-seconds'
      | 'retry-after-date'
      | 'retry-after-ms'
      | 'exponential-backoff';
    attempt: number;
    maxAttempts: number;
  }) => void;
  /** 会话标识，用于多轮对话上下文恢复 */
  /**
   * Passive capability learning: fired when a provider HARD-rejects a
   * reasoning-effort value (400/422 naming the param). Hosts can record it via
   * the agent-layer capability cache so the rung is removed from the effective
   * ladder and never offered or sent again (see
   * `classifyReasoningEffortRejection`).
   */
  onReasoningEffortRejected?: (event: {
    provider: string;
    model: string;
    effort: string;
  }) => void;
  sessionId?: string;
  /** Override the provider's default model for a single request */
  modelOverride?: string;
  /** Force a single tool call for one-shot judge/sidecar requests. */
  forcedToolName?: string;
  /** Per-request output budget override for short structured calls. */
  maxOutputTokensOverride?: number;
  /** AbortSignal for cancelling the stream request */
  signal?: AbortSignal;
}
