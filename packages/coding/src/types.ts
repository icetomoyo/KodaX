/**
 * KodaX Core Types
 *
 * 核心类型定义 - 重新导出 @kodax/agent 类型 + Coding 特定类型
 */

// ============== Import from @kodax/agent ==============
// 通用 Agent 类型从 @kodax/agent 导入

import type {
  KodaXImageBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXTokenUsage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXReasoningMode,
  KodaXThinkingDepth,
  KodaXTaskType,
  KodaXExecutionMode,
  KodaXRiskLevel,
  KodaXTaskComplexity,
  KodaXTaskWorkIntent,
  KodaXTaskFamily,
  KodaXTaskActionability,
  KodaXExecutionPattern,
  KodaXMutationSurface,
  KodaXAssuranceIntent,
  KodaXHarnessProfile,
  KodaXAmaProfile,
  KodaXAmaTactic,
  KodaXAmaFanoutClass,
  KodaXAmaFanoutPolicy,
  KodaXAmaControllerDecision,
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXJsonValue,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXExtensionStoreEntry,
  KodaXExtensionStore,
  KodaXCompactMemoryProgress,
  KodaXCompactMemorySeed,
  KodaXSessionBranchSummaryEntry,
  KodaXSessionCompactionEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionEntryBase,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionLabelEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
  KodaXSessionNavigationOptions,
  KodaXSessionScope,
  KodaXSessionMeta,
  KodaXSessionRuntimeInfo,
  KodaXSessionStorage,
  KodaXSessionTreeNode,
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
  KodaXSessionWorkspaceKind,
  SessionErrorMetadata,
} from '@kodax/agent';
import type { KodaXReviewScale } from '@kodax/ai';
import type { CompactionUpdate } from '@kodax/agent';
import type { KodaXExtensionRuntime } from './extensions/runtime.js';
import type {
  FailureStage,
  ResilienceErrorClass,
  RecoveryAction,
  RecoveryLadderStep,
} from './resilience/types.js';

// Re-export all types from @kodax/agent
export type {
  KodaXImageBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXTokenUsage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXReasoningMode,
  KodaXThinkingDepth,
  KodaXTaskType,
  KodaXExecutionMode,
  KodaXRiskLevel,
  KodaXTaskComplexity,
  KodaXTaskWorkIntent,
  KodaXTaskFamily,
  KodaXTaskActionability,
  KodaXExecutionPattern,
  KodaXMutationSurface,
  KodaXAssuranceIntent,
  KodaXHarnessProfile,
  KodaXAmaProfile,
  KodaXAmaTactic,
  KodaXAmaFanoutClass,
  KodaXAmaFanoutPolicy,
  KodaXAmaControllerDecision,
  KodaXReviewScale,
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXJsonValue,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXExtensionStoreEntry,
  KodaXExtensionStore,
  KodaXCompactMemoryProgress,
  KodaXCompactMemorySeed,
  KodaXSessionBranchSummaryEntry,
  KodaXSessionCompactionEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionEntryBase,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionLabelEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
  KodaXSessionNavigationOptions,
  KodaXSessionScope,
  KodaXSessionMeta,
  KodaXSessionRuntimeInfo,
  KodaXSessionStorage,
  KodaXSessionTreeNode,
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
  KodaXSessionWorkspaceKind,
  SessionErrorMetadata,
};

// ============== 事件接口 ==============

export interface KodaXEvents {
  // 流式输出
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onThinkingEnd?: (thinking: string) => void;
  onToolUseStart?: (tool: { name: string; id: string; input?: Record<string, unknown> }) => void;
  onToolResult?: (result: { id: string; name: string; content: string }) => void;
  /** FEATURE_067 v2: Real-time tool execution progress update. Updates the tool's display in the REPL transcript. */
  onToolProgress?: (update: { id: string; message: string }) => void;
  onToolInputDelta?: (
    toolName: string,
    partialJson: string,
    meta?: { toolId?: string },
  ) => void;
  onStreamEnd?: () => void;

