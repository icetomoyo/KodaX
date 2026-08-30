/**
 * AutoModeToolGuardrail — FEATURE_092 Phase 2b.6 (v0.7.33).
 *
 * Assembles the auto-mode reviewer modules (projection +
 * classify + denial-tracker + circuit-breaker + model-resolver) into a
 * `ToolGuardrail` that the Runner calls via `beforeTool` on every
 * tool invocation.
 *
 * Decision flow (per design doc "三层权限金字塔"):
 *
 *   1. exact safe read/workspace-temp effect → allow (zero token cost)
 *   2. Explicitly exempt empty projection    → allow
 *   3. Static/high-impact pattern match      → reviewer facts in LLM
 *   4. Recoverable projection/analyzer fault → safe facts to classifier
 *   5. degraded reviewer infrastructure      → block with safer-route reason
 *   6. classify(...) sideQuery (sole Auto[LLM] decision owner)
 *        allow                                → allow (record allow → reset consecutive)
 *        confirm                              → block this attempt (record concern)
 *        failure                              → block with safer-route reason (record error)
 *        AbortError thrown                    → re-throw (propagate user cancel)
 *
 * State (mutable, session-scoped):
 *   - denialTracker (immutable type, swapped on each event)
 *   - circuitBreaker (immutable type, swapped on each event)
 *
 * Subagent sharing:
 *   The factory accepts an optional `sharedState` ref; passing the same ref
 *   to a subagent's guardrail means denial / circuit state is
 *   shared (per design doc "防绕阈值"). Without it each guardrail is
 *   independent.
 *
 * Provider capability checks and the explicit `supportsAutoModeClassifier`
 * flag are deferred to follow-up phases. Coding owns the default analyzer and
 * deterministic analyzer so direct SDK and REPL consumers share one decision path.
 */

import { createHash } from 'node:crypto';
import type { CostTracker, KodaXBaseProvider, KodaXMessage } from '@kodax-ai/llm';
import type {
  GuardrailContext,
  GuardrailVerdict,
  RunnerToolCall,
  ToolGuardrail,
} from '@kodax-ai/agent';

import {
  checkAbsoluteDeny,
  type AbsoluteDenyCheck,
  type AbsoluteDenyResult,
} from './absolute-denylist.js';
import { bashSignalCollector } from './bash-signals.js';
import {
  classify,
  type ClassifierAttemptDiagnostics,
  type ClassifyDecision,
  type ClassifyOptions,
} from './classify.js';
import {
  createCircuitBreaker,
  recordError as recordBreakerError,
  shouldFallback as breakerShouldFallback,
  type CircuitBreaker,
} from './circuit-breaker.js';
import {
  createDenialTracker,
  recordAllow as recordDenialAllow,
  recordBlock as recordDenialBlock,
  shouldFallback as denialLimitReached,
  type DenialTracker,
} from './denial-tracker.js';
import { fileSignalCollector } from './file-signals.js';
import {
  analyzeAutoModeCall,
} from './permission-analyzer.js';
import {
  resolveClassifierModel,
  type ResolveClassifierModelOptions,
} from './model-resolver.js';
import { collectAllSignals, type SignalCollector, type ToolCallSignal } from './signals.js';
import {
  buildPermissionIntentEvidence,
  type PermissionIntentEvidence,
} from './permission-intent.js';
import {
  redactClassifierProjection,
  safeFallbackToClassifierInput,
} from '../../tools/classifier-projection.js';
import { resolveToolBridgeTarget } from '../../tools/tool-bridge.js';
import type { ToolSideEffect } from '../../tools/side-effect.js';

function automaticPermissionIntentRevision(
  messages: readonly KodaXMessage[],
): readonly unknown[] {
  const revision: unknown[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || message._synthetic === true) continue;
    if (typeof message.content === 'string') {
      revision.push(message.content);
      continue;
    }
    const userContent = message.content.filter((block) => (
      block.type === 'text' || block.type === 'image'
    ));
    if (userContent.length > 0) revision.push(userContent);
  }
  return revision;
}

export interface AutoModeSharedState {
  denials: DenialTracker;
  breaker: CircuitBreaker;
}

/** @deprecated Auto review no longer opens an interactive approval prompt. */
export type AutoModeAskUserVerdict = 'allow' | 'block' | 'timeout';

/** @deprecated Auto review no longer opens an interactive approval prompt. */
export interface AutoModeDecisionDiagnostics {
  readonly source: 'classifier_confirm';
  /** Bounded (≤512 chars) decision-rationale summary. */
  readonly reason?: string;
  readonly classifierAttempts?: readonly ClassifierAttemptDiagnostics[];
}

/**
 * @deprecated Retained for source compatibility. Auto review never invokes
 * this callback; a classifier concern blocks the exact attempt and returns
 * guidance to the Agent.
 */
export type AutoModeAskUser = (
  call: RunnerToolCall,
  reason: string,
  /** Static-analysis signals retained in the deprecated callback signature. */
  signals?: readonly ToolCallSignal[],
  diagnostics?: AutoModeDecisionDiagnostics,
) => Promise<AutoModeAskUserVerdict>;

export interface AutoModeRulesContext {
  readonly projectRoot: string;
  readonly executionCwd: string;
  readonly signals: readonly ToolCallSignal[];
  /**
   * Whether shell environment aliases such as `%TEMP%` and `$env:TEMP`
   * are known to resolve from this Node process. Runtime shell profiles can
   * rewrite them before execution, so embedders must set this to false when
   * that equivalence cannot be proven.
   */
  readonly trustProcessEnvironmentPathExpansion?: boolean;
  /** Trusted host metadata used when a tool has no path-specific analyzer. */
  readonly toolSideEffect?: ToolSideEffect;
}

export type AutoModePermissionBoundary =
  | 'workspace'
  | 'system-temp'
  | 'agent-home'
  | 'agent-home-readonly'
  | 'outside-workspace'
  | 'protected'
  | 'unresolved';

export interface AutoModePermissionTarget {
  readonly path: string;
  readonly boundary: AutoModePermissionBoundary;
}

export type AutoModePermissionOperation =
  | {
    readonly kind: 'read' | 'write' | 'create' | 'delete';
    readonly target: AutoModePermissionTarget;
    readonly options?: Readonly<Record<string, boolean | number | string>>;
  }
  | {
    readonly kind: 'copy' | 'move' | 'rename';
    readonly source: AutoModePermissionTarget;
    readonly destination: AutoModePermissionTarget;
    readonly options?: Readonly<Record<string, boolean | number | string>>;
  }
  | {
    readonly kind: 'execute' | 'unknown';
    readonly summary: string;
    readonly options?: Readonly<Record<string, boolean | number | string>>;
  };

/** Compact deterministic facts supplied to the permission reviewer. */
export interface AutoModePermissionReview {
  readonly schemaVersion: 1;
  readonly analysis: {
    readonly status: 'complete' | 'incomplete';
    readonly shell: 'powershell' | 'shell' | 'tool';
    readonly binding: 'exact' | 'partial';
    readonly reason?: string;
  };
  readonly operations: readonly AutoModePermissionOperation[];
  readonly risks: readonly string[];
}

export type AutoModeCallAnalyzer = (
  call: RunnerToolCall,
  context: AutoModeRulesContext,
) => AutoModePermissionReview | undefined | Promise<AutoModePermissionReview | undefined>;

/** @deprecated Auto[RULES] execution was removed in v0.7.96. */
export type AutoModeRulesDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'block'; readonly reason: string }
  | { readonly action: 'escalate'; readonly reason: string };

/** @deprecated Type-only source compatibility; KodaX no longer executes Auto rules. */
export type AutoModeRulesEvaluator = (
  call: RunnerToolCall,
  context: AutoModeRulesContext,
) => AutoModeRulesDecision | Promise<AutoModeRulesDecision>;

export interface AutoModeGuardrailConfig {
  /** @deprecated Legacy compatibility input. Auto rules are ignored. */
  readonly rules?: ClassifyOptions['rules'];
  readonly claudeMd?: string;
  /** Optional trusted administrator policy supplied by the host. */
  readonly administratorPolicy?: string;
  /** Optional user policy from config.json#autoReview.policy. */
  readonly reviewPolicy?: string;
  /** Optional guidance supplied by the selected reviewer model/catalog. */
  readonly modelGuidance?: string;
  /**
   * Legacy classifier path only. Runtime compact review excludes AGENTS.md.
   * FEATURE_092 follow-up (auto-mode classifier AGENTS.md staleness fix):
   * live getter for the project AGENTS.md content. Takes precedence over the
   * static `claudeMd` string and is evaluated INSIDE the classify path on
   * every call — same live-getter pattern as `getDefaultProvider` /
   * `getDefaultModel` (v0.7.34 hotfix-3).
   *
   * The bug it fixes: the guardrail is a lazy-cached singleton, so a
   * captured `claudeMd` string froze the project rules at first
   * construction. Even `/reload` couldn't refresh it — the classifier kept
   * judging tool calls against a stale AGENTS.md snapshot. The REPL wires
   * this to `loadAgentsFiles` (mtime-cached), so the classifier sees the
   * same fresh project rules the system prompt does.
   */
  readonly getClaudeMd?: () => string | undefined;
  /** @deprecated Retained as inert source-compatibility input. */
  readonly askUser?: AutoModeAskUser;

  /** Mint one exact bash call for workspace-sandboxed execution. */
  readonly admitWorkspaceSandboxCall?: (
    call: RunnerToolCall,
    review: AutoModePermissionReview,
  ) => void;

  /**
   * Override for the coding-owned compact permission analyzer. An override may
   * return undefined to decline a call and leave it on the classifier path.
   */
  readonly analyzeCall?: AutoModeCallAnalyzer;

  /**
   * Look up a tool's `toClassifierInput` projection by tool name.
   * Returns `undefined` when the tool isn't in the registry. Unknown tools
   * receive a metadata-only fail-closed projection rather than a Tier-1 skip.
   */
  readonly getToolProjection: (
    toolName: string,
  ) => ((input: unknown) => string) | undefined;

  /** Optional trusted side-effect metadata for analyzer-less tools. */
  readonly getToolSideEffect?: (toolName: string) => ToolSideEffect | undefined;

  /**
   * Resolve a provider name to an instance. Returns `undefined` when
   * unconfigured / unknown — the guardrail then blocks.
   */
  readonly resolveProvider: (providerName: string) => KodaXBaseProvider | undefined;

  readonly defaultProvider: string;
  readonly defaultModel: string;

  /**
   * FEATURE_092 v0.7.34 hotfix-3 — defaultProvider/defaultModel staleness fix.
   *
   * When supplied, these are called on EVERY classify() invocation, so the
   * classifier follows the user's current main session provider/model even
   * after `/model` or `/provider` mid-session swaps. Falls back to
   * `defaultProvider` / `defaultModel` (static strings) when unset, preserving
   * backward compatibility for SDK consumers that pass string literals.
   */
  readonly getDefaultProvider?: () => string;
  readonly getDefaultModel?: () => string;

  // Override layers consumed by `resolveClassifierModel`
  readonly cliFlag?: string;
  readonly envVar?: string;
  readonly sessionOverride?: string;
  readonly userSettings?: string;

  /**
   * Optional cost-tracker accessors. The classifier writes its tokens to
   * the tracker under `querySource: 'auto_mode'` (handled inside sideQuery).
   */
  readonly getCostTracker?: () => CostTracker | undefined;
  readonly setCostTracker?: (t: CostTracker) => void;

  /** Optional logger for classifier-health and configuration warnings. */
  readonly log?: (level: 'info' | 'warn', msg: string) => void;

  /**
   * Optional shared state for subagent threshold-bypass defense
   * (design doc "防绕阈值"). When supplied, the parent and child
   * guardrails reference the SAME object — tracker
   * advances are visible across the session boundary.
   */
  readonly sharedState?: AutoModeSharedState;

  /**
   * FEATURE_092 phase 2b.7b slice C: classifier sideQuery timeout in ms.
   * Defaults to 90_000 for the first attempt and 180_000 for the retry.
   * A configured lower deadline applies to both attempts for embedder-owned
   * cancellation compatibility.
   */
  readonly timeoutMs?: number;

  // ============== FEATURE_158 (v0.7.39) ==============

  /**
   * Project root for signal collectors. File-tool collector uses this to
   * detect `outside_project` vs project-relative paths. Bash collector
   * doesn't use it (command-string-level) but threads it for uniform
   * collector contract.
   *
   * When omitted or blank, the guardrail uses `executionCwd`. If neither is
   * available, path-bearing calls remain unresolved instead of borrowing the
   * embedder process's ambient cwd as an authorization boundary.
   */
  readonly projectRoot?: string;

