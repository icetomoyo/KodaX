/**
 * KodaX Core Types
 *
 * 核心类型定义 - 重新导出 @kodax/agent 类型 + Coding 特定类型
 */

// ============== Import from @kodax/agent ==============
// 通用 Agent 类型从 @kodax/agent 导入

import type {
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
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXJsonValue,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXExtensionStoreEntry,
  KodaXExtensionStore,
  KodaXSessionBranchSummaryEntry,
  KodaXSessionCompactionEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionEntryBase,
  KodaXSessionLabelEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
  KodaXSessionNavigationOptions,
  KodaXSessionScope,
  KodaXSessionMeta,
  KodaXSessionStorage,
  KodaXSessionTreeNode,
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
  SessionErrorMetadata,
} from '@kodax/agent';
import type { KodaXReviewScale } from '@kodax/ai';
import type { KodaXExtensionRuntime } from './extensions/runtime.js';

// Re-export all types from @kodax/agent
export type {
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
  KodaXSessionBranchSummaryEntry,
  KodaXSessionCompactionEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionEntryBase,
  KodaXSessionLabelEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
  KodaXSessionNavigationOptions,
  KodaXSessionScope,
  KodaXSessionMeta,
  KodaXSessionStorage,
  KodaXSessionTreeNode,
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
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
  onCompactedMessages?: (messages: KodaXMessage[]) => void;
  /** Emitted to silently dismiss the compaction UI if compaction aborted or completed without changes */
  onCompactEnd?: () => void;
  /** Whether the caller has queued follow-up input waiting for the next round */
  hasPendingInputs?: () => boolean;
  onRetry?: (reason: string, attempt: number, maxAttempts: number) => void;
  onProviderRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
  onManagedTaskStatus?: (status: KodaXManagedTaskStatusEvent) => void;

  // 用户交互（可选，由 REPL 层实现）
  /** Tool execution hook - called before tool execution, return false to block - 工具执行前回调 */
  beforeToolExecute?: (
    tool: string,
    input: Record<string, unknown>,
    meta?: { toolId?: string }
  ) => Promise<boolean | string>;
  /** Ask user a question interactively - Issue 069 - 交互式向用户提问 */
  askUser?: (options: AskUserQuestionOptions) => Promise<string>;
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

export interface KodaXManagedTaskStatusEvent {
  agentMode: KodaXAgentMode;
  harnessProfile: KodaXHarnessProfile;
  activeWorkerId?: string;
  activeWorkerTitle?: string;
  currentRound?: number;
  maxRounds?: number;
  phase?: 'starting' | 'routing' | 'preflight' | 'round' | 'worker' | 'upgrade' | 'completed';
  note?: string;
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
  disableAutoTaskReroute?: boolean;
  /** Skills system prompt snippet for progressive disclosure - Skills 系统提示词片段（渐进式披露） */
  skillsPrompt?: string;
  rawUserInput?: string;
  skillInvocation?: KodaXSkillInvocationContext;
  /** Optional repository-intelligence snapshot injected into the system prompt. */
  repoIntelligenceContext?: string;
  /** Internal execution-mode overlay appended to the system prompt */
  promptOverlay?: string;
  /** Optional task-engine surface label used to track managed tasks across UX entry points. */
  taskSurface?: KodaXTaskSurface;
  /** Optional directory where managed task artifacts should be written. */
  managedTaskWorkspaceDir?: string;
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
  parallel?: boolean;
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
  kind: 'json' | 'text' | 'markdown';
  path: string;
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
  disposition?: 'complete' | 'blocked' | 'needs_continuation';
  continuationSuggested?: boolean;
}

export interface KodaXManagedTaskRuntimeState {
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
  degradedContinue?: boolean;
  reviewFilesOrAreas?: string[];
  toolOutputTruncated?: boolean;
  toolOutputTruncationNotes?: string[];
  evidenceAcquisitionMode?: 'overview' | 'diff-bundle' | 'diff-slice' | 'file-read';
  consecutiveEvidenceOnlyIterations?: number;
  globalWorkBudget?: number;
  budgetUsage?: number;
  budgetApprovalRequired?: boolean;
}

export interface KodaXManagedTask {
  contract: KodaXTaskContract;
  roleAssignments: KodaXTaskRoleAssignment[];
  workItems: KodaXTaskWorkItem[];
  evidence: KodaXTaskEvidenceBundle;
  verdict: KodaXOrchestrationVerdict;
  runtime?: KodaXManagedTaskRuntimeState;
}

export interface KodaXResult {
  success: boolean;
  lastText: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  messages: KodaXMessage[];
  sessionId: string;
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

export interface AskUserQuestionOptions {
  question: string;
  options: Array<{
    label: string;
    description?: string;
    value: string;
  }>;
  default?: string;
  intent?: "generic" | "plan-handoff";
  targetMode?: "accept-edits";
  scope?: "session";
  resumeBehavior?: "continue";
}

export interface KodaXToolExecutionContext {
  /** File backups for undo functionality - 文件备份用于撤销功能 */
  backups: Map<string, string>;
  /** Git root directory - Git 根目录 */
  gitRoot?: string;
  /** Working directory used to resolve relative paths and execute shell commands. */
  executionCwd?: string;
  /** Ask user a question interactively - 交互式向用户提问 (Issue 069) */
  askUser?: (options: AskUserQuestionOptions) => Promise<string>;
}