  // 状态通知
  onSessionStart?: (info: { provider: string; sessionId: string }) => void;
  onIterationStart?: (iter: number, maxIter: number) => void;
  /** Called after each iteration with current token count for UI updates */
  onIterationEnd?: (info: {
    iter: number;
    maxIter: number;
    tokenCount: number;
    tokenSource: 'api' | 'estimate';
    usage?: KodaXTokenUsage;
    contextTokenSnapshot?: KodaXContextTokenSnapshot;
  }) => void;
  onCompactStart?: () => void;
  /** Emitted when compaction finishes and actually changed the context */
  onCompact?: (estimatedTokens: number) => void;
  /** Emitted when compaction changes the context so UI can refresh token usage immediately */
  onCompactStats?: (info: { tokensBefore: number; tokensAfter: number }) => void;
  /** Emitted with the rewritten message history when automatic compaction changes the context. */
  onCompactedMessages?: (messages: KodaXMessage[], update?: CompactionUpdate) => void;
  /** Emitted to silently dismiss the compaction UI if compaction aborted or completed without changes */
  onCompactEnd?: () => void;
  /** Whether the caller has queued follow-up input waiting for the next round */
  hasPendingInputs?: () => boolean;
  onRetry?: (reason: string, attempt: number, maxAttempts: number) => void;
  onProviderRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void;
  onRepoIntelligenceTrace?: (event: KodaXRepoIntelligenceTraceEvent) => void;
  /** Structured provider recovery event (Feature 045) */
  onProviderRecovery?: (event: ProviderRecoveryEvent) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
  onManagedTaskStatus?: (status: KodaXManagedTaskStatusEvent) => void;
  /** Returns a formatted cost report for the current session. Set by agent at session start. */
  getCostReport?: { current: (() => string) | null };

  // 用户交互（可选，由 REPL 层实现）
  /** Tool execution hook - called before tool execution, return false to block - 工具执行前回调 */
  beforeToolExecute?: (
    tool: string,
    input: Record<string, unknown>,
    meta?: { toolId?: string }
  ) => Promise<boolean | string>;
  /** Ask user a question interactively - Issue 069 - 交互式向用户提问 */
  askUser?: (options: AskUserQuestionOptions) => Promise<string>;
  /** Ask user multiple independent questions sequentially - 多问题顺序提问 */
  askUserMulti?: (options: AskUserMultiOptions) => Promise<Record<string, string> | undefined>;
  /** Ask user for free-text input - 自由文本输入 (Issue 112) */
  askUserInput?: (options: { question: string; default?: string }) => Promise<string | undefined>;
  /** Switch session permission mode — called by set_permission_mode tool. */
  setPermissionMode?: (mode: string) => void;
  /** Managed-worker role currently allowed to emit structured protocol payload. */
}


// ============== Provider Recovery Event (Feature 045) ==============

/**
 * Structured event emitted during provider recovery.
 * Provides fine-grained information about the failure, recovery strategy,
 * and current state of the retry ladder.
 */
export interface ProviderRecoveryEvent {
  /** The failure stage when the error occurred. */
  stage: FailureStage;
  /** The classified error class. */
  errorClass: ResilienceErrorClass;
  /** Current attempt number (1-based). */
  attempt: number;
  /** Maximum automatic retry attempts. */
  maxAttempts: number;
  /** Delay before next attempt (ms). */
  delayMs: number;
  /** The recovery action being taken. */
  recoveryAction: RecoveryAction;
  /** Step in the recovery ladder (1-4). */
  ladderStep: RecoveryLadderStep;
  /** Whether non-streaming fallback has been used. */
  fallbackUsed: boolean;
  /** Server-provided Retry-After value (ms), if available. */
  serverRetryAfterMs?: number;
}

// ============== Agent 选项 ==============

export interface KodaXSessionOptions {
  id?: string;
  resume?: boolean;
  autoResume?: boolean;
  scope?: KodaXSessionScope;
  storage?: KodaXSessionStorage;
  initialMessages?: KodaXMessage[];
}

export interface KodaXContextTokenSnapshot {
  /** Current best-known token count for the full conversation context. */
  currentTokens: number;
  /** Local estimate for the same message set, used to adjust later message deltas. */
  baselineEstimatedTokens: number;
  /** Whether the snapshot is based on provider/API usage or local estimation. */
  source: 'api' | 'estimate';
  /** Optional turn usage from the latest provider response. */
  usage?: KodaXTokenUsage;
}

export interface KodaXProviderPolicyHints {
  longRunning?: boolean;
  harness?: 'project';
  harnessProfile?: KodaXHarnessProfile;
  evidenceHeavy?: boolean;
  multimodal?: boolean;
  capabilityRuntime?: boolean;
  mcpRequired?: boolean;
  brainstorm?: boolean;
  workIntent?: KodaXTaskWorkIntent;
}

export type KodaXMcpTransport = 'stdio' | 'sse' | 'streamable-http';
export type KodaXMcpConnectMode = 'lazy' | 'prewarm' | 'disabled';