  /** Directory used to resolve relative tool paths. Defaults to projectRoot. */
  readonly executionCwd?: string;

  /**
   * Set to false when the shell profile or execution contract can rewrite
   * process-derived path aliases such as `%TEMP%` or `$env:TEMP`.
   */
  readonly trustProcessEnvironmentPathExpansion?: boolean;

  /**
   * Override the default signal-collector set. When unset, defaults to
   * `[bashSignalCollector, fileSignalCollector]` — coding-side
   * command-string + file-tool collectors that don't depend on REPL
   * path utilities.
   *
   * Use `extraCollectors` instead if you want to **add** collectors
   * without replacing the defaults.
   */
  readonly signalCollectors?: readonly SignalCollector[];

  /**
   * Additional signal collectors to merge with `signalCollectors`.
   * Primary use: REPL injects its path-aware bash signal collector. The
   * underlying shell and path permission utilities are coding-owned.
   *
   * Order: defaults run first, then extras (preserves per-collector
   * signal order).
   */
  readonly extraCollectors?: readonly SignalCollector[];

  /**
   * Layer-owned high-impact pattern checks. They add classifier evidence.
   */
  readonly extraAbsoluteDenyChecks?: readonly AbsoluteDenyCheck[];

  /** @deprecated Retained as inert source-compatibility input. */
  readonly speculativeWindowMs?: number;
}

/**
 * Snapshot of the auto-mode guardrail's session-scoped state. Returned by
 * `getStats()` for diagnostic surfaces (`/auto-denials`). The DenialTracker /
 * CircuitBreaker types are immutable
 * value objects, so this is a copy of the references — caller cannot mutate
 * guardrail state through it.
 */
export interface AutoModeStats {
  readonly classifierHealth: 'healthy' | 'degraded';
  readonly classifierModel?: string;
  readonly denials: DenialTracker;
  readonly breaker: CircuitBreaker;
}

export interface AutoModeToolGuardrail extends ToolGuardrail {
  /** Review an exact operation that has crossed the sandbox/host boundary. */
  reviewHostBoundary(
    call: RunnerToolCall,
    ctx: GuardrailContext,
  ): Promise<GuardrailVerdict>;
  /** Start a new user turn: clear denial thresholds, retain infrastructure health. */
  resetTurn(): void;
  /** Snapshot of denial tracker + circuit breaker. */
  getStats(): AutoModeStats;
  /** Test-only alias for getStats(). Backward-compat for test files. */
  getStatsForTest(): AutoModeStats;
  /** Test-only override: swap the provider mid-test. */
  setProviderForTest(provider: KodaXBaseProvider): void;
}

const DETERMINISTIC_READ_TOOLS = new Set(['read', 'grep', 'glob']);
const DETERMINISTIC_OPERATION_RISKS = new Set([
  'source_removed',
  'destination_overwrite_possible',
  'cross_boundary_copy',
  'cross_boundary_mutation',
]);
const AUTO_REVIEW_UNAVAILABLE_PREFIX =
  '[auto_review_unavailable] The requested operation was not executed because Auto review '
  + 'could not produce a trustworthy decision after its bounded retry. ';
const AUTO_REVIEW_DENIAL_LIMIT_REASON =
  '[auto_review_denial_limit] Auto review rejected too many operations in this turn. '
  + 'Stop this turn and wait for a new user instruction or choose a materially safer route.';
const AUTO_REVIEW_DENIED_PREFIX =
  '[auto_review_denied] Auto review did not authorize this attempt. '
  + 'Use a safer route or wait for a later informed natural-language user instruction. Review reason: ';
const AUTO_MODE_FAILURE_LOG_MAX_LENGTH = 768;
const AUTO_MODE_FAILURE_LOG_SCAN_MAX_LENGTH = 4_096;

function errorCategory(error: unknown): string {
  if (error instanceof EvalError) return 'EvalError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof ReferenceError) return 'ReferenceError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof URIError) return 'URIError';
  if (error instanceof DOMException) return 'DOMException';
  if (error instanceof Error) return 'Error';
  return 'non-Error';
}

