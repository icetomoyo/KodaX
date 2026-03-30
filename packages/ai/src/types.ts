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
}

export interface KodaXToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
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

export type KodaXContentBlock =
  | KodaXTextBlock
  | KodaXToolUseBlock
  | KodaXToolResultBlock
  | KodaXThinkingBlock
  | KodaXRedactedThinkingBlock;

// ============== 消息类型 ==============

export interface KodaXMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | KodaXContentBlock[];
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
  | 'none'
  | 'prompt-only'
  | 'unknown';

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

export type KodaXReasoningOverride =
  | 'budget'
  | 'effort'
  | 'toggle'
  | 'none';

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
  | 'H2_PLAN_EXECUTE_EVAL';

export type KodaXReviewScale =
  | 'small'
  | 'large'
  | 'massive';

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
  mode?: KodaXReasoningMode;
  depth?: KodaXThinkingDepth;
  taskType?: KodaXTaskType;
  executionMode?: KodaXExecutionMode;
}

// ============== Provider 配置 ==============

export interface KodaXModelDescriptor {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  thinkingBudgetCap?: number;
  reasoningCapability?: KodaXReasoningCapability;
}

export type KodaXProtocolFamily = 'anthropic' | 'openai';
export type KodaXProviderUserAgentMode = 'compat' | 'sdk';

export interface KodaXCustomProviderConfig {
  name: string;
  protocol: KodaXProtocolFamily;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  models?: string[];
  /**
   * Controls which User-Agent header compatibility providers send.
   * - compat: send "KodaX" for gateways that block the official SDK UA
   * - sdk: keep the upstream SDK default User-Agent
   */
  userAgentMode?: KodaXProviderUserAgentMode;
  supportsThinking?: boolean;
  reasoningCapability?: KodaXReasoningCapability;
  capabilityProfile?: KodaXProviderCapabilityProfile;
  contextWindow?: number;
  maxOutputTokens?: number;
  thinkingBudgetCap?: number;
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
  capabilityProfile?: KodaXProviderCapabilityProfile;
  /** 模型的上下文窗口大小 (tokens) */
  contextWindow?: number;
  /** Provider 允许的最大输出 token */
  maxOutputTokens?: number;
  /** Provider thinking budget 上限 */
  thinkingBudgetCap?: number;
  /** Provider 默认 thinking budget 映射 */
  defaultThinkingBudgets?: Partial<KodaXThinkingBudgetMap>;
  /** 按任务类型覆盖默认 budget */
  taskBudgetOverrides?: KodaXTaskBudgetOverrides;
}

export interface KodaXProviderStreamOptions {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onThinkingEnd?: (thinking: string) => void;
  onToolInputDelta?: (
    toolName: string,
    partialJson: string,
    meta?: { toolId?: string },
  ) => void;
  /** 当底层 API 遇到 Rate Limit 进行重试时触发 */
  onRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void;
  /** 会话标识，用于多轮对话上下文恢复 */
  sessionId?: string;
  /** Override the provider's default model for a single request */
  modelOverride?: string;
  /** AbortSignal for cancelling the stream request */
  signal?: AbortSignal;
}