export interface KodaXMcpServerConfig {
  /** Transport type. Defaults to 'stdio' when omitted. */
  type?: KodaXMcpTransport;
  /** stdio: executable command. */
  command?: string;
  /** stdio: command arguments. */
  args?: string[];
  /** stdio: working directory for the spawned process. */
  cwd?: string;
  /** stdio: extra environment variables for the spawned process. */
  env?: Record<string, string>;
  /** sse / streamable-http: server endpoint URL. */
  url?: string;
  /** sse / streamable-http: extra HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>;
  connect?: KodaXMcpConnectMode;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** OAuth 2.0 configuration for authenticated MCP servers. */
  auth?: {
    readonly type: 'oauth2';
    readonly clientId: string;
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly scopes?: readonly string[];
    readonly redirectPort?: number;
  };
}
/** Flat map of MCP server configs, keyed under `mcpServers` in config.json. */
export type KodaXMcpServersConfig = Record<string, KodaXMcpServerConfig>;

export type KodaXRepoIntelligenceMode =
  | 'auto'
  | 'off'
  | 'oss'
  | 'premium-shared'
  | 'premium-native';

export type KodaXRepoIntelligenceResolvedMode =
  | 'off'
  | 'oss'
  | 'premium-shared'
  | 'premium-native';

export interface KodaXRepoIntelligenceCapability {
  mode: KodaXRepoIntelligenceResolvedMode;
  engine: 'oss' | 'premium';
  bridge: 'none' | 'shared' | 'native';
  level: 'basic' | 'enhanced';
  status: 'ok' | 'limited' | 'unavailable' | 'warming';
  warnings: string[];
  contractVersion?: number;
}

export interface KodaXRepoIntelligenceTrace {
  mode: KodaXRepoIntelligenceResolvedMode;
  engine: 'oss' | 'premium';
  bridge: 'none' | 'shared' | 'native';
  triggeredAt: string;
  source: 'fallback' | 'premium';
  daemonLatencyMs?: number;
  cliLatencyMs?: number;
  cacheHit?: boolean;
  capsuleBytes?: number;
  capsuleEstimatedTokens?: number;
}