function redactAndBoundFailureText(value: string, maxLength: number): string {
  const normalized = redactClassifierProjection(
    value.slice(0, AUTO_MODE_FAILURE_LOG_SCAN_MAX_LENGTH),
  ).replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

function logAutoModeWarning(
  log: AutoModeGuardrailConfig['log'],
  message: string,
): void {
  if (!log) return;
  try {
    log('warn', redactAndBoundFailureText(message, AUTO_MODE_FAILURE_LOG_MAX_LENGTH));
  } catch {
    // Host logging is observational. A logger failure must not change an
    // allow/ask/fallback decision, and there is no safe logger to report it to.
  }
}

type MutationOperationKind = 'copy' | 'create' | 'delete' | 'move' | 'rename' | 'write';

const MUTATION_DENIAL_TERMS: Readonly<Record<
  MutationOperationKind,
  RegExp
>> = {
  copy: /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\b[\s\S]{0,48}\b(?:copy|cp|duplicate)\b|\bwithout\s+(?:copying|duplicating)\b|(?:不要|别|禁止|不得).{0,24}(?:copy|cp|duplicate|复制|拷贝)/i,
  create: /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\b[\s\S]{0,48}\b(?:create|generate|mkdir|make)\b|\bwithout\s+(?:creating|generating|making)\b|(?:不要|别|禁止|不得).{0,24}(?:create|generate|mkdir|make|创建|新建|生成)/i,
  delete: /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\b[\s\S]{0,48}\b(?:delete|del|erase|remove|rm|rmdir)\b|\bwithout\s+(?:deleting|removing|erasing)\b|(?:不要|别|禁止|不得).{0,24}(?:delete|del|erase|remove|rm|rmdir|删除|移除|清理)/i,
  move: /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\b[\s\S]{0,48}\b(?:move|mv|relocate|organize)\b|\bwithout\s+(?:moving|relocating|organizing)\b|(?:不要|别|禁止|不得).{0,24}(?:move|mv|relocate|organize|移动|移到|搬到|整理)/i,
  rename: /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\b[\s\S]{0,48}\b(?:rename|ren)\b|\bwithout\s+renaming\b|(?:不要|别|禁止|不得).{0,24}(?:rename|ren|重命名|改名)/i,
  write: /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\b[\s\S]{0,48}\b(?:write|edit|update|modify|save|fix|implement|change)\b|\bwithout\s+(?:writing|editing|updating|modifying|saving|fixing|implementing|changing)\b|(?:不要|别|禁止|不得).{0,24}(?:write|edit|update|modify|save|fix|implement|change|写入|编辑|修改|更新|保存|修复|实施|改动)/i,
};

const NON_EXECUTING_DENIAL_INTENT = /\b(?:do\s+not|don't|dont|never)\s+(?:execute|run|proceed|perform|apply|implement|fix|change|make\s+(?:the\s+)?change|do\s+(?:it|that|this))\b|\bnot\s+actually\s+(?:execute|run|proceed|perform|apply|implement|fix|change|do\s+(?:it|that|this))\b|(?:不要|别|禁止|不得)(?:实际|真的)?(?:执行|操作|运行|实施|应用|修复|改动|动|做)(?![./\\])|不(?:执行|操作)(?![./\\])/i;
const NON_EXECUTING_REQUEST_INTENT = /(?:^|[\n,.;!?，。；！？])\s*(?:(?:please|kindly|just)\s+|(?:(?:can|could|would)\s+you\s+)|请(?:你)?\s*|(?:只|仅|仅仅)\s*)*(?:explain(?![./\\])\b|describe(?![./\\])\b|discuss(?![./\\])\b|how\s+to\b|show\s+me\s+how\b|should\s+(?:i|we)\b|(?:would|could|is|are)\s+(?:moving|copying|deleting|removing|writing|editing|creating|renaming)\b|whether\b|what\s+if\b|hypothetically\b|解释(?!器)|说明(?!书)|讨论|如何|怎么|是否|要不要|该不该|假设|仅供参考|只是\s*说明(?!书))/i;
const REVIEW_REQUEST_INTENT = /\b(?:review|audit|inspect|analy[sz]e|check)\b|审查|审核|复核|检查|分析|审阅/i;
const REVIEW_QUESTION_INTENT = /(?:\b(?:review|audit|inspect|analy[sz]e|check)\b[\s\S]{0,96}\b(?:whether|if)\b|(?:审查|审核|复核|检查|分析|审阅)[\s\S]{0,48}(?:是否|要不要|该不该|应不应该))/i;
const READ_OR_EXECUTION_RESTRICTION = /\b(?:only\s+read|do\s+not\s+read|don't\s+read|never\s+read|must\s+not\s+read|do\s+not\s+(?:execute|run)|don't\s+(?:execute|run)|never\s+(?:execute|run)|no\s+(?:shell|command\s+execution)|outside\s+(?:the\s+)?(?:workspace|project))\b|(?:只(?:能|可)?读取|仅(?:能|可)?读取|不要读取|禁止读取|不得读取|不要执行|禁止执行|不得执行|不要运行|禁止运行|不得运行|工作区外|项目外)/i;
const MUTATION_ONLY_RESTRICTION = /\b(?:do\s+not|don't|never|must\s+not|should\s+not|may\s+not|cannot|can't|without)\b[\s\S]{0,96}\b(?:chang(?:e|ing)|fix(?:ing)?|implement(?:ing)?|modif(?:y|ying)|sav(?:e|ing)|updat(?:e|ing)|writ(?:e|ing)|edit(?:ing)?|delet(?:e|ing)|remov(?:e|ing)|creat(?:e|ing)|mov(?:e|ing)|copy(?:ing)?|renam(?:e|ing)|publish(?:ing)?|mutation-capable)\b|\bread-only\b|(?:只读|不要|请勿|勿|严禁|禁止|不得|不准|不能)[^\n]{0,48}(?:修改|写入|编辑|删除|移除|创建|移动|复制|重命名|发布)/i;
const GENERAL_MUTATION_INTENT = /\b(?:implement|apply)\b|实施|应用/i;
const NO_MUTATION_SCOPE_RESTRICTION = /\bread[- ]only\b|\bno\s+(?:changes?|edits?|modifications?|writes?)\b|\bmake\s+no\s+(?:changes?|edits?|modifications?)\b|\b(?:do\s+not|don't|never|avoid|without)\b[\s\S]{0,32}\b(?:alter(?:ing)?|touch(?:ing)?|edit(?:ing)?|modif(?:y|ying)|chang(?:e|ing)|writ(?:e|ing))\b[\s\S]{0,32}\b(?:files?|code|repository|repo|worktree)\b|\b(?:keep|leave|preserve)\b[\s\S]{0,40}\b(?:files?|code|repository|repo|worktree)?\s*(?:pristine|intact|unchanged|untouched|unmodified|as[- ]is)\b|\bdo\s+not\s+touch\b[\s\S]{0,24}\bfiles?\b|\bobservation\s+only\b|\bwithout\s+alter(?:ing|ation)\b[\s\S]{0,24}\bfiles?\b|\u53ea\u8bfb|\u4ec5\u89c2\u5bdf|\u4fdd\u6301.{0,16}\u4e0d\u53d8|\u4e0d\u8981.{0,12}(?:\u505a)?\u4efb\u4f55\u4fee\u6539|\u4e0d\u8981\u52a8.{0,8}\u6587\u4ef6/i;
// These are high-recall routing predicates, not semantic permission rules.
// A match means the current request may constrain this operation, so the LLM
// must interpret it. No regex match is itself treated as a deny verdict.
const READ_CONSTRAINT_CANDIDATES: readonly RegExp[] = [
  /\b(?:do\s+not|don't|dont|no|never|must\s+not|should\s+not|may\s+not|shall\s+not|cannot|can't|avoid|without|refrain\s+from|forbid(?:den)?(?:\s+from)?|prohibit(?:ed)?(?:\s+from)?|disallow(?:ed)?(?:\s+from)?|barr?ed\s+from)\b[\s\S]{0,48}\b(?:read(?:ing)?|open(?:ing)?|view(?:ing)?|look(?:ing)?|peek(?:ing)?|review(?:ing)?|inspect(?:ing)?|access(?:ing)?|examin(?:e|ing)|load(?:ing)?|file\s+contents?)\b/i,
  /\b(?:read(?:ing)?|open(?:ing)?|view(?:ing)?|inspect(?:ing)?|access(?:ing)?|examin(?:e|ing)|file\s+contents?)\b[\s\S]{0,32}\b(?:forbidden|prohibited|disallowed|banned|barred|not\s+allowed|off[- ]limits?|must\s+not\s+be|should\s+not\s+be|may\s+not\s+be)\b/i,
  /\b(?:(?:must|should|may)\s+not\s+be|is\s+not\s+to\s+be)\s+(?:read|opened|viewed|looked\s+at|inspected|accessed|examined)\b/i,
  /(?:\u4e0d\u8981|\u8bf7\u52ff|\u52ff|\u522b|\u4e25\u7981|\u7981\u6b62|\u4e0d\u5f97|\u4e0d\u53ef|\u4e0d\u51c6|\u4e0d\u80fd|\u907f\u514d|\u65e0\u9700).{0,24}(?:\u8bfb\u53d6|\u9605\u8bfb|\u67e5\u770b|\u6253\u5f00|\u8bbf\u95ee|\u68c0\u67e5)/i,
  /\bonly\s+(?:read|open|view|look|peek|review|inspect|access|examine)\b|(?:\u4ec5|\u53ea).{0,12}(?:\u8bfb\u53d6|\u9605\u8bfb|\u67e5\u770b|\u6253\u5f00|\u8bbf\u95ee)/i,
  /\b(?:limit|restrict|confine)\b[\s\S]{0,40}\b(?:read(?:ing)?|review|look|inspection|examination|view|access|files?|folders?|directories?|paths?)\b|\b(?:read(?:ing)?|review(?:ing)?|look(?:ing)?|peek(?:ing)?|open(?:ing)?|view(?:ing)?|examin(?:e|ing)|inspect(?:ion|ing)?|access(?:ing)?)\b(?!-only\b)[\s\S]{0,40}\b(?:only\b(?![./\\]|\s+to\b)|exclusive(?:ly)?\b(?![./\\])|(?:limited|restricted|confined)\s+to\b)/i,
  /\b(?:stay|keep)\b[\s\S]{0,32}\b(?:within|inside|to)\b[\s\S]{0,40}(?:[/\\]|\b(?:files?|folders?|directories?|paths?)\b)/i,
  /\b(?:read|review|inspect|view|open|access|examine)\b[\s\S]{0,64}\bnothing\s+else\b/i,
  /(?:\u8303\u56f4\s*(?:\u4ec5\u9650|\u53ea\u9650)|(?:\u4ec5|\u53ea)\s*(?:\u770b|\u67e5\u770b|\u5ba1\u67e5|\u9605\u8bfb)|\u4e0d\u8981\u8d85\u51fa|\u4fdd\u6301\u5728).{0,48}(?:[/\\]|\u6587\u4ef6|\u76ee\u5f55|\u8def\u5f84|\u8303\u56f4|\u5185)/i,
  /\S+.{0,16}\u4e0d\u5728.{0,16}(?:\u5ba1\u67e5|\u8bfb\u53d6|\u67e5\u770b)?\s*\u8303\u56f4(?:\u5185)?/i,
];
const EXECUTION_CONSTRAINT_CANDIDATES: readonly RegExp[] = [
  /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not|may\s+not|shall\s+not|cannot|can't|avoid|without|refrain\s+from|prohibit(?:ed)?(?:\s+from)?|disallow(?:ed)?(?:\s+from)?|barr?ed\s+from|no|not)\b[\s\S]{0,48}\b(?:execute|executing|run|running|invoke|invoking|use|using)?\s*(?:the\s+)?(?:shell|terminal|command(?:s|\s+execution)?|command[- ]line|cli\s+calls?|bash|powershell|cmd(?:\.exe)?|external\s+tools?)\b/i,
  /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not|cannot|can't|avoid|without|refrain\s+from)\b[\s\S]{0,32}\b(?:execute|executing|run|running|invoke|invoking)\b/i,
  /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not|may\s+not|cannot|can't|avoid|without|refrain\s+from|no)\b[\s\S]{0,32}\b(?:spawn|launch|start|fork)\b[\s\S]{0,20}\b(?:subprocess(?:es)?|process(?:es)?|child\s+process(?:es)?)\b/i,
  /\b(?:shell|terminal|command(?:s|\s+execution)?|command[- ]line|bash|powershell|cmd(?:\.exe)?)\b[\s\S]{0,32}\b(?:forbidden|prohibited|disallowed|banned|barred|not\s+allowed|off[- ]limits?|must\s+not\s+be\s+used|should\s+not\s+be\s+used|may\s+not\s+be\s+used)\b/i,
  /\b(?:only\s+use|use\s+only|exclusively\s+use)\b[\s\S]{0,32}\b(?:file\s+tools?|file\s+apis?|tool\s+apis?)\b/i,
  /\bthrough\b[\s\S]{0,32}\b(?:file\s+tools?|file\s+apis?|tool\s+apis?)\b[\s\S]{0,16}\bonly\b/i,
  /\b(?:file\s+tools?|file\s+apis?|tool\s+apis?)\b[\s\S]{0,32}\b(?:instead\s+of|rather\s+than|only|exclusively)\b[\s\S]{0,32}\b(?:the\s+)?(?:shell|terminal|commands?|bash|powershell|cmd(?:\.exe)?)?\b/i,
  /\b(?:prefer|stick\s+to)\b[\s\S]{0,24}\b(?:file\s+tools?|file\s+apis?|tool\s+apis?)\b/i,
  /\b(?:limit|restrict|confine)\b[\s\S]{0,48}\b(?:direct\s+)?file\s+(?:operations?|tools?|apis?)\b|\bstay\s+(?:away\s+from|out\s+of)\b[\s\S]{0,24}\b(?:shell|terminal|cli|command\s+line)\b/i,
  /\b(?:shell|terminal)[- ]free\b/i,
  /\b(?:do\s+not|don't|dont|no|never|avoid|without)\b[\s\S]{0,32}\b(?:subprocess(?:es)?|external\s+process(?:es)?|process\s+invocation)\b/i,
  /\bneither\b[\s\S]{0,24}\b(?:shell|terminal|command(?:s|\s+line)?)\b[\s\S]{0,24}\bnor\b[\s\S]{0,24}\b(?:shell|terminal|command(?:s|\s+line)?)\b/i,
  /\b(?:stay\s+clear\s+of|keep\s+out\s+of)\b[\s\S]{0,24}\b(?:shell|terminal|command\s+line)\b/i,
  /\b(?:shell|terminal|command(?:s|\s+execution)?|subprocess(?:es)?|external\s+process(?:es)?)\b[\s\S]{0,24}\b(?:use\s+is\s+)?not\s+permitted\b/i,
  /\b(?:stay|keep|confine|limit|restrict)\b[\s\S]{0,32}\b(?:within|inside|to)\b[\s\S]{0,24}\b(?:file\s+tools?|file\s+apis?|tool\s+apis?)\b/i,
  /\b(?:use|through)\b[\s\S]{0,24}\b(?:file\s+tools?|file\s+apis?|tool\s+apis?)\b[\s\S]{0,24}\bnothing\s+else\b/i,
  /\b(?:do|perform|handle)\s+(?:everything|all\s+(?:operations?|actions?))\b[\s\S]{0,24}\b(?:through|via|with)\b[\s\S]{0,20}\b(?:file\s+tools?|file\s+apis?|tool\s+apis?)\b/i,
  /\b(?:shell|terminal|command(?:s|\s+execution)?|command[- ]line|bash|powershell|cmd(?:\.exe)?)\b[\s\S]{0,24}\bout\s+of\s+scope\b/i,
  /(?:\u4e0d\u8981|\u8bf7\u52ff|\u52ff|\u522b|\u4e25\u7981|\u7981\u6b62|\u4e0d\u5f97|\u4e0d\u53ef|\u4e0d\u51c6|\u4e0d\u80fd|\u907f\u514d).{0,24}(?:shell|bash|powershell|cmd|\u7ec8\u7aef|\u547d\u4ee4|\u811a\u672c|\u6267\u884c|\u8fd0\u884c|\u8c03\u7528)/i,
  /(?:\u4ec5|\u53ea).{0,12}(?:\u4f7f\u7528|\u7528).{0,12}(?:\u6587\u4ef6\u5de5\u5177|\u5de5\u5177\s*API)/i,
  /(?:\u4ec5\u9650|\u53ea\u7528|\u4ec5\u7528|\u4fdd\u6301\u4f7f\u7528|\u4e0d\u8981\u8d85\u51fa).{0,20}(?:\u6587\u4ef6\s*(?:API|\u5de5\u5177)|file\s*(?:API|tools?))/i,
  /(?:\u7ec8\u7aef|\u547d\u4ee4\u884c|shell).{0,20}\u4e0d\u5728.{0,20}(?:\u4efb\u52a1|\u5ba1\u67e5|\u672c\u6b21)?\s*\u8303\u56f4(?:\u5185)?/i,
  /\b(?:no|refrain\s+from|avoid)\s+shelling\s+out\b/i,
  /\b(?:without|avoid|no)\b[\s\S]{0,24}\bexternal\s+programs?\b/i,
  /\b(?:limit|restrict|confine)\b[\s\S]{0,32}\b(?:read(?:ing)?\s+and\s+grep|read\s+and\s+grep)\b/i,
];
const GENERAL_OPERATION_CONSTRAINT = /\b(?:(?:do\s+not|don't|never)\s+proceed|stop|pause|hold|wait(?:\s+for)?[\s\S]{0,24}\b(?:confirmation|approval))\b|(?:\u4e0d\u8981\u7ee7\u7eed|\u522b\u7ee7\u7eed|\u505c\u6b62|\u6682\u505c|\u5148\u522b|\u7b49\u5f85.{0,12}(?:\u786e\u8ba4|\u6279\u51c6))/i;
const AFFIRMATIVE_PRONOUN_READ = /^\s*(?:only\s+)?(?:read|review|inspect|view)\s+(?:it|this|the\s+file)\s*$/i;
const EXECUTION_CHANNEL_REFERENCE = /\b(?:shell|terminal|console|cli|commands?|exec(?:ution)?|command[- ]line|command\s+prompt|command\s+interpreters?|process\s+execution|powershell|cmd(?:\.exe)?|bash)\b|\u7ec8\u7aef|\u547d\u4ee4|\u547d\u4ee4\u884c|\u63a7\u5236\u53f0|\u547d\u4ee4\u89e3\u91ca\u5668|\u8fdb\u7a0b\u6267\u884c|\u5916\u90e8\u8fdb\u7a0b|\u5b50\u8fdb\u7a0b/i;
const AFFIRMATIVE_CHANNEL_EXECUTION = /\b(?:use|run|execute|invoke|open)\s+(?:the\s+)?(?:shell|terminal|console|cli|command[- ]line|command\s+prompt|command\s+interpreter|powershell|cmd(?:\.exe)?|bash)(?!\.[A-Za-z0-9])(?:\s+commands?)?(?=\s*(?:$|[.,;!?]|\b(?:to|for)\s+(?:inspect|read|review|check|show|list|find|search|run|execute|build|test|verify|install|invoke|call|query|collect|diagnose)\b))|(?:\u4f7f\u7528|\u7528|\u8fd0\u884c|\u6267\u884c|\u8c03\u7528)\s*(?:\u7ec8\u7aef|\u547d\u4ee4\u884c|\u63a7\u5236\u53f0|\u547d\u4ee4\u89e3\u91ca\u5668|shell|powershell|cmd|bash)(?!\.[A-Za-z0-9])(?=\s*(?:$|[\u3002\uff0c\uff1b\uff01\uff1f]|(?:\u6765|\u4ee5\u4fbf)?\s*(?:\u68c0\u67e5|\u8bfb\u53d6|\u5ba1\u67e5|\u67e5\u770b|\u5217\u51fa|\u641c\u7d22|\u8fd0\u884c|\u6267\u884c|\u6784\u5efa|\u6d4b\u8bd5|\u9a8c\u8bc1)\b))/gi;
const EXECUTION_CHANNEL_DENIAL = /\b(?:do\s+not|don't|dont|never|avoid|without|no)\b[\s\S]{0,32}\b(?:use|using|invoke|invoking|run|running|execute|executing)?\s*(?:the\s+)?(?:shell|terminal|console|cli|commands?|exec(?:ution)?|command[- ]line|command\s+prompt|command\s+interpreters?|process\s+execution|external\s+process(?:es)?|subprocess(?:es)?|powershell|cmd(?:\.exe)?|bash)\b|\b(?:keep|stay)\b[\s\S]{0,20}\b(?:out\s+of|away\s+from)\b[\s\S]{0,16}\b(?:shell|terminal|console|cli|command[- ]line|command\s+prompt)\b|\b(?:shell|terminal|console|cli|commands?|exec(?:ution)?|command[- ]line|command\s+prompt|command\s+interpreters?|process\s+execution|external\s+process(?:es)?|subprocess(?:es)?)\b[\s\S]{0,20}\b(?:calls?\s+(?:are|is)\s+)?(?:disabled|forbidden|prohibited|disallowed|off[- ]limits?|not\s+allowed)\b|(?:\u4e0d\u8981|\u8bf7\u52ff|\u52ff|\u522b|\u7981\u6b62|\u907f\u514d).{0,20}(?:\u4f7f\u7528|\u7528|\u542f\u52a8|\u8fd0\u884c|\u6267\u884c|\u8c03\u7528)?\s*(?:\u7ec8\u7aef|\u547d\u4ee4|\u547d\u4ee4\u884c|\u63a7\u5236\u53f0|\u547d\u4ee4\u89e3\u91ca\u5668|\u8fdb\u7a0b\u6267\u884c|\u5916\u90e8\u8fdb\u7a0b|\u5b50\u8fdb\u7a0b|shell|powershell|cmd|bash)/i;
const EXECUTION_SCOPE_QUALIFIER = /\b(?:only\s+(?:run|execute|invoke|call|use|spawn|launch|start)|(?:run|execute|invoke|call|use|spawn|launch|start)\s+only)\b|\b(?:run|execute|invoke|call|use|spawn|launch|start)\b[\s\S]{0,48}\bnothing\s+else\b|\b(?:do\s+not|don't|dont|never|avoid|without|refrain\s+from|no)\b[\s\S]{0,32}\b(?:run|execute|invoke|call|use|using|spawn|launch|start)\b|(?:\u4ec5|\u53ea).{0,16}(?:\u8fd0\u884c|\u6267\u884c|\u8c03\u7528|\u4f7f\u7528|\u7528|\u542f\u52a8)|(?:\u4e0d\u8981|\u8bf7\u52ff|\u52ff|\u522b|\u7981\u6b62|\u907f\u514d).{0,24}(?:\u8fd0\u884c|\u6267\u884c|\u8c03\u7528|\u4f7f\u7528|\u7528|\u542f\u52a8)/i;
const EXECUTION_ALTERNATIVE_SCOPE = /\b(?:only|exclusively|solely)\s+(?:(?:read|review|inspect|examine)\s+)?(?:files?|file\s+(?:operations?|tools?|apis?)|read(?:ing)?(?:\s+and\s+grep)?\s+tools?|grep\s+tools?)\b|\b(?:files?|file\s+(?:operations?|tools?|apis?)|read(?:ing)?(?:\s+and\s+grep)?\s+tools?|grep\s+tools?)\s+(?:only(?!\s+to\b)|exclusively|and\s+nothing\s+else)\b|(?:\u4ec5\u9650\u6587\u4ef6\u64cd\u4f5c|\u53ea\u5ba1\u67e5\u6587\u4ef6)/i;
const IMPLICIT_EXCLUSIVE_READ_SCOPE = /(?<![-\w])(?:only|exclusive(?:ly)?|solely|just|nothing\s+else)\b|(?:\u4ec5|\u53ea|\u4ec5\u9650|\u53ea\u9650)/i;
const READ_SCOPE_PATH_SOURCE = String.raw`["'\x60]?[\p{L}\p{N}_.-]+(?:[\\/][\p{L}\p{N}_.-]+)*[\\/]?["'\x60]?`;
const EXCLUSIVE_READ_SCOPE_REFERENCES = [
  new RegExp(
    String.raw`(?<![-\p{L}\p{N}_])(?:only|just|exclusively|solely)\s+(?:(?:read|review|inspect|examine|open|view|check|audit|analy[sz]e)\s+(?:the\s+)?|(?:the\s+)?)?(?!to\b|for\b)(${READ_SCOPE_PATH_SOURCE})(?:\s+(?:directory|folder|file))?`,
    'giu',
  ),
  new RegExp(
    String.raw`\b(?:(?:(?:the\s+)?(?:review|reading|inspection)\s+)?scope\s*(?::|=|\bis\b|\bto\b)|(?:limit|restrict|confine)(?:\s+(?:yourself|ourselves|this|the)(?:\s+(?:review|reading|inspection))?)?\s*(?::|to|within)|(?:limit|restrict|confine)\s+(?:the\s+)?scope\s+to|(?:review|reading|inspection)\s+is\s+(?:limited|restricted|confined)\s+to)\s*(?:the\s+)?(${READ_SCOPE_PATH_SOURCE})(?:\s+(?:directory|folder|file))?`,
    'giu',
  ),
  new RegExp(
    String.raw`(${READ_SCOPE_PATH_SOURCE})\s+(?:only(?![./\\])|exclusively|solely|and\s+nothing\s+else)\b`,
    'giu',
  ),
  new RegExp(
    String.raw`(${READ_SCOPE_PATH_SOURCE})\s+is\s+(?:the\s+)?(?:only\s+)?(?:scope|limit)\b`,
    'giu',
  ),
  new RegExp(
    String.raw`\b(?:(?:nothing|everything)\s+(?:beyond|outside)|(?:do\s+not|never)\s+(?:leave|go\s+(?:outside|beyond)|read\s+beyond)|exclude\s+everything\s+(?:outside|beyond))\s+(?:of\s+)?(${READ_SCOPE_PATH_SOURCE})`,
    'giu',
  ),
  new RegExp(
    String.raw`(?:(?:\u5ba1\u67e5|\u8bfb\u53d6)?\u8303\u56f4\s*(?:\u662f|\u4e3a|:|\uff1a|=)|(?:\u628a)?(?:\u5ba1\u67e5|\u8bfb\u53d6)?\u8303\u56f4\s*(?:\u9650\u5236|\u9650\u5b9a)\u5728)\s*(${READ_SCOPE_PATH_SOURCE})`,
    'giu',
  ),
  new RegExp(
    String.raw`(${READ_SCOPE_PATH_SOURCE})\s*\u4e4b\u5916.{0,8}(?:\u4e0d\u8981|\u8bf7\u52ff|\u52ff|\u522b).{0,8}(?:\u8bfb|\u770b|\u67e5\u770b|\u5ba1\u67e5|\u8bbf\u95ee)`,
    'giu',
  ),
  new RegExp(
    String.raw`(?:\u5ba1\u67e5|\u8bfb\u53d6)?\s*(?:\u4ec5\u9650\u4e8e|\u9650\u4e8e)\s*(${READ_SCOPE_PATH_SOURCE})`,
    'giu',
  ),
  new RegExp(
    String.raw`(?:\u53ea|\u4ec5)\u5728\s*(${READ_SCOPE_PATH_SOURCE})\s*(?:\u4e2d|\u5185).{0,8}(?:\u5ba1\u67e5|\u8bfb\u53d6|\u67e5\u770b|\u9605\u8bfb)`,
    'giu',
  ),
  new RegExp(
    String.raw`(?:(?:\u5ba1\u67e5|\u8bfb\u53d6).{0,6})?(?:\u4e0d\u8981|\u8bf7\u52ff|\u52ff|\u522b)(?:\u8d85\u8fc7|\u8d85\u51fa)\s*(${READ_SCOPE_PATH_SOURCE})`,
    'giu',
  ),
  new RegExp(
    String.raw`(${READ_SCOPE_PATH_SOURCE})\s*(?:\u4e4b\u5916|\u4ee5\u5916).{0,8}(?:\u4e00\u5f8b\u4e0d|\u4e0d\u8981|\u8bf7\u52ff|\u52ff|\u522b).{0,8}(?:\u8bfb|\u770b|\u67e5\u770b|\u5ba1\u67e5|\u8bbf\u95ee)`,
    'giu',
  ),
  new RegExp(
    String.raw`(?:\u628a)?\u81ea\u5df1\s*(?:\u9650\u5236|\u9650\u5b9a)\u5728\s*(${READ_SCOPE_PATH_SOURCE})`,
    'giu',
  ),
] as const;

function matchesConstraintCandidate(intent: string, candidates: readonly RegExp[]): boolean {
  return candidates.some((candidate) => candidate.test(intent));
}
const DIRECT_TARGET_EXCLUSION = /\b(?:skip|ignore|avoid|omit)(?:\s+\S+){0,3}\s+target\b|\bleave\s+target\s+alone\b|\bstay\s+(?:away\s+from|out\s+of)\s+target\b|\b(?:except(?:\s+for)?|exclud(?:e|ing)|other\s+than|everything\s+but|all\s+but|apart\s+from|with\s+the\s+exception\s+of|save\s+for)\s+target\b|\btarget\b[\s\S]{0,24}\b(?:excluded|forbidden|prohibited|disallowed|banned|barred|off[- ]limits?|out\s+of\s+scope)\b|(?:\u907f\u514d|\u6392\u9664|\u8df3\u8fc7|\u5ffd\u7565|\u8fdc\u79bb|\u4e0d\u8981\u78b0).{0,12}\btarget\b|\btarget\b.{0,16}(?:\u88ab\u6392\u9664|\u7981\u6b62\u8bbf\u95ee|\u4e0d\u8981\u78b0|\u4e0d\u5728.{0,8}\u8303\u56f4(?:\u5185)?)/i;
const AFFIRMATIVE_TARGET_READ = /\b(?:read|review|inspect|examine|open|view|check|audit|analy[sz]e)\s+(?:only\s+)?(?:(?:the|its)\s+)?(?:contents?\s+of\s+)?target\b|\btarget\b\s+(?:(?:is|should\s+be|must\s+be|to\s+be)\s+)?(?:read|reviewed|inspected|examined|opened|viewed|checked|audited|analy[sz]ed)\b|(?:\u8bfb\u53d6|\u9605\u8bfb|\u67e5\u770b|\u5ba1\u67e5|\u68c0\u67e5|\u5206\u6790|\u6253\u5f00)(?:\u8be5|\u8fd9\u4e2a)?\s*\btarget\b|\btarget\b\s*(?:\u9700\u8981|\u8bf7|\u8fdb\u884c)?\s*(?:\u8bfb\u53d6|\u9605\u8bfb|\u67e5\u770b|\u5ba1\u67e5|\u68c0\u67e5|\u5206\u6790)/i;
const CONCRETE_FILE_REFERENCE = /(?:^|[\s"'`])([\p{L}\p{N}_][\p{L}\p{N}_.-]*\.[\p{L}\p{N}]{1,12})(?=$|[\s"'`,.;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f])/gu;
const ACTION_SCOPED_REFERENCE = /(?:\b(?:copy|cp|duplicate|create|generate|mkdir|make|delete|del|erase|remove|rm|rmdir|move|mv|relocate|organize|rename|ren|write|edit|update|modify|save)\b|(?:\u590d\u5236|\u62f7\u8d1d|\u521b\u5efa|\u65b0\u5efa|\u751f\u6210|\u5220\u9664|\u79fb\u9664|\u6e05\u7406|\u79fb\u52a8|\u79fb\u5230|\u642c\u5230|\u6574\u7406|\u91cd\u547d\u540d|\u6539\u540d|\u5199\u5165|\u7f16\u8f91|\u4fee\u6539|\u66f4\u65b0|\u4fdd\u5b58|\u4fee\u590d))\s*(?:the\s+)?["'`]?(?:\u8be5|\u8fd9\u4e2a)?\s*([\p{L}\p{N}_][\p{L}\p{N}_.\\/-]*)/giu;
const MUTATION_INTENT_TERMS: Readonly<Record<MutationOperationKind, RegExp>> = {
  copy: /\b(?:copy|cp|duplicate)\b|复制|拷贝/i,
  create: /\b(?:create|generate|mkdir|make)\b|创建|新建|生成/i,
  delete: /\b(?:delete|del|erase|remove|rm|rmdir)\b|删除|移除|清理/i,
  move: /\b(?:move|mv|relocate|organize)\b|移动|移到|搬到|整理/i,
  rename: /\b(?:rename|ren)\b|重命名|改名/i,
  write: /\b(?:write|edit|update|modify|save|fix)\b|写入|编辑|修改|更新|保存|修复/i,
};
const MUTATION_INTENT_COMPATIBILITY: Readonly<Record<
  MutationOperationKind,
  ReadonlySet<MutationOperationKind>
>> = {
  copy: new Set(['copy']),
  create: new Set(['create', 'write']),
  delete: new Set(['delete']),
  move: new Set(['move', 'rename']),
  rename: new Set(['move', 'rename']),
  write: new Set(['create', 'write']),
};

function hasExplicitMutationIntent(intent: string): boolean {
  return GENERAL_MUTATION_INTENT.test(intent)
    || Object.values(MUTATION_INTENT_TERMS).some((terms) => terms.test(intent));
}

function hasExplicitMutationDenial(intent: string): boolean {
  return Object.values(MUTATION_DENIAL_TERMS).some((terms) => terms.test(intent));
}

function isNonExecutingIntent(intent: string): boolean {
  return NON_EXECUTING_DENIAL_INTENT.test(intent)
    || NON_EXECUTING_REQUEST_INTENT.test(intent)
    || REVIEW_QUESTION_INTENT.test(intent)
    || (REVIEW_REQUEST_INTENT.test(intent)
      && (hasExplicitMutationDenial(intent) || !hasExplicitMutationIntent(intent)));
}

function bindingConstraintsRequireReview(
  operation: AutoModePermissionOperation,
  constraints: readonly string[],
): boolean {
  if (constraints.length === 0) return false;
  if (
    operation.kind !== 'read'
    && !(operation.kind === 'execute' && operation.options?.readOnly === true)
    && operation.options?.whatIf !== true
  ) return true;
  return constraints.some((constraint) => {
    if (operation.kind === 'read' && readIntentRequiresReview(operation, constraint)) return true;
    if (operation.kind === 'execute' && executionIntentRequiresReview(constraint)) return true;
    return intentConstraintClauses(constraint).some((clause) => {
      if (MUTATION_ONLY_RESTRICTION.test(clause)) return false;
      if (operation.kind === 'read' && AFFIRMATIVE_PRONOUN_READ.test(clause)) return false;
      return READ_OR_EXECUTION_RESTRICTION.test(clause) || clause.trim().length > 0;
    });
  });
}

function intentConstraintClauses(intent: string): string[] {
  return intent.split(
    /(?:[\r\n,;!?，。；！？]+|\.(?=\s|$)|\b(?:but|however|except)\b|(?:但是|但|不过|除非))/i,
  ).map((clause) => clause.trim()).filter(Boolean);
}

function operationTargetPaths(operation: AutoModePermissionOperation): string[] {
  return 'target' in operation
    ? [operation.target.path]
    : 'source' in operation
      ? [operation.source.path, operation.destination.path]
      : [];
}

function normalizedTargetBasenames(operation: AutoModePermissionOperation): Set<string> {
  const paths = operationTargetPaths(operation);
  return new Set(paths.map((value) => (
    value.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1)?.toLowerCase() ?? ''
  )));
}

function normalizedReadTargetReferences(operation: AutoModePermissionOperation): Set<string> {
  const references = new Set<string>();
  for (const value of operationTargetPaths(operation)) {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!normalized) continue;
    references.add(normalized);
    const segments = normalized.split('/').filter((segment) => (
      segment.length >= 2 && !/^[a-z]:$/i.test(segment)
    ));
    for (let index = 0; index < segments.length; index += 1) {
      const suffix = segments.slice(index).join('/');
      references.add(suffix);
      if (index < segments.length - 1) {
        references.add(segments[index]);
        references.add(`${segments[index]}/`);
        references.add(`${segments[index]}/.`);
      }
    }
  }
  return references;
}

function replaceIntentTargetReferences(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): string {
  return [...normalizedReadTargetReferences(operation)]
    .sort((left, right) => right.length - left.length)
    .reduce((intent, value) => (
      intent.replace(referenceTokenPattern(value, true), (_match, prefix: string) => (
        `${prefix} target `
      ))
    ), currentIntent);
}

type ReadScopeRelation = 'none' | 'matches' | 'differs';

function exclusiveReadScopeRelation(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): ReadScopeRelation {
  if (operation.kind !== 'read') return 'none';
  const explicitReferences = EXCLUSIVE_READ_SCOPE_REFERENCES.flatMap((pattern) => (
    [...currentIntent.matchAll(pattern)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined)
  ));
  const fallbackReferences = explicitReferences.length === 0
    && IMPLICIT_EXCLUSIVE_READ_SCOPE.test(currentIntent)
    ? [...currentIntent.matchAll(CONCRETE_FILE_REFERENCE)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined)
    : [];
  const references = [...explicitReferences, ...fallbackReferences]
    .map((reference) => reference
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\\/g, '/')
      .replace(/[.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f]+$/, '')
      .replace(/\/(?:\.)?$/, '')
      .toLowerCase())
    .filter((reference) => reference.length > 0
      && !/^(?:it|this|file|files|folder|folders|directory|directories|path|paths)$/.test(reference));
  if (references.length === 0) return 'none';
  const targetPaths = operationTargetPaths(operation).map((value) => (
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  ));
  const matches = references.some((scope) => targetPaths.some((target) => (
    target === scope
    || target.endsWith(`/${scope}`)
    || target.startsWith(`${scope}/`)
    || target.includes(`/${scope}/`)
  )));
  return matches ? 'matches' : 'differs';
}

function intentMayConstrainReadTarget(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): boolean {
  if (operation.kind !== 'read') return false;
  const scopeRelation = exclusiveReadScopeRelation(operation, currentIntent);
  if (scopeRelation === 'differs') return true;
  const lowerIntent = currentIntent.toLowerCase();
  const targetReferences = [...normalizedReadTargetReferences(operation)];
  if (!targetReferences.some((reference) => referenceTokenPattern(reference).test(lowerIntent))) {
    return false;
  }
  const intentWithTarget = replaceIntentTargetReferences(operation, currentIntent);
  if (DIRECT_TARGET_EXCLUSION.test(intentWithTarget)) return true;
  if (scopeRelation === 'matches') return false;
  const clauses = intentConstraintClauses(intentWithTarget);
  const hasAffirmativePronounRead = clauses.some((clause) => AFFIRMATIVE_PRONOUN_READ.test(clause));
  const targetClauses = clauses
    .filter((clause) => /\btarget\b/i.test(clause));
  // Mentioning a target is not proof that reading it is authorized. Preserve
  // the fast path only for an explicit affirmative read/review request; route
  // unfamiliar or elliptical wording to the classifier for semantic judgment.
  return targetClauses.length === 0
    || targetClauses.some((clause) => !AFFIRMATIVE_TARGET_READ.test(clause)
      && !(hasAffirmativePronounRead && MUTATION_ONLY_RESTRICTION.test(clause)));
}

function readIntentRequiresReview(
  operation: AutoModePermissionOperation,
  intent: string,
): boolean {
  if (intentMayConstrainReadTarget(operation, intent)) return true;
  return intentConstraintClauses(intent).some((sourceClause) => {
    if (exclusiveReadScopeRelation(operation, sourceClause) === 'matches') return false;
    const clause = intentWithoutOperationPaths(operation, sourceClause);
    if (MUTATION_ONLY_RESTRICTION.test(clause)
      && !matchesConstraintCandidate(clause, READ_CONSTRAINT_CANDIDATES)) return false;
    if (AFFIRMATIVE_PRONOUN_READ.test(clause)) return false;
    return GENERAL_OPERATION_CONSTRAINT.test(clause)
      || matchesConstraintCandidate(clause, READ_CONSTRAINT_CANDIDATES)
      || intentMayConstrainReadTarget(operation, sourceClause);
  });
}

function hasPotentialExecutionChannelConstraint(intent: string): boolean {
  return intentConstraintClauses(intent).some((clause) => (
    EXECUTION_ALTERNATIVE_SCOPE.test(clause)
  ));
}

function executionIntentRequiresReview(intent: string): boolean {
  if (hasPotentialExecutionChannelConstraint(intent)) return true;
  if (EXECUTION_CHANNEL_DENIAL.test(intent) || EXECUTION_SCOPE_QUALIFIER.test(intent)) return true;
  const semanticConstraint = intentConstraintClauses(intent).some((clause) => {
    if (MUTATION_ONLY_RESTRICTION.test(clause)
      && !matchesConstraintCandidate(clause, EXECUTION_CONSTRAINT_CANDIDATES)) return false;
    return GENERAL_OPERATION_CONSTRAINT.test(clause)
      || matchesConstraintCandidate(clause, EXECUTION_CONSTRAINT_CANDIDATES);
  });
  if (semanticConstraint) return true;
  if (!EXECUTION_CHANNEL_REFERENCE.test(intent)) return false;
  // Remove only channel references that are directly bound to a genuine
  // execution request. Any other mention (documentation, terminology, taboo,
  // or a second channel in another clause) is ambiguous and needs semantic
  // review instead of borrowing authority from an unrelated phrase.
  const unmatchedChannelReferences = intent.replace(AFFIRMATIVE_CHANNEL_EXECUTION, ' ');
  return EXECUTION_CHANNEL_REFERENCE.test(unmatchedChannelReferences);
}

function permissionReviewRequiresExecutionIntentReview(
  permissionReview: AutoModePermissionReview,
  intentEvidence?: PermissionIntentEvidence,
): boolean {
  if (permissionReview.analysis.shell === 'tool') return false;
  const currentIntent = intentEvidence?.currentUserContent?.trim();
  if (currentIntent && executionIntentRequiresReview(currentIntent)) return true;
  return (intentEvidence?.bindingConstraints ?? [])
    .some((constraint) => executionIntentRequiresReview(constraint));
}

function intentWithoutOperationPaths(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): string {
  const lexemes = operationTargetPaths(operation).flatMap((value) => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    const basename = normalized.split('/').at(-1) ?? '';
    return [value, normalized, basename];
  });
  return [...new Set(lexemes.filter((value) => value.length > 1))]
    .sort((left, right) => right.length - left.length)
    .reduce((intent, value) => (
      intent.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' target ')
    ), currentIntent);
}

function normalizedMutationSubjectReferences(
  operation: AutoModePermissionOperation,
): Set<string> {
  const paths = 'target' in operation
    ? [operation.target.path]
    : 'source' in operation
      ? [operation.source.path]
      : [];
  const references = new Set<string>();
  for (const value of paths) {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const basename = normalized.split('/').at(-1) ?? '';
    if (normalized.length > 1) references.add(normalized);
    if (basename.length > 1) references.add(basename);
  }
  return references;
}

function normalizedMutationDestinationReferences(
  operation: AutoModePermissionOperation,
): Set<string> {
  if (!('destination' in operation)) return new Set();
  const normalized = operation.destination.path
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  const references = new Set<string>();
  if (normalized.length > 1) references.add(normalized);
  const basename = segments.at(-1) ?? '';
  const parent = segments.at(-2) ?? '';
  if (basename.length > 1) references.add(basename);
  if (parent.length > 1 && !/^[a-z]:$/i.test(parent)) references.add(parent);
  const sourceNormalized = operation.source.path
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  const sourceSegments = sourceNormalized.split('/').filter(Boolean);
  references.delete(sourceSegments.at(-1) ?? '');
  if (parent === sourceSegments.at(-2)) references.delete(parent);
  return references;
}

function intentMentionsReferences(intent: string, references: ReadonlySet<string>): boolean {
  const normalizedIntent = intent.toLowerCase().replace(/\\/g, '/');
  return [...references].some((reference) => referenceTokenPattern(reference).test(normalizedIntent));
}

function referenceTokenPattern(reference: string, global = false): RegExp {
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = String.raw`(?=$|[\s"'\x60,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f)]|\.(?=$|\s)|\/[.]?(?=$|[\s"'\x60,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f)]))`;
  return new RegExp(
    String.raw`(^|[^A-Za-z0-9_.\\/-])${escaped}${boundary}`,
    global ? 'gi' : 'i',
  );
}

function replaceIntentReferences(
  currentIntent: string,
  references: ReadonlySet<string>,
  placeholder: string,
): string {
  return [...references]
    .sort((left, right) => right.length - left.length)
    .reduce((intent, value) => (
      intent.replace(referenceTokenPattern(value, true), (_match, prefix: string) => (
        `${prefix} ${placeholder} `
      ))
    ), currentIntent);
}

function intentMentionsMutationSubject(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): boolean {
  return intentMentionsReferences(currentIntent, normalizedMutationSubjectReferences(operation));
}

function intentMentionsMutationPath(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): boolean {
  return intentMentionsMutationSubject(operation, currentIntent)
    || intentMentionsReferences(currentIntent, normalizedMutationDestinationReferences(operation));
}

function intentWithMutationSubject(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): string {
  return replaceIntentReferences(
    currentIntent.replace(/\\/g, '/'),
    normalizedMutationSubjectReferences(operation),
    'target',
  );
}

const MUTATION_SUBJECT_AFFIRMATIVE: Readonly<Record<MutationOperationKind, RegExp>> = {
  copy: /\b(?:copy|cp|duplicate)\s+(?:(?:the|requested|file)\s+){0,2}target\b|(?:\u590d\u5236|\u62f7\u8d1d)\s*target\b|(?:\u628a|\u5c06)\s*target\s*(?:\u590d\u5236|\u62f7\u8d1d)/i,
  create: /\b(?:create|generate|make|write|edit|update|modify|save|fix|implement|change)\s+(?:(?:the|requested|current|file|contents?|changes?|in|to|for|of)\s+){0,4}target\b|(?:\u521b\u5efa|\u65b0\u5efa|\u751f\u6210|\u5199\u5165|\u7f16\u8f91|\u4fee\u6539|\u66f4\u65b0|\u4fee\u590d)\s*target\b/i,
  delete: /\b(?:delete|del|erase|remove|rm|rmdir)\s+(?:(?:the|requested|file)\s+){0,2}target\b|(?:\u5220\u9664|\u79fb\u9664|\u6e05\u7406)\s*(?:(?:workspace|\u5de5\u4f5c\u533a|\u9879\u76ee|\u76ee\u5f55|\u6587\u4ef6\u5939)\s*(?:\u4e2d|\u5185)?\s*\u7684?\s*)?target\b/i,
  move: /\b(?:move|mv|relocate|organize|rename|ren)\s+(?:(?:the|requested|file)\s+){0,2}target\b|(?:\u79fb\u52a8|\u79fb\u5230|\u642c\u5230|\u6574\u7406|\u91cd\u547d\u540d|\u6539\u540d)\s*target\b|(?:\u628a|\u5c06)\s*target\s*(?:\u79fb\u52a8|\u79fb\u5230|\u79fb\u81f3|\u642c\u5230|\u6574\u7406|\u91cd\u547d\u540d|\u6539\u540d)/i,
  rename: /\b(?:move|mv|relocate|rename|ren)\s+(?:(?:the|requested|file)\s+){0,2}target\b|(?:\u79fb\u52a8|\u91cd\u547d\u540d|\u6539\u540d)\s*target\b|(?:\u628a|\u5c06)\s*target\s*(?:\u79fb\u52a8|\u79fb\u5230|\u79fb\u81f3|\u91cd\u547d\u540d|\u6539\u540d)/i,
  write: /\b(?:create|generate|make|write|edit|update|modify|save|fix|implement|change)\s+(?:(?:the|requested|current|file|contents?|changes?|in|to|for|of)\s+){0,4}target\b|(?:\u521b\u5efa|\u65b0\u5efa|\u751f\u6210|\u5199\u5165|\u7f16\u8f91|\u4fee\u6539|\u66f4\u65b0|\u4fee\u590d)\s*target\b/i,
};
const MUTATION_TARGET_EXCLUSION = /\b(?:not|never|except(?:\s+for)?|excluding|without)\s+(?:to\s+)?target\b|\b(?:other\s+than|apart\s+from|with\s+the\s+exception\s+of|save\s+for)\s+target\b|\bleave\s+target\s+(?:alone|untouched|unchanged)\b|\b(?:keep|preserve)\s+target\b|\btarget\b\s+(?:(?:is|must\s+be|should\s+be)\s+(?:taboo|forbidden|off[- ]limits?)|(?:must|should)\s+remain)\b|(?:\u4e0d\u8981|\u522b|\u7981\u6b62|\u907f\u514d|\u6392\u9664).{0,16}\btarget\b|(?:\u9664\u4e86|\u9664)\s*\btarget\b\s*(?:\u4ee5\u5916|\u4e4b\u5916|\u5916)|\btarget\b\s*(?:\u4ee5\u5916|\u4e4b\u5916)|\btarget\b.{0,12}(?:\u4e0d\u8981\u52a8|\u4fdd\u6301\u4e0d\u53d8|\u662f\u7981\u533a)/i;
const MUTATION_DESTINATION_AFFIRMATIVE: Readonly<Record<'copy' | 'move' | 'rename', RegExp>> = {
  copy: /\b(?:to|into|as)\s+(?:the\s+)?destination\b|(?:\u5230|\u81f3|\u4e3a)\s*destination\b/i,
  move: /\b(?:to|into|as)\s+(?:the\s+)?destination\b|(?:\u5230|\u81f3|\u4e3a)\s*destination\b/i,
  rename: /\b(?:to|as)\s+(?:the\s+)?destination\b|(?:\u4e3a|\u6210|\u5230)\s*destination\b/i,
};
const MUTATION_QUALIFIER_CANDIDATE = /\b(?:but|however|without|except|excluding|only|conceptually|advisory|non[- ]invasive|analysis[- ]only|do\s+not|don't|dont|never|avoid|no|not|keep|leave|preserve|must|should|shall|cannot|can't|after|before|when|once|until|unless|if|pending|later|tomorrow|eventually|upon|provided|assuming|confirmation|approval|permission|confirm|approve|object|say\s+go|tests?\s+pass)\b|(?:\u4f46\u662f|\u4f46|\u4e0d\u8fc7|\u4e0d\u8981|\u8bf7\u52ff|\u52ff|\u522b|\u7981\u6b62|\u907f\u514d|\u4ec5|\u53ea|\u6982\u5ff5\u4e0a|\u5efa\u8bae\u6027|\u4ec5\u5206\u6790|\u5982\u679c|\u9664\u975e|\u7b49\u5230|\u7b49\u5f85|\u786e\u8ba4\u540e|\u6279\u51c6\u540e|\u4e4b\u524d|\u4e4b\u540e|\u660e\u5929|\u7a0d\u540e|\u5f85\u786e\u8ba4)/i;
const UNCERTAIN_MUTATION_QUALIFIER = /\b(?:may|might|maybe|perhaps|possibly|could|would|can)\b/i;
const POLITE_MUTATION_PREFIX = /^\s*(?:(?:(?:could|would|can|will)\s+you\b|please\b|kindly\b)\s*)+/i;

function mutationIntentHasQualifier(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): boolean {
  const withoutPaths = intentWithoutOperationPaths(operation, currentIntent);
  const withoutPolitePrefix = withoutPaths.replace(POLITE_MUTATION_PREFIX, '');
  return MUTATION_QUALIFIER_CANDIDATE.test(withoutPaths)
    || UNCERTAIN_MUTATION_QUALIFIER.test(withoutPolitePrefix);
}

function mutationSubjectIsAffirmative(
  operation: AutoModePermissionOperation,
  operationKind: MutationOperationKind,
  currentIntent: string,
): boolean {
  const markedIntent = intentWithMutationSubject(operation, currentIntent);
  if (MUTATION_TARGET_EXCLUSION.test(markedIntent)) return false;
  if (MUTATION_SUBJECT_AFFIRMATIVE[operationKind].test(markedIntent)) return true;
  if (operationKind !== 'create' && operationKind !== 'write') return false;
  // Preserve compact non-English requests whose existing vocabulary is known,
  // while refusing to borrow a verb from a clause that names another file.
  // Destructive and relocation operations intentionally do not use this broad
  // fallback: an indirect qualifier belongs with the classifier, which can
  // still allow the action without involving the user.
  return intentConstraintClauses(markedIntent)
    .filter((clause) => /\btarget\b/i.test(clause))
    .some((clause) => requestedMutationKinds(clause)
      .some((kind) => MUTATION_INTENT_COMPATIBILITY[operationKind].has(kind))
      && [...clause.matchAll(CONCRETE_FILE_REFERENCE)].length === 0);
}

function mutationDestinationIsCompatible(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): boolean {
  if (!('destination' in operation)) return true;
  const destinationReferences = normalizedMutationDestinationReferences(operation);
  const mentionsDestination = intentMentionsReferences(currentIntent, destinationReferences);
  let markedIntent = replaceIntentReferences(
    currentIntent.replace(/\\/g, '/'),
    normalizedMutationSubjectReferences(operation),
    'source',
  );
  markedIntent = replaceIntentReferences(markedIntent, destinationReferences, 'destination');
  const destinationAsTarget = markedIntent.replace(/\bdestination\b/gi, ' target ');
  const namesSystemTemp = /\b(?:temp|temporary)\s+(?:folder|directory)\b|(?:\u7cfb\u7edf)?\u4e34\u65f6(?:\u6587\u4ef6\u5939|\u76ee\u5f55)/i.test(currentIntent)
    || /(?:^|[\s"'`])(?:%temp%|%tmp%|\$env:(?:temp|tmp)|\$\{env:(?:temp|tmp)\}|\$\{(?:temp|tmp|tmpdir)\}|\$(?:temp|tmp|tmpdir))(?=$|[\\/\s.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f])/i.test(currentIntent);
  if (operation.destination.boundary === 'system-temp' && namesSystemTemp) return true;
  if (mentionsDestination) {
    return !MUTATION_TARGET_EXCLUSION.test(destinationAsTarget)
      && MUTATION_DESTINATION_AFFIRMATIVE[operation.kind].test(markedIntent);
  }
  // A source-only request does not authorize a concrete destination selected
  // by the agent. The LLM may still allow it without involving the user.
  return false;
}

function intentNamesOnlyDifferentConcreteFiles(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): boolean {
  const references = [
    ...currentIntent.matchAll(CONCRETE_FILE_REFERENCE),
    ...currentIntent.matchAll(ACTION_SCOPED_REFERENCE),
  ]
    .map((match) => match[1]?.replace(/[.,;:!?]+$/, '').toLowerCase())
    .filter((value): value is string => value !== undefined);
  if (references.length === 0) return false;
  const targets = normalizedTargetBasenames(operation);
  return !references.some((reference) => {
    const basename = reference.replace(/\\/g, '/').split('/').at(-1) ?? reference;
    return targets.has(basename);
  });
}

function intentRequestsDifferentMutation(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): boolean {
  if (
    operation.kind === 'read'
    || operation.kind === 'execute'
    || operation.kind === 'unknown'
  ) return false;
  const operationKind: MutationOperationKind = operation.kind;
  const requested = requestedMutationKinds(currentIntent);
  return requested.length > 0
    && !requested.some((kind) => MUTATION_INTENT_COMPATIBILITY[operationKind].has(kind));
}

function requestedMutationKinds(intent: string): MutationOperationKind[] {
  return (Object.entries(MUTATION_INTENT_TERMS) as Array<
    [MutationOperationKind, RegExp]
  >)
    .filter(([, terms]) => terms.test(intent))
    .map(([kind]) => kind);
}

function mutationHasCompatibleAffirmativeIntent(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): boolean {
  if (
    operation.kind === 'read'
    || operation.kind === 'execute'
    || operation.kind === 'unknown'
  ) return false;
  const operationKind: MutationOperationKind = operation.kind;
  // Deterministic mutation admission is reserved for an unqualified direct
  // authorization. Any extra limitation is semantic—even when it does not use
  // one of our known denial phrases—and therefore belongs to the classifier.
  if (mutationIntentHasQualifier(operation, currentIntent)) return false;
  if (intentMentionsMutationSubject(operation, currentIntent)) {
    return mutationSubjectIsAffirmative(operation, operationKind, currentIntent)
      && mutationDestinationIsCompatible(operation, currentIntent);
  }
  if (operationKind === 'copy'
    || operationKind === 'delete'
    || operationKind === 'move'
    || operationKind === 'rename') return false;
  const intentWithoutTargets = intentWithoutOperationPaths(operation, currentIntent);
  if (GENERAL_MUTATION_INTENT.test(intentWithoutTargets)) {
    return operationKind === 'create' || operationKind === 'write';
  }
  return requestedMutationKinds(intentWithoutTargets)
    .some((kind) => MUTATION_INTENT_COMPATIBILITY[operationKind].has(kind))
    && mutationDestinationIsCompatible(operation, currentIntent);
}

function mutationContradictsCurrentIntent(
  operation: AutoModePermissionOperation,
  currentIntent: string,
): boolean {
  if (
    operation.kind === 'read'
    || operation.kind === 'execute'
    || operation.kind === 'unknown'
  ) return false;
  const intentWithoutTargets = intentWithoutOperationPaths(operation, currentIntent);
  return MUTATION_DENIAL_TERMS[operation.kind].test(intentWithoutTargets)
    || NO_MUTATION_SCOPE_RESTRICTION.test(intentWithoutTargets)
    || isNonExecutingIntent(intentWithoutTargets)
    || intentRequestsDifferentMutation(operation, intentWithoutTargets)
    || intentNamesOnlyDifferentConcreteFiles(operation, currentIntent);
}

function isAllowedMutationBoundary(boundary: AutoModePermissionBoundary): boolean {
  return boundary === 'workspace' || boundary === 'system-temp';
}

function isDeterministicallyAllowedOperation(
  operation: AutoModePermissionOperation,
): boolean {
  if (operation.options?.whatIf === true) return true;
  if (operation.kind === 'execute') {
    return operation.options?.readOnly === true || operation.options?.contained === true;
  }
  if (operation.kind === 'unknown') return false;
  if (operation.kind === 'read') {
    return operation.target.boundary !== 'protected'
      && operation.target.boundary !== 'unresolved';
  }
  if ('target' in operation) return isAllowedMutationBoundary(operation.target.boundary);
  if (!('source' in operation)) return false;
  if (operation.kind === 'copy') {
    return isAllowedMutationBoundary(operation.destination.boundary)
      && operation.source.boundary !== 'protected'
      && operation.source.boundary !== 'unresolved';
  }
  return isAllowedMutationBoundary(operation.source.boundary)
    && isAllowedMutationBoundary(operation.destination.boundary);
}

function operationRequiresIntentReview(
  operation: AutoModePermissionOperation,
  intentEvidence?: PermissionIntentEvidence,
): boolean {
  const bindingConstraints = intentEvidence?.bindingConstraints ?? [];
  if (bindingConstraintsRequireReview(operation, bindingConstraints)) return true;
  if (operation.options?.whatIf === true) return false;
  const currentIntent = intentEvidence?.currentUserContent?.trim();
  if (operation.kind === 'read') {
    return currentIntent ? readIntentRequiresReview(operation, currentIntent) : false;
  }
  if (operation.kind === 'execute' && operation.options?.readOnly === true) {
    return currentIntent ? executionIntentRequiresReview(currentIntent) : false;
  }
  // A compacted request is not complete authority for a mutation: a trailing
  // stop/deny constraint may have been omitted. Reads remain on the fast path,
  // but state-changing or unresolved operations must be classified.
  if (intentEvidence?.currentUserContentTruncated === true) return true;
  if (intentEvidence?.readOnly === true) return true;
  if (!currentIntent) return true;
  if (operation.kind === 'execute' || operation.kind === 'unknown') {
    return isNonExecutingIntent(currentIntent) || hasExplicitMutationDenial(currentIntent);
  }
  return mutationContradictsCurrentIntent(operation, currentIntent)
    || !mutationHasCompatibleAffirmativeIntent(operation, currentIntent);
}

function operationHasKnownIntentRestriction(
  operation: AutoModePermissionOperation,
  intentEvidence?: PermissionIntentEvidence,
): boolean {
  const bindingConstraints = intentEvidence?.bindingConstraints ?? [];
  if (bindingConstraintsRequireReview(operation, bindingConstraints)) return true;
  if (operation.options?.whatIf === true) return false;
  const currentIntent = intentEvidence?.currentUserContent?.trim();
  if (operation.kind === 'read') {
    return currentIntent ? readIntentRequiresReview(operation, currentIntent) : false;
  }
  if (operation.kind === 'execute' && operation.options?.readOnly === true) {
    return currentIntent ? executionIntentRequiresReview(currentIntent) : false;
  }
  if (intentEvidence?.currentUserContentTruncated === true) return true;
  if (intentEvidence?.readOnly === true) return true;
  if (!currentIntent) return false;
  return operation.kind === 'execute' || operation.kind === 'unknown'
    ? isNonExecutingIntent(currentIntent) || hasExplicitMutationDenial(currentIntent)
    : mutationContradictsCurrentIntent(operation, currentIntent)
      || mutationIntentHasQualifier(operation, currentIntent)
      || (intentMentionsMutationPath(operation, currentIntent)
        && !mutationHasCompatibleAffirmativeIntent(operation, currentIntent));
}

function isDeterministicallyAllowed(
  permissionReview: AutoModePermissionReview,
  intentEvidence?: PermissionIntentEvidence,
): boolean {
  if (
    permissionReview.analysis.status !== 'complete'
    || permissionReview.analysis.binding !== 'exact'
    || permissionReview.risks.some((risk) => !DETERMINISTIC_OPERATION_RISKS.has(risk))
    || permissionReview.operations.length === 0
  ) {
    return false;
  }
  if (permissionReviewRequiresExecutionIntentReview(permissionReview, intentEvidence)) {
    return false;
  }
  return permissionReview.operations.every((operation) => (
    isDeterministicallyAllowedOperation(operation)
    && !operationRequiresIntentReview(operation, intentEvidence)
  ));
}

export function createAutoModeToolGuardrail(
  config: AutoModeGuardrailConfig,
): AutoModeToolGuardrail {
  const state: AutoModeSharedState = config.sharedState ?? {
    denials: createDenialTracker(),
    breaker: createCircuitBreaker(),
  };
  const analyzeCall = config.analyzeCall ?? analyzeAutoModeCall;
  // For tests only: lets us swap the provider mid-flight.
  let providerOverride: KodaXBaseProvider | undefined;
  const automaticAllowCache = new Set<string>();

  // FEATURE_158: signal-collector set — defaults + extras. Frozen at
  // factory time so collectors don't change mid-session.
  const signalCollectors: readonly SignalCollector[] = [
    ...(config.signalCollectors ?? [bashSignalCollector, fileSignalCollector]),
    ...(config.extraCollectors ?? []),
  ];
  const projectRoot = config.projectRoot?.trim()
    ? config.projectRoot
    : config.executionCwd?.trim() ? config.executionCwd : '';
  const executionCwd = config.executionCwd?.trim() ? config.executionCwd : projectRoot;

  const beforeTool = async (
    call: RunnerToolCall,
    ctx: GuardrailContext,
    forceReview = false,
  ): Promise<GuardrailVerdict> => {
    const bridgeTarget = resolveToolBridgeTarget(call);
    const guardedCall = bridgeTarget?.ok ? bridgeTarget.call : call;
    // FEATURE_158: collect signals once per call for the classifier prompt.
    // Empty array when no collector matches.
    let signals: readonly ToolCallSignal[] = collectAllSignals(
      guardedCall,
      projectRoot,
      signalCollectors,
      executionCwd,
    );
    let permissionReview: AutoModePermissionReview | undefined;
    let intentEvidence: ReturnType<typeof buildPermissionIntentEvidence> | undefined;
    let toolSideEffect: ToolSideEffect | undefined;
    try {
      toolSideEffect = config.getToolSideEffect?.(guardedCall.name);
    } catch (error) {
      logAutoModeWarning(
        config.log,
        `[auto-mode] tool side-effect lookup failed (${errorCategory(error)})`,
      );
    }

    const allowFinal = (): GuardrailVerdict => {
      if ([
        'bash',
        'edit',
        'insert_after_anchor',
        'multi_edit',
        'undo',
        'write',
      ].includes(guardedCall.name)) {
        const sandboxReview = permissionReview ?? fallbackPermissionReview(
          guardedCall.name,
          action || safeFallbackToClassifierInput(guardedCall.name, guardedCall.input),
          'analyzer_unavailable',
        );
        config.admitWorkspaceSandboxCall?.(guardedCall, sandboxReview);
      }
      return { action: 'allow' };
    };

    const blockOnClassifierFailure = (reason: string): GuardrailVerdict => ({
      action: 'block',
      reason: `${AUTO_REVIEW_UNAVAILABLE_PREFIX}${reason.slice(0, 512)}. `
        + 'Try a safer, narrower, or reversible way to continue. If none exists, '
        + 'stop and ask the user for explicit direction before proposing the operation again.',
    });

    const fallbackOnClassifierException = (
      error: unknown,
    ): GuardrailVerdict => {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      state.breaker = recordBreakerError(state.breaker, Date.now());
      const reason = `classifier error (${errorCategory(error)})`;
      logAutoModeWarning(config.log, `[auto-mode] ${reason}`);
      return blockOnClassifierFailure(reason);
    };

    // Catastrophic host operations are not authorization questions: block them
    // before Auto[LLM]. Agent Home matches are reviewer evidence only; they do
    // not create a second shell boundary outside the Runtime-owned route.
    const builtInTier0 = checkAbsoluteDeny(guardedCall, projectRoot, executionCwd);
    const tier0: AbsoluteDenyResult = (config.extraAbsoluteDenyChecks ?? []).reduce<AbsoluteDenyResult>((result, check) => (
      result.denied ? result : check(guardedCall, projectRoot, executionCwd)
    ), builtInTier0);
    if (tier0.denied) {
      logAutoModeWarning(
        config.log,
        `[auto-mode] high-impact static pattern matched (${tier0.patternId}): ${tier0.reason}`,
      );
      if (builtInTier0.denied && builtInTier0.patternId !== 'user_kodax_write') {
        return { action: 'block', reason: tier0.reason };
      }
      signals = [...signals, {
        kind: 'dangerous_pattern',
        pattern: `static_match=${tier0.patternId}; ${tier0.reason}`,
        severity: 'high',
      }];
    }

    if (denialLimitReached(state.denials)) {
      return { action: 'block', reason: AUTO_REVIEW_DENIAL_LIMIT_REASON };
    }

    // Tier 1: explicitly exempt tools may opt out through an empty projection.
    // Direct read tools additionally require deterministic target analysis.
    // Unknown tools use a metadata-only fallback so missing extension metadata
    // cannot silently bypass Auto[LLM].
    let action: string;
    try {
      const projector = config.getToolProjection(guardedCall.name);
      const projected: unknown = projector
        ? projector(guardedCall.input)
        : safeFallbackToClassifierInput(guardedCall.name, guardedCall.input);
      if (typeof projected !== 'string') throw new TypeError('invalid classifier projection');
      action = projected;
    } catch (error) {
      logAutoModeWarning(
        config.log,
        `[auto-mode] tool classifier projection failed for "${guardedCall.name}"; `
          + `using safe fallback (${errorCategory(error)})`,
      );
      action = safeFallbackToClassifierInput(guardedCall.name, guardedCall.input);
    }
    if (tier0.denied && action === '') {
      action = safeFallbackToClassifierInput(guardedCall.name, guardedCall.input);
    }
    const requiresReadAnalysis = DETERMINISTIC_READ_TOOLS.has(guardedCall.name);
    if (action !== '' || requiresReadAnalysis) {
      try {
        permissionReview = await analyzeCall(guardedCall, {
          projectRoot,
          executionCwd,
          signals,
          toolSideEffect,
          trustProcessEnvironmentPathExpansion:
            config.trustProcessEnvironmentPathExpansion !== false,
        });
      } catch (error) {
        logAutoModeWarning(
          config.log,
          `[auto-mode] permission analyzer failed (${errorCategory(error)}); using classifier fallback`,
        );
        if (action === '') {
          action = safeFallbackToClassifierInput(guardedCall.name, guardedCall.input);
        }
        permissionReview = fallbackPermissionReview(guardedCall.name, action, 'analyzer_failed');
      }
    }
    if (!permissionReview && requiresReadAnalysis) {
      if (action === '') {
        action = safeFallbackToClassifierInput(guardedCall.name, guardedCall.input);
      }
      permissionReview = fallbackPermissionReview(
        guardedCall.name,
        action,
        'analyzer_unavailable',
      );
    }
    if (!permissionReview && !requiresReadAnalysis && toolSideEffect) {
      permissionReview = permissionReviewFromDeclaredSideEffect(
        guardedCall.name,
        toolSideEffect,
        guardedCall.input,
      );
    }
    if (!permissionReview && ctx.permissionIntent !== undefined && action !== '') {
      permissionReview = fallbackPermissionReview(
        guardedCall.name,
        action,
        'analyzer_unavailable',
      );
    }
    let permissionAction = action;
    if (permissionReview) {
      permissionAction = serializePermissionReview(permissionReview, action);
      intentEvidence = buildPermissionIntentEvidence(
        ctx.messages ?? [],
        permissionAction,
        undefined,
        ctx.permissionIntent,
      );
    } else if (ctx.permissionIntent !== undefined) {
      intentEvidence = buildPermissionIntentEvidence(
        ctx.messages ?? [],
        permissionAction,
        undefined,
        ctx.permissionIntent,
      );
    }
    const userIntentRevision = automaticPermissionIntentRevision(ctx.messages ?? []);
    if (
      !forceReview && !tier0.denied && permissionReview
      && isDeterministicallyAllowed(permissionReview, intentEvidence)
    ) {
      return allowFinal();
    }
    if (action === '') {
      if (requiresReadAnalysis && permissionReview) {
        // Unsafe, protected, or unresolved reads still receive an LLM review
        // using the structured permission facts even though their legacy tool
        // projection is empty.
        permissionAction = serializePermissionReview(permissionReview, 'read');
        intentEvidence = buildPermissionIntentEvidence(
          ctx.messages ?? [],
          permissionAction,
          undefined,
          ctx.permissionIntent,
        );
      } else {
        return allowFinal();
      }
    }

    // Resolve the complete override chain before consulting failure trackers.
    // A missing model is a local configuration error, not classifier
    // infrastructure instability. Apply the same bounded fallback without
    // calling the provider or advancing either tracker.
    let resolved: ReturnType<typeof resolveClassifierModel>;
    try {
      resolved = resolveClassifierModel(buildResolveOptions(config));
    } catch (error) {
      return fallbackOnClassifierException(error);
    }
    if (typeof resolved.model !== 'string' || resolved.model.trim().length === 0) {
      const reason = 'auto-mode classifier model is not configured; select a model before using Auto LLM';
      logAutoModeWarning(config.log, `[auto-mode] ${reason}`);
      return blockOnClassifierFailure(reason);
    }
    let classifierClaudeMd: string | undefined;
    try {
      classifierClaudeMd = intentEvidence
        ? undefined
        : config.getClaudeMd?.() ?? config.claudeMd;
    } catch (error) {
      return fallbackOnClassifierException(error);
    }
    const automaticAllowKey = createHash('sha256').update(JSON.stringify({
      projectRoot,
      executionCwd,
      tool: guardedCall.name,
      action: permissionAction,
      intentRevision: userIntentRevision,
      permissionIntent: ctx.permissionIntent ?? null,
      classifier: {
        provider: resolved.providerName,
        model: resolved.model,
      },
      claudeMd: classifierClaudeMd ?? null,
      signals,
    })).digest('hex');
    if (!forceReview && automaticAllowCache.has(automaticAllowKey)) return allowFinal();

    // Infrastructure degradation fails closed and never asks the user.
    if (breakerShouldFallback(state.breaker, Date.now())) {
      return blockOnClassifierFailure('classifier infrastructure is degraded');
    }

    // Resolve the configured provider only after the final model check and
    // threshold gates. Provider lookup itself is local; the first network
    // request happens later inside classify().
    let provider: KodaXBaseProvider | undefined;
    try {
      provider = providerOverride ?? config.resolveProvider(resolved.providerName);
    } catch (error) {
      return fallbackOnClassifierException(error);
    }
    if (!provider) {
      return blockOnClassifierFailure(
        `classifier provider "${resolved.providerName}" is not configured`,
      );
    }

    let decision: ClassifyDecision;
    try {
      decision = await classify({
        provider,
        model: resolved.model,
        rules: config.rules,
        administratorPolicy: config.administratorPolicy,
        reviewPolicy: config.reviewPolicy,
        modelGuidance: config.modelGuidance,
        // Compact review deliberately excludes AGENTS.md. An analyzer override
        // that declines the call retains the legacy live/static behavior.
        claudeMd: classifierClaudeMd,
        // classify() ignores transcript when intentEvidence is present; keeping
        // the parameter here preserves its standalone/legacy API.
        transcript: ctx.messages ?? [],
        action: permissionAction,
        intentEvidence,
        getToolProjection: config.getToolProjection,
        signals,
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        abortSignal: ctx.abortSignal,
        costTracker: config.getCostTracker?.(),
        setCostTracker: config.setCostTracker,
      });
    } catch (error) {
      return fallbackOnClassifierException(error);
    }

    // Map decision to verdict and update diagnostic trackers.
    switch (decision.kind) {
      case 'allow':
        state.denials = recordDenialAllow(state.denials);
        automaticAllowCache.add(automaticAllowKey);
        while (automaticAllowCache.size > 64) {
          const oldest = automaticAllowCache.values().next().value as string | undefined;
          if (oldest === undefined) break;
          automaticAllowCache.delete(oldest);
        }
        return allowFinal();

      case 'confirm':
        state.denials = recordDenialBlock(state.denials);
        return denialLimitReached(state.denials)
          ? { action: 'block', reason: `${AUTO_REVIEW_DENIAL_LIMIT_REASON} Review reason: ${decision.reason}` }
          : { action: 'block', reason: `${AUTO_REVIEW_DENIED_PREFIX}${decision.reason}` };

      case 'failure':
        state.breaker = recordBreakerError(state.breaker, Date.now());
        return blockOnClassifierFailure(decision.reason);
    }
  };

  const getStats = (): AutoModeStats => ({
    classifierHealth: breakerShouldFallback(state.breaker, Date.now())
      ? 'degraded'
      : 'healthy',
    denials: state.denials,
    breaker: state.breaker,
  });
  return {
    kind: 'tool',
    name: 'auto-mode',
    beforeTool,
    reviewHostBoundary: (call, ctx) => beforeTool(call, ctx, true),
    resetTurn: () => {
      state.denials = createDenialTracker();
    },
    getStats,
    getStatsForTest: getStats,
    setProviderForTest: (p) => { providerOverride = p; },
  };
}

function buildResolveOptions(
  config: AutoModeGuardrailConfig,
): ResolveClassifierModelOptions {
  // FEATURE_092 v0.7.34 hotfix-3: normalize getDefaultProvider/getDefaultModel
  // (live getters) over defaultProvider/defaultModel (static strings) so the
  // classifier picks up mid-session `/model` and `/provider` swaps. The
  // ResolveClassifierModelOptions interface stays string-typed — normalization
  // happens here, before the call into resolveClassifierModel.
  return {
    cliFlag: config.cliFlag,
    envVar: config.envVar,
    sessionOverride: config.sessionOverride,
    userSettings: config.userSettings,
    defaultProvider: config.getDefaultProvider?.() ?? config.defaultProvider,
    defaultModel: config.getDefaultModel?.() ?? config.defaultModel,
  };
}

const MAX_PERMISSION_REVIEW_BYTES = 8 * 1024;
const MAX_PERMISSION_ACTION_EVIDENCE_BYTES = 1536;

function serializePermissionReview(review: AutoModePermissionReview, action: string): string {
  const actionEvidence = review.analysis.status === 'incomplete'
    ? buildPermissionActionEvidence(action)
    : undefined;
  const envelope = actionEvidence ? { ...review, actionEvidence } : review;
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_PERMISSION_REVIEW_BYTES) return serialized;

  const kindCounts: Record<string, number> = {};
  const boundaryCounts: Record<string, number> = {};
  for (const operation of review.operations) {
    kindCounts[operation.kind] = (kindCounts[operation.kind] ?? 0) + 1;
    for (const target of permissionOperationTargets(operation)) {
      boundaryCounts[target.boundary] = (boundaryCounts[target.boundary] ?? 0) + 1;
    }
  }
  const sampleOperations = selectPermissionOperationSamples(review.operations);
  const sample = sampleOperations.map(compactPermissionOperation);
  return JSON.stringify({
    schemaVersion: review.schemaVersion,
    analysis: review.analysis,
    evidence: {
      status: 'targeted',
      sourceBytes: Buffer.byteLength(serialized, 'utf8'),
      sha256: createHash('sha256').update(serialized).digest('hex'),
    },
    operationSummary: {
      count: review.operations.length,
      kindCounts,
      boundaryCounts,
      sample,
    },
    risks: review.risks,
    ...(actionEvidence ? { actionEvidence } : {}),
  });
}

function selectPermissionOperationSamples(
  operations: readonly AutoModePermissionOperation[],
): readonly AutoModePermissionOperation[] {
  if (operations.length <= 8) return operations;
  const risky = operations.filter((operation) => (
    operation.kind === 'delete' || operation.kind === 'move' || operation.kind === 'rename'
    || permissionOperationTargets(operation).some((target) => (
      target.boundary !== 'workspace' && target.boundary !== 'system-temp'
    ))
  ));
  if (risky.length === 0) return [...operations.slice(0, 4), ...operations.slice(-4)];

  const middleStart = Math.max(0, Math.floor(risky.length / 2) - 1);
  const candidates = [
    ...risky.slice(0, 2),
    ...risky.slice(middleStart, middleStart + 2),
    ...risky.slice(-2),
    operations[0]!,
    operations.at(-1)!,
  ];
  return [...new Set(candidates)].slice(0, 8);
}

function buildPermissionActionEvidence(action: string): Readonly<Record<string, string | number>> {
  const sourceBytes = Buffer.byteLength(action, 'utf8');
  const sha256 = createHash('sha256').update(action).digest('hex');
  if (sourceBytes <= MAX_PERMISSION_ACTION_EVIDENCE_BYTES) {
    return { status: 'complete', text: action, sourceBytes, sha256 };
  }

  const head = sliceUtf8(action, 1024, false);
  const tail = sliceUtf8(action, 512, true);
  const includedBytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
  return {
    status: 'targeted',
    text: `${head}\n… omitted …\n${tail}`,
    sourceBytes,
    includedBytes,
    omittedBytes: sourceBytes - includedBytes,
    sha256,
  };
}

function sliceUtf8(value: string, maxBytes: number, fromEnd: boolean): string {
  const characters = Array.from(value);
  const selected: string[] = [];
  let bytes = 0;
  const start = fromEnd ? characters.length - 1 : 0;
  const limit = fromEnd ? -1 : characters.length;
  const step = fromEnd ? -1 : 1;
  for (let index = start; index !== limit; index += step) {
    const character = characters[index];
    if (character === undefined) break;
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    if (fromEnd) selected.unshift(character);
    else selected.push(character);
    bytes += characterBytes;
  }
  return selected.join('');
}

function permissionOperationTargets(
  operation: AutoModePermissionOperation,
): readonly AutoModePermissionTarget[] {
  if ('target' in operation) return [operation.target];
  if ('source' in operation) return [operation.source, operation.destination];
  return [];
}

function compactPermissionOperation(
  operation: AutoModePermissionOperation,
): Readonly<Record<string, unknown>> {
  if ('target' in operation) {
    return {
      kind: operation.kind,
      target: { ...operation.target, path: compactPermissionPath(operation.target.path) },
      ...(operation.options ? { options: operation.options } : {}),
    };
  }
  if ('source' in operation) {
    return {
      kind: operation.kind,
      source: { ...operation.source, path: compactPermissionPath(operation.source.path) },
      destination: {
        ...operation.destination,
        path: compactPermissionPath(operation.destination.path),
      },
      ...(operation.options ? { options: operation.options } : {}),
    };
  }
  return { ...operation, summary: compactPermissionPath(operation.summary) };
}

function compactPermissionPath(value: string): string {
  if (value.length <= 320) return value;
  return `${value.slice(0, 224)}…${value.slice(-95)}`;
}

function fallbackPermissionReview(
  toolName: string,
  action: string,
  risk: string,
): AutoModePermissionReview {
  return {
    schemaVersion: 1,
    analysis: {
      status: 'incomplete', shell: 'tool', binding: 'partial',
      reason: 'deterministic permission facts are unavailable',
    },
    operations: [{
      kind: 'unknown',
      summary: `tool ${toolName}; projection_bytes=${Buffer.byteLength(action, 'utf8')}`,
    }],
    risks: [risk],
  };
}

function permissionReviewFromDeclaredSideEffect(
  toolName: string,
  sideEffect: ToolSideEffect,
  input: Readonly<Record<string, unknown>>,
): AutoModePermissionReview | undefined {
  const contained = sideEffect === 'mutates-state';
  const readOnly = sideEffect === 'readonly' || sideEffect === 'reads-network';
  const paths = declaredToolPaths(input);
  if (sideEffect === 'readonly' && paths.length > 0) {
    return {
      schemaVersion: 1,
      analysis: { status: 'incomplete', shell: 'tool', binding: 'partial' },
      operations: paths.map((targetPath) => ({
        kind: 'read', target: { path: targetPath, boundary: 'unresolved' },
      })),
      risks: ['target_unresolved'],
    };
  }
  if (!contained && !readOnly) return undefined;
  return {
    schemaVersion: 1,
    analysis: { status: 'complete', shell: 'tool', binding: 'exact' },
    operations: [{
      kind: 'execute',
      summary: `${sideEffect} tool ${toolName}`,
      options: contained ? { contained: true } : { readOnly: true },
    }],
    risks: [],
  };
}

const DECLARED_TOOL_PATH_FIELDS = [
  'path', 'file_path', 'filePath', 'target_path', 'targetPath',
  'source_path', 'sourcePath', 'input_path', 'inputPath',
  'cwd', 'directory', 'root', 'worktree_path', 'worktreePath',
] as const;
const DECLARED_TOOL_PATH_ARRAY_FIELDS = [
  'paths', 'file_paths', 'filePaths', 'target_paths', 'targetPaths',
  'input_paths', 'inputPaths',
] as const;

function declaredToolPaths(input: Readonly<Record<string, unknown>>): readonly string[] {
  const paths = DECLARED_TOOL_PATH_FIELDS.flatMap((field) => (
    typeof input[field] === 'string' && input[field].trim() ? [input[field]] : []
  ));
  for (const field of DECLARED_TOOL_PATH_ARRAY_FIELDS) {
    const values = input[field];
    if (Array.isArray(values)) {
      paths.push(...values.filter((value): value is string => (
        typeof value === 'string' && value.trim().length > 0
      )));
    }
  }
  return [...new Set(paths)];
}