export interface KodaXRepoIntelligenceTraceEvent {
  stage: 'routing' | 'preturn' | 'module' | 'impact' | 'task-snapshot';
  summary: string;
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface KodaXRepoIntelligenceCarrier {
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface KodaXRepoRoutingSignals {
  workspaceRoot?: string;
  changedFileCount: number;
  changedLineCount: number;
  addedLineCount: number;
  deletedLineCount: number;
  touchedModuleCount: number;
  changedModules: string[];
  crossModule: boolean;
  reviewScale?: KodaXReviewScale;
  riskHints: string[];
  activeModuleId?: string;
  activeModuleConfidence?: number;
  activeImpactConfidence?: number;
  impactedModuleCount?: number;
  impactedSymbolCount?: number;
  predominantCapabilityTier?: 'high' | 'medium' | 'low';
  suggestedComplexity?: KodaXTaskComplexity;
  plannerBias: boolean;
  investigationBias: boolean;
  lowConfidence: boolean;
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface KodaXTaskCapabilityHint {
  kind: 'skill' | 'tool' | 'command' | 'workflow';
  name: string;
  details?: string;
}

export interface KodaXTaskVerificationCriterion {
  id: string;
  label: string;
  description: string;
  threshold: number;
  weight: number;
  requiredEvidence?: string[];
}

export interface KodaXRuntimeVerificationContract {
  startupCommand?: string;
  cwd?: string;
  env?: Record<string, string>;
  readySignal?: string;
  baseUrl?: string;
  uiFlows?: string[];
  apiChecks?: string[];
  dbChecks?: string[];
  fixtures?: string[];
}

export interface KodaXTaskVerificationContract {
  summary?: string;
  instructions?: string[];
  requiredEvidence?: string[];
  requiredChecks?: string[];
  capabilityHints?: KodaXTaskCapabilityHint[];
  rubricFamily?: 'code-review' | 'frontend' | 'product-completeness' | 'functionality' | 'code-quality';
  criteria?: KodaXTaskVerificationCriterion[];
  runtime?: KodaXRuntimeVerificationContract;
}

export type KodaXSkillProjectionConfidence = 'high' | 'medium' | 'low';

export interface KodaXSkillInvocationContext {
  name: string;
  path: string;
  description?: string;
  arguments?: string;
  allowedTools?: string;
  context?: 'fork';
  agent?: string;
  argumentHint?: string;
  model?: string;
  hookEvents?: string[];
  expandedContent: string;
}

export interface KodaXSkillMap {
  skillSummary: string;
  executionObligations: string[];
  verificationObligations: string[];
  requiredEvidence: string[];
  ambiguities: string[];
  projectionConfidence: KodaXSkillProjectionConfidence;
  rawSkillFallbackAllowed: boolean;
  allowedTools?: string;
  preferredAgent?: string;
  preferredModel?: string;
  invocationContext?: 'fork';
  hookEvents?: string[];
}

export interface KodaXTaskToolPolicy {
  summary: string;
  allowedTools?: string[];
  blockedTools?: string[];
  allowedShellPatterns?: string[];
  allowedWritePathPatterns?: string[];
}

export interface KodaXChildContextBundle {
  id: string;
  fanoutClass: KodaXAmaFanoutClass;
  objective: string;
  scopeSummary?: string;
  evidenceRefs: string[];
  constraints: string[];
  readOnly: boolean;
}

export interface KodaXChildAgentResult {
  childId: string;
  fanoutClass: KodaXAmaFanoutClass;
  status: 'completed' | 'blocked' | 'failed';
  disposition: 'candidate' | 'valid' | 'false-positive' | 'needs-more-evidence';
  summary: string;
  evidenceRefs: string[];
  contradictions: string[];
  artifactPaths?: string[];
  sessionId?: string;
  /** Actual iterations consumed by this child agent. */
  actualIterations?: number;
}

export interface KodaXParentReductionContract {
  owner: 'parent';
  strategy: 'direct-parent' | 'evaluator-assisted' | 'reducer-child';
  collapseChildTranscripts: boolean;
  summary: string;
  requiredArtifacts: string[];
}

export interface KodaXChildExecutionResult {
  readonly results: readonly KodaXChildAgentResult[];
  readonly mergedFindings: readonly KodaXChildFinding[];
  readonly mergedArtifacts: readonly string[];
  readonly totalTokensUsed: number;
  readonly cancelledChildren: readonly string[];
  /** Worktree paths for write children, keyed by childId. Available for evaluator review. */
  readonly worktreePaths?: ReadonlyMap<string, string>;
}

export interface KodaXChildFinding {
  readonly childId: string;
  readonly objective: string;
  readonly evidence: readonly string[];
  readonly artifacts: readonly string[];
}

export interface KodaXFanoutSchedulerInput {
  profile: KodaXAmaProfile;
  fanoutClass: KodaXAmaFanoutClass;
  maxChildren?: number;
  bundles: KodaXChildContextBundle[];
  reductionStrategy: KodaXParentReductionContract['strategy'];
}

export type KodaXFanoutBranchLifecycle = 'scheduled' | 'deferred' | 'completed' | 'cancelled';

export interface KodaXFanoutBranchRecord {
  bundleId: string;
  status: KodaXFanoutBranchLifecycle;
  workerId?: string;
  childId?: string;
  reason?: string;
}

export type KodaXFanoutBranchTransition =
  | {
    type: 'assign';
    bundleId: string;
    workerId: string;
  }
  | {
    type: 'complete';
    bundleId: string;
    childId?: string;
  }
  | {
    type: 'cancel';
    bundleId: string;
    reason: string;
  };

export interface KodaXFanoutSchedulerPlan {
  enabled: boolean;
  profile: KodaXAmaProfile;
  fanoutClass: KodaXAmaFanoutClass;
  branches: KodaXFanoutBranchRecord[];
  scheduledBundleIds: string[];
  deferredBundleIds: string[];
  maxParallel: number;
  mergeStrategy: KodaXParentReductionContract['strategy'];
  cancellationPolicy: 'none' | 'winner-cancel' | 'budget-cancel';
  reason: string;
}

export type KodaXAgentMode = 'ama' | 'sa';
export type KodaXMemoryStrategy = 'continuous' | 'compact' | 'reset-handoff';
export type KodaXBudgetDisclosureZone = 'green' | 'yellow' | 'orange' | 'red';

export interface KodaXManagedTaskHarnessTransition {
  from: KodaXHarnessProfile;
  to: KodaXHarnessProfile;
  round: number;
  source: 'scout' | 'evaluator';
  reason?: string;
  approved: boolean;
  denialReason?: string;
}

export type KodaXManagedTaskPhase =
  | 'starting'
  | 'routing'
  | 'preflight'
  | 'round'
  | 'worker'
  | 'upgrade'
  | 'completed';

export type KodaXManagedLiveEventPresentation =
  | 'status'
  | 'assistant'
  | 'thinking';

export interface KodaXManagedLiveEvent {
  key: string;
  kind: 'progress' | 'completed' | 'notification' | 'warning';
  presentation?: KodaXManagedLiveEventPresentation;
  phase?: KodaXManagedTaskPhase;
  workerId?: string;
  workerTitle?: string;
  summary: string;
  detail?: string;
  persistToHistory?: boolean;
}

export interface KodaXManagedTaskStatusEvent {
  agentMode: KodaXAgentMode;
  harnessProfile: KodaXHarnessProfile;
  activeWorkerId?: string;
  activeWorkerTitle?: string;
  childFanoutClass?: KodaXAmaFanoutClass;
  childFanoutCount?: number;
  currentRound?: number;
  maxRounds?: number;
  phase?: KodaXManagedTaskPhase;
  note?: string;
  detailNote?: string;
  events?: KodaXManagedLiveEvent[];
  persistToHistory?: boolean;
  upgradeCeiling?: KodaXHarnessProfile;
  globalWorkBudget?: number;
  budgetUsage?: number;
  budgetApprovalRequired?: boolean;
}

export interface KodaXVerificationScorecardCriterion {
  id: string;
  label: string;
  threshold: number;
  score: number;
  passed: boolean;
  weight: number;
  requiredEvidence?: string[];
  evidence?: string[];
  reason?: string;
}

export interface KodaXVerificationScorecard {
  rubricFamily?: KodaXTaskVerificationContract['rubricFamily'];
  overallScore: number;
  verdict: 'accept' | 'revise' | 'blocked';
  criteria: KodaXVerificationScorecardCriterion[];
  trend?: 'improving' | 'flat' | 'regressing';
  summary?: string;
}

export interface KodaXRoleRoundSummary {
  role: KodaXTaskRole;
  round: number;
  objective: string;
  confirmedConclusions: string[];
  unresolvedQuestions: string[];
  nextFocus: string[];
  summary: string;
  sourceWorkerId?: string;
  updatedAt: string;
}

export interface KodaXBudgetExtensionRequest {
  requestedIters: 1 | 2 | 3;
  reason: string;
  completionExpectation: string;
  confidenceToFinish: number;
  fallbackIfDenied: string;
}

export interface KodaXManagedBudgetSnapshot {
  totalBudget: number;
  reserveBudget: number;
  reserveRemaining: number;
  upgradeReserveBudget?: number;
  upgradeReserveRemaining?: number;
  plannedRounds: number;
  currentRound: number;
  spentBudget: number;
  remainingBudget: number;
  workerId?: string;
  role?: KodaXTaskRole;
  currentHarness?: KodaXHarnessProfile;
  upgradeCeiling?: KodaXHarnessProfile;
  zone?: KodaXBudgetDisclosureZone;
  showExactRoundCounter?: boolean;
  allowExtensionRequest?: boolean;
  mustConverge?: boolean;
  softMaxIter?: number;
  hardMaxIter?: number;
  extensionGrantedIters?: number;
  extensionDenied?: boolean;
  extensionReason?: string;
}

/** Mutable tracker for Scout mutation scope — shared between worker events and protocol tool. */
export interface ManagedMutationTracker {
  readonly files: Map<string, number>;
  totalOps: number;
}

export interface KodaXContextOptions {
  /** Project root used for project-scoped prompts, permissions, and path policy. */
  gitRoot?: string | null;
  /**
   * Explicit working directory used for prompt context, relative tool paths,
   * and shell execution. Defaults to `gitRoot`, then `process.cwd()`.
   */
  executionCwd?: string;
  /**
   * Best-known token snapshot for the current conversation history.
   * When present, the core will prefer it over local estimation and rebase it as
   * messages change.
   */
  contextTokenSnapshot?: KodaXContextTokenSnapshot;
  projectSnapshot?: string;
  longRunning?: {
    featuresFile?: string;
    progressFile?: string;
  };
  /** Optional semantic hints for provider-policy evaluation. */
  providerPolicyHints?: KodaXProviderPolicyHints;
  /** Optional repository routing signals that downstream planning layers can reuse. */
  repoRoutingSignals?: KodaXRepoRoutingSignals;
  /** Optional repo-intelligence mode override for this run. */
  repoIntelligenceMode?: KodaXRepoIntelligenceMode;
  /** Optional repo-intelligence trace toggle for this run. */
  repoIntelligenceTrace?: boolean;
  disableAutoTaskReroute?: boolean;
  /** Skills system prompt snippet for progressive disclosure - Skills 系统提示词片段（渐进式披露） */
  skillsPrompt?: string;
  rawUserInput?: string;
  skillInvocation?: KodaXSkillInvocationContext;
  /** Optional repository-intelligence snapshot injected into the system prompt. */
  repoIntelligenceContext?: string;
  /** Optional user-supplied artifacts carried with the current prompt. */
  inputArtifacts?: KodaXInputArtifact[];
  /** Internal execution-mode overlay appended to the system prompt */
  promptOverlay?: string;
  /** Optional task-engine surface label used to track managed tasks across UX entry points. */
  taskSurface?: KodaXTaskSurface;
  /** Optional directory where managed task artifacts should be written. */
  managedTaskWorkspaceDir?: string;
  /** Internal managed-worker protocol emission configuration. */
  managedProtocolEmission?: {
    enabled: boolean;
    role: Exclude<KodaXTaskRole, 'direct'>;
  };
  /** Mutable mutation tracker shared between worker events and the protocol tool handler. */
  mutationTracker?: ManagedMutationTracker;
  /** FEATURE_067 v2: Callback for dispatch_child_tasks to register write worktree paths. */
  registerChildWriteWorktrees?: (worktreePaths: ReadonlyMap<string, string>) => void;
  /** FEATURE_067 v3: Tool names to exclude from API-level tool list (child agents). */
  excludeTools?: readonly string[];
  /**
   * FEATURE_067 v3: Override the entire system prompt for this run.
   * When set, buildSystemPromptSnapshot is skipped — only this string is used.
   * Used for child agents that need a focused, lightweight prompt instead of the full system.
   */
  systemPromptOverride?: string;
  /** Optional structured metadata carried into the managed task contract. */
  taskMetadata?: Record<string, KodaXJsonValue>;
  /** Optional structured verification contract carried into managed tasks. */
  taskVerification?: KodaXTaskVerificationContract;
}

export interface KodaXOptions {
  provider: string;
  model?: string;
  modelOverride?: string;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
  agentMode?: KodaXAgentMode;
  maxIter?: number;
  session?: KodaXSessionOptions;
  context?: KodaXContextOptions;
  events?: KodaXEvents;
  extensionRuntime?: KodaXExtensionRuntime;
  /** AbortSignal for cancelling the API request */
  abortSignal?: AbortSignal;
}

// ============== 结果类型 ==============

export type KodaXTaskSurface = 'cli' | 'repl' | 'project' | 'plan';
export type KodaXTaskStatus = 'planned' | 'running' | 'blocked' | 'failed' | 'completed';
export type KodaXTaskRole = 'direct' | 'scout' | 'planner' | 'generator' | 'evaluator';

export interface KodaXTaskContract {
  taskId: string;
  surface: KodaXTaskSurface;
  objective: string;
  createdAt: string;
  updatedAt: string;
  status: KodaXTaskStatus;
  primaryTask: KodaXTaskType;
  workIntent: KodaXTaskWorkIntent;
  complexity: KodaXTaskComplexity;
  riskLevel: KodaXRiskLevel;
  harnessProfile: KodaXHarnessProfile;
  recommendedMode: KodaXExecutionMode;
  requiresBrainstorm: boolean;
  reason: string;
  contractSummary?: string;
  successCriteria: string[];
  requiredEvidence: string[];
  constraints: string[];
  contractCreatedByAssignmentId?: string;
  contractUpdatedAt?: string;
  metadata?: Record<string, KodaXJsonValue>;
  verification?: KodaXTaskVerificationContract;
}

export interface KodaXTaskRoleAssignment {
  id: string;
  role: KodaXTaskRole;
  title: string;
  dependsOn: string[];
  status: KodaXTaskStatus;
  agent?: string;
  toolPolicy?: KodaXTaskToolPolicy;
  summary?: string;
  sessionId?: string;
}

export interface KodaXTaskWorkItem {
  id: string;
  assignmentId: string;
  description: string;
  execution: 'serial' | 'parallel';
}

export interface KodaXTaskEvidenceArtifact {
  kind: 'json' | 'text' | 'markdown' | 'image';
  path: string;
  description?: string;
}

export interface KodaXInputArtifact {
  kind: 'image';
  path: string;
  mediaType?: string;
  source: 'user-inline';
  description?: string;
}

export interface KodaXTaskEvidenceEntry {
  assignmentId: string;
  role: KodaXTaskRole;
  status: KodaXTaskStatus;
  title?: string;
  round?: number;
  summary?: string;
  output?: string;
  sessionId?: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
}

export interface KodaXTaskEvidenceBundle {
  workspaceDir: string;
  runId?: string;
  artifacts: KodaXTaskEvidenceArtifact[];
  entries: KodaXTaskEvidenceEntry[];
  routingNotes: string[];
}

export interface KodaXOrchestrationVerdict {
  status: KodaXTaskStatus;
  decidedByAssignmentId: string;
  summary: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  signalDebugReason?: string;
  disposition?: 'complete' | 'blocked' | 'needs_continuation';
  continuationSuggested?: boolean;
}

export interface KodaXManagedTaskRuntimeState {
  amaProfile?: KodaXAmaProfile;
  amaTactics?: KodaXAmaTactic[];
  amaFanout?: KodaXAmaFanoutPolicy;
  amaControllerReason?: string;
  childContextBundles?: KodaXChildContextBundle[];
  childAgentResults?: KodaXChildAgentResult[];
  parentReductionContract?: KodaXParentReductionContract;
  fanoutSchedulerPlan?: KodaXFanoutSchedulerPlan;
  budget?: KodaXManagedBudgetSnapshot;
  scorecard?: KodaXVerificationScorecard;
  qualityAssuranceMode?: 'required' | 'optional';
  memoryStrategies?: Record<string, KodaXMemoryStrategy>;
  memoryNotes?: Record<string, string>;
  roleRoundSummaries?: Partial<Record<KodaXTaskRole, KodaXRoleRoundSummary>>;
  routingAttempts?: number;
  routingSource?: KodaXTaskRoutingDecision['routingSource'];
  currentHarness?: KodaXHarnessProfile;
  upgradeCeiling?: KodaXHarnessProfile;
  harnessTransitions?: KodaXManagedTaskHarnessTransition[];
  scoutDecision?: {
    summary: string;
    recommendedHarness: KodaXHarnessProfile;
    readyForUpgrade: boolean;
    scope?: string[];
    requiredEvidence?: string[];
    reviewFilesOrAreas?: string[];
    evidenceAcquisitionMode?: 'overview' | 'diff-bundle' | 'diff-slice' | 'file-read';
    harnessRationale?: string;
    blockingEvidence?: string[];
    directCompletionReady?: 'yes' | 'no';
    skillSummary?: string;
    executionObligations?: string[];
    verificationObligations?: string[];
    ambiguities?: string[];
    projectionConfidence?: KodaXSkillProjectionConfidence;
  };
  skillMap?: KodaXSkillMap;
  completionContractStatus?: Record<string, 'ready' | 'incomplete' | 'blocked' | 'missing'>;
  rawRoutingDecision?: KodaXTaskRoutingDecision;
  finalRoutingDecision?: KodaXTaskRoutingDecision;
  routingOverrideReason?: string;
  providerRuntimeBehavior?: {
    downgraded?: boolean;
    reasons: string[];
  };
  degradedVerification?: {
    fallbackWorkerId?: string;
    reason: string;
    debugReason?: string;
  };
  degradedContinue?: boolean;
  reviewFilesOrAreas?: string[];
  toolOutputTruncated?: boolean;
  toolOutputTruncationNotes?: string[];
  managedTimeline?: KodaXManagedLiveEvent[];
  evidenceAcquisitionMode?: 'overview' | 'diff-bundle' | 'diff-slice' | 'file-read';
  consecutiveEvidenceOnlyIterations?: number;
  globalWorkBudget?: number;
  budgetUsage?: number;
  budgetApprovalRequired?: boolean;
  /** FEATURE_067: Evaluator review prompt for write fan-out diffs. */
  childWriteReviewPrompt?: string;
  /** FEATURE_067: Number of write child diffs pending evaluator review. */
  childWriteDiffCount?: number;
  /** FEATURE_067 v2: Worktree paths from dispatch_child_tasks write fan-out, keyed by childId. */
  childWriteWorktreePaths?: ReadonlyMap<string, string>;
}

export interface KodaXManagedTask {
  contract: KodaXTaskContract;
  roleAssignments: KodaXTaskRoleAssignment[];
  workItems: KodaXTaskWorkItem[];
  evidence: KodaXTaskEvidenceBundle;
  verdict: KodaXOrchestrationVerdict;
  runtime?: KodaXManagedTaskRuntimeState;
}

export interface KodaXManagedVerdictPayload {
  source: 'evaluator' | 'worker';
  status: 'accept' | 'revise' | 'blocked';
  reason?: string;
  debugReason?: string;
  followups: string[];
  userFacingText: string;
  userAnswer?: string;
  artifactPath?: string;
  rawArtifactPath?: string;
  rawResponseText?: string;
  nextHarness?: KodaXTaskRoutingDecision['harnessProfile'];
  protocolParseFailed?: boolean;
  verificationDegraded?: boolean;
  continuationSuggested?: boolean;
  preferredFallbackWorkerId?: string;
}

export interface KodaXManagedScoutPayload {
  summary?: string;
  scope: string[];
  requiredEvidence: string[];
  reviewFilesOrAreas?: string[];
  evidenceAcquisitionMode?: 'overview' | 'diff-bundle' | 'diff-slice' | 'file-read';
  confirmedHarness?: KodaXTaskRoutingDecision['harnessProfile'];
  harnessRationale?: string;
  blockingEvidence?: string[];
  directCompletionReady?: 'yes' | 'no';
  userFacingText?: string;
  skillMap?: {
    skillSummary?: string;
    executionObligations: string[];
    verificationObligations: string[];
    ambiguities: string[];
    projectionConfidence?: KodaXSkillProjectionConfidence;
  };
}

export interface KodaXManagedContractPayload {
  summary?: string;
  successCriteria: string[];
  requiredEvidence: string[];
  constraints: string[];
}

export interface KodaXManagedHandoffPayload {
  status: 'ready' | 'incomplete' | 'blocked';
  summary?: string;
  evidence: string[];
  followup: string[];
  userFacingText: string;
}

export interface KodaXManagedProtocolPayload {
  verdict?: KodaXManagedVerdictPayload;
  scout?: KodaXManagedScoutPayload;
  contract?: KodaXManagedContractPayload;
  handoff?: KodaXManagedHandoffPayload;
}

export interface KodaXResult {
  success: boolean;
  lastText: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  signalDebugReason?: string;
  messages: KodaXMessage[];
  sessionId: string;
  /** Internal raw protocol output retained for artifact persistence after compacting visible failure text. */
  protocolRawText?: string;
  /** Structured managed-task protocol payload separated from visible text. */
  managedProtocolPayload?: KodaXManagedProtocolPayload;
  /** Final visible routing decision for this run, including harness and work intent. */
  routingDecision?: KodaXTaskRoutingDecision;
  /** Managed task summary produced by the task engine for this run. */
  managedTask?: KodaXManagedTask;
  /** Best-known token snapshot after the round completes. */
  contextTokenSnapshot?: KodaXContextTokenSnapshot;
  /** 是否被用户中断 (Ctrl+C) */
  interrupted?: boolean;
  /** 是否达到迭代上限 */
  limitReached?: boolean;
  /** Error metadata for recovery - 错误元数据用于恢复 */
  errorMetadata?: SessionErrorMetadata;
}

// ============== 工具执行上下文 ==============
// Simplified - no permission checks in core

/** A single question item used in multi-question mode. */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options: Array<{
    label: string;
    description?: string;
    value: string;
  }>;
  multiSelect?: boolean;
}

/** Options for multi-question mode — multiple independent questions in one tool call. */
export interface AskUserMultiOptions {
  questions: AskUserQuestionItem[];
}

export interface AskUserQuestionOptions {
  question: string;
  kind?: "select" | "input";
  /** Required for kind="select", ignored for kind="input". */
  options?: Array<{
    label: string;
    description?: string;
    value: string;
  }>;
  multiSelect?: boolean;
  default?: string;
}

export interface KodaXToolExecutionContext {
  /** File backups for undo functionality - 文件备份用于撤销功能 */
  backups: Map<string, string>;
  /** Git root directory - Git 根目录 */
  gitRoot?: string;
  /** Working directory used to resolve relative paths and execute shell commands. */
  executionCwd?: string;
  /** Shared extension capability runtime used by retrieval-family tools. */
  extensionRuntime?: KodaXExtensionRuntime;
  /** Ask user a question interactively (select mode) - 交互式向用户提问 (Issue 069) */
  askUser?: (options: AskUserQuestionOptions) => Promise<string>;
  /** Ask user multiple independent questions sequentially - 多问题顺序提问 */
  askUserMulti?: (options: AskUserMultiOptions) => Promise<Record<string, string> | undefined>;
  /** Ask user for free-text input - 自由文本输入 (Issue 112) */
  askUserInput?: (options: { question: string; default?: string }) => Promise<string | undefined>;
  /** Switch session permission mode — called by set_permission_mode tool. */
  setPermissionMode?: (mode: string) => void;
  /** Abort signal for cancelling in-flight tool operations (Issue 113) */
  abortSignal?: AbortSignal;
  managedProtocolRole?: Exclude<KodaXTaskRole, 'direct'>;
  emitManagedProtocol?: (payload: Partial<KodaXManagedProtocolPayload>) => void;
  /** FEATURE_067 v2: Parent agent's provider/model for child agent inheritance. */
  parentAgentConfig?: {
    readonly provider: string;
    readonly model?: string;
    readonly reasoningMode?: KodaXReasoningMode;
  };
  /**
   * @deprecated FEATURE_067: Removed — use reportToolProgress instead.
   * Previously fired onManagedTaskStatus with activeWorkerId='child',
   * triggering a foreground worker transition that cleared all live tool calls.
   */
  onChildProgress?: (note: string) => void;
  /** FEATURE_067 v2: Callback for long-running tools to report execution progress to the REPL transcript.
   *  The string will be displayed as the tool's "Running:" line in the transcript. */
  reportToolProgress?: (message: string) => void;
  /** FEATURE_067 v2: Callback to store write child worktree paths for Evaluator diff injection. */
  registerChildWriteWorktrees?: (worktreePaths: ReadonlyMap<string, string>) => void;
  /** Mutation tracker for scope-aware protocol responses. Populated by createWorkerEvents. */
  mutationTracker?: ManagedMutationTracker;
}
