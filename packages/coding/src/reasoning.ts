import { staticText } from './prompts/static-text.js';
import type {
  KodaXExecutionMode,
  KodaXHarnessProfile,
  KodaXMessage,
  KodaXOptions,
  KodaXProviderPolicyHints,
  KodaXRepoRoutingSignals,
  KodaXReasoningMode,
  SessionErrorMetadata,
  KodaXTaskComplexity,
  KodaXTaskRoutingDecision,
  KodaXTaskFamily,
  KodaXTaskActionability,
  KodaXTaskType,
  KodaXTaskWorkIntent,
  KodaXExecutionPattern,
  KodaXMutationSurface,
  KodaXAssuranceIntent,
  KodaXThinkingDepth,
  KodaXWireReasoningEffort,
} from './types.js';
import {
  getDefaultThinkingDepthForMode,
  mapLegacyReasoningModeToEffortIntent,
  KODAX_REASONING_MODE_SEQUENCE,
} from '@kodax-ai/llm';
import type { KodaXBaseProvider } from '@kodax-ai/llm';
import type { AgentReasoningProfile } from '@kodax-ai/agent';
import { looksLikeActionableRuntimeEvidence } from './runtime-evidence.js';
import {
  evaluateProviderPolicy,
  type KodaXProviderPolicyDecision,
} from './provider-policy.js';
import { emitProviderRateLimit } from './agent-runtime/event-emitter.js';

export { KODAX_REASONING_MODE_SEQUENCE };


const FALLBACK_REASONING_MODE: KodaXReasoningMode = 'off';

const FALLBACK_UNKNOWN_CONFIDENCE = 0.4;
const FALLBACK_COMPETING_SIGNAL_CONFIDENCE = 0.42;
const FALLBACK_WEAK_QA_CONFIDENCE = 0.45;
const FALLBACK_CONFIDENCE_BASE = 0.5;
const FALLBACK_CONFIDENCE_PER_SCORE = 0.06;
const FALLBACK_CONFIDENCE_PER_GAP = 0.04;
const FALLBACK_CONFIDENCE_CAP = 0.86;

const LOW_CONFIDENCE_QA_THRESHOLD = 0.75;
const LOW_CONFIDENCE_QA_CAP = 0.49;
const LOW_CONFIDENCE_OFF_THRESHOLD = 0.5;

const THINKING_DEPTH_ORDER: Record<KodaXThinkingDepth, number> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const SOLO_BOUNDARY_DIRECT_THRESHOLD = 0.75;

const UNCERTAINTY_MARKERS = [
  'not enough context',
  'need more context',
  'unclear',
  'cannot determine',
  "can't determine",
  'hard to tell',
  'might be',
  'may be',
  'possibly',
  'perhaps',
];

const LOW_VALUE_REVIEW_MARKERS = [
  'naming',
  'style',
  'readability',
  'nit',
  'minor',
  'consistency',
  'best practice',
  'could rename',
  'optional improvement',
];

const HIGH_IMPACT_MARKERS = [
  'bug',
  'security',
  'regression',
  'crash',
  'data loss',
  'race condition',
  'deadlock',
  'performance issue',
  'memory leak',
  'failure',
];

const BRAINSTORM_KEYWORDS = [
  'brainstorm',
  'explore',
  'explore options',
  'option framing',
  'tradeoff',
  'trade-off',
  'safest way',
  'figure out',
  'design first',
  '方案',
  '思路',
  '先想',
  '先设计',
  '先分析',
  '先讨论',
];

const APPEND_INTENT_KEYWORDS = [
  'continue',
  'extend',
  'build on',
  'follow up',
  'append',
  'add to',
  'based on the existing',
  '接着',
  '继续',
  '补充',
  '追加',
  '延续',
  '扩展现有',
];

const OVERWRITE_INTENT_KEYWORDS = [
  'rewrite',
  'replace',
  'overwrite',
  'from scratch',
  'start over',
  'regenerate',
  'redo',
  '重写',
  '替换',
  '覆盖',
  '推倒重来',
  '全部改掉',
  '重新做',
];

const COMPLEXITY_KEYWORDS: Record<KodaXTaskComplexity, readonly string[]> = {
  simple: [],
  moderate: [
    'screen',
    'component',
    'endpoint',
    'service',
    'feature',
    '模块',
    '功能',
    '页面',
  ],
  complex: [
    'migration',
    'architecture',
    'cross-package',
    'multi-step',
    'pipeline',
    'state machine',
    'refactor',
    'monorepo',
    'across packages',
    'integration',
    '迁移',
    '架构',
    '跨包',
    '重构',
    '流程',
  ],
  systemic: [
    'system-wide',
    'orchestrate',
    'multi-agent',
    'control plane',
    'runtime substrate',
    'whole repo',
    'entire repo',
    'across the monorepo',
    '全仓',
    '全局',
    '整体架构',
    '控制面',
    '多智能体',
  ],
};

const COMPLEXITY_MODERATE_THRESHOLD = 2;
const COMPLEXITY_COMPLEX_THRESHOLD = 4;
const COMPLEXITY_SYSTEMIC_THRESHOLD = 6;

export interface ReasoningPlan {
  /**
   * Canonical per-turn reasoning control. Reasoning single-tracking (Phase B)
   * replaced the V1 `mode` (KodaXReasoningMode) + `depth` (KodaXThinkingDepth)
   * pair with a single `effort`. `'auto'` defers to the provider's
   * capability-aware default; `'none'` disables thinking. Providers resolve
   * the effective effort + any thinking budget from this value via
   * `resolveReasoningEffort` / `normalizeReasoningRequest`.
   */
  effort: KodaXWireReasoningEffort;
  decision: KodaXTaskRoutingDecision;
  promptOverlay: string;
  providerPolicy?: KodaXProviderPolicyDecision;
}

export interface RoutingEvidenceInput {
  recentMessages?: KodaXMessage[];
  sessionErrorMetadata?: SessionErrorMetadata;
  additionalSignals?: string[];
  repoSignals?: KodaXRepoRoutingSignals;
}

const REVIEW_LARGE_FILE_THRESHOLD = 10;
const REVIEW_LARGE_LINE_THRESHOLD = 1200;
const REVIEW_LARGE_MODULE_THRESHOLD = 3;
const REVIEW_MASSIVE_FILE_THRESHOLD = 30;
const REVIEW_MASSIVE_LINE_THRESHOLD = 4000;
const REVIEW_MASSIVE_MODULE_THRESHOLD = 5;

/**
 * Resolve the **L1 user ceiling** for reasoning depth.
 *
 * In FEATURE_078 (v0.7.29) the semantics of `--reasoning <mode>` /
 * `options.reasoningMode` shifted from "all roles use this mode" to
 * "ceiling + bias for default": a hard upper bound on per-role depth
 * with the same value also serving as the suggested default when an
 * Agent declaration has no profile of its own.
 *
 * This function continues to return the user-supplied mode unchanged —
 * what changed is how downstream code consumes it. Direct callers that
 * still treat the return value as the final per-role depth will get
 * pre-FEATURE_078 behaviour (everything pinned to `userCeiling`); they
 * are migrated in this same patch to call `resolveRoleReasoning(...)`
 * instead, which honours the L1-L4 chain.
 */
export function resolveReasoningMode(options: KodaXOptions): KodaXReasoningMode {
  if (options.reasoningMode) {
    return options.reasoningMode;
  }

  if (options.thinking === true) {
    return 'auto';
  }

  if (options.thinking === false) {
    return 'off';
  }

  return FALLBACK_REASONING_MODE;
}

export function reasoningModeToDepth(
  mode: KodaXReasoningMode,
): KodaXThinkingDepth {
  return getDefaultThinkingDepthForMode(mode);
}

// ---------------------------------------------------------------------------
// Role-Aware Reasoning Profiles (FEATURE_078, effort-native)
// ---------------------------------------------------------------------------

const EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 0,
  auto: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

function effortRank(effort: KodaXWireReasoningEffort): number {
  return EFFORT_RANK[effort] ?? EFFORT_RANK.medium;
}

/**
 * Compare two efforts by depth on the canonical ladder. Returns -1, 0, or 1
 * mirroring `Array.prototype.sort`'s comparator contract: lower-rank efforts
 * (`none`) come first, higher-rank (`max`) last. `auto` ranks just above the
 * disabled floor — it means "let the provider pick", always >= no thinking.
 * Unknown custom efforts rank as `medium`.
 */
export function compareEfforts(
  a: KodaXWireReasoningEffort,
  b: KodaXWireReasoningEffort,
): -1 | 0 | 1 {
  const rankA = effortRank(a);
  const rankB = effortRank(b);
  if (rankA < rankB) return -1;
  if (rankA > rankB) return 1;
  return 0;
}

/**
 * Clamp `effort` to be no deeper than `ceiling`. When `effort` is already at
 * or below the ceiling, it passes through unchanged.
 */
export function clampEffort(
  effort: KodaXWireReasoningEffort,
  ceiling: KodaXWireReasoningEffort,
): KodaXWireReasoningEffort {
  return compareEfforts(effort, ceiling) > 0 ? ceiling : effort;
}

/**
 * Resolve the effective per-role reasoning **effort** through the FEATURE_078
 * decision chain (effort-native single-track form):
 *
 *   L1 (`userCeiling`)              — caller-supplied upper bound + bias
 *   L2 (`profile.default` / `.max`) — Agent declaration's role default
 *
 * The chain takes the agent declaration's default as the base, clamps it to
 * the declaration's `max`, then clamps to the user ceiling as the absolute
 * hard cap. The Agent profile is still expressed in legacy reasoning modes
 * (`AgentReasoningProfile`), so its `default`/`max` are mapped onto the effort
 * ladder. `none` is a hard kill switch. When `profile` is undefined, this
 * collapses to `userCeiling` — exactly the pre-FEATURE_078 behaviour.
 *
 * (FEATURE_193 retired the Scout hint (L3) and the per-role split — the Worker
 * is the sole agent, so the `role` parameter is gone.)
 */
export function resolveRoleEffort(
  userCeiling: KodaXWireReasoningEffort,
  profile?: AgentReasoningProfile,
): KodaXWireReasoningEffort {
  // Kill switch: `effort none` can never be re-enabled by a role default.
  if (userCeiling === 'none') return 'none';
  if (!profile) return userCeiling;

  const base: KodaXWireReasoningEffort = profile.default
    ? mapLegacyReasoningModeToEffortIntent(profile.default)
    : userCeiling;
  const clampedToProfileMax = profile.max
    ? clampEffort(base, mapLegacyReasoningModeToEffortIntent(profile.max))
    : base;
  return clampEffort(clampedToProfileMax, userCeiling);
}

// ---------------------------------------------------------------------------
// FEATURE_103 (v0.7.29): L5 user-followup escalate
//
// Fifth tier of the FEATURE_078 chain. L4 (`escalateThinkingDepth(_, ceiling)`)
// catches *system*-detected dissatisfaction (Evaluator returned `revise`).
// L5 catches *user*-detected dissatisfaction (the user came back with a
// follow-up containing doubt or deepen markers). Both bump depth one
// rank; both are clamped by the absolute ceiling.
//
// Triggers (single bump):
//   - Doubt category: prior assistant turn in session AND prompt contains
//     a doubt marker (`不对` / `错了` / `wrong` / `are you sure`, etc.).
//     The prior-turn requirement avoids false positives on first-round
//     prompts that happen to contain the word "wrong" out of context.
//   - Deepen category: prompt contains a deepen marker (`仔细` / `深入` /
//     `think harder`, etc.). Fires regardless of round — the user is
//     explicitly asking for more depth.
//
// L5 respects the L1 hard cap: `off` stays `off` (kill switch is sacrosanct),
// and a bumped value never exceeds `deep`. L5 is purely additive — it never
// lowers depth and never overrides L4.
// ---------------------------------------------------------------------------

/**
 * Doubt markers — short Chinese + English phrases that indicate the user
 * is pushing back on or questioning a prior answer. Matched substring-wise
 * against the user's latest prompt. Conservative dictionary: every entry
 * is unambiguous in context (no `not` or `wrong` standalone — those would
 * false-positive on quoted text or codenames).
 */
const FOLLOWUP_DOUBT_MARKERS: readonly string[] = Object.freeze([
  // Chinese
  '不对',
  '错了',
  '有问题',
  '真的吗',
  '你确定',
  '不是这样',
  '弄错了',
  '搞错了',
  '搞反了',
  '这不对',
  '不正确',
  '答错',
  '回答错',
  // English
  "that's wrong",
  'that is wrong',
  "that's not right",
  'that is not right',
  'are you sure',
  'not really',
  'this is wrong',
  'this is incorrect',
  "that's incorrect",
  'that is incorrect',
  "you're wrong",
  'you are wrong',
]);

/**
 * Deepen markers — phrases that explicitly request more thinking depth,
 * round-independent. A user starting a fresh task with `仔细分析...` is
 * still requesting depth.
 */
const FOLLOWUP_DEEPEN_MARKERS: readonly string[] = Object.freeze([
  // Chinese
  '仔细',
  '深入',
  '认真',
  '再看看',
  '再想想',
  '想清楚',
  '用心',
  '深度分析',
  '仔细分析',
  '认真分析',
  '彻底',
  // English
  'think harder',
  'think more carefully',
  'look more carefully',
  'dig deeper',
  'be thorough',
  'more careful',
  'more carefully',
  'reconsider',
  'reexamine',
  're-examine',
]);

export type FollowupSignalCategory = 'doubt' | 'deepen' | null;

export interface FollowupSignal {
  /** Which marker category fired, or null when no escalation should happen. */
  readonly category: FollowupSignalCategory;
  /** The literal marker substring that matched, for telemetry / logs. */
  readonly matched: string | null;
}

/**
 * Detect L5 follow-up signal in a user prompt. Doubt markers require
 * `hasPriorAssistantTurn` to be true (otherwise return null even if a
 * doubt marker is present — first-turn doubt-like text is too noisy);
 * deepen markers fire unconditionally.
 *
 * Match is case-insensitive substring against both the original text and
 * its lower-cased form (CJK chars unchanged by .toLowerCase, ASCII gets
 * folded so 'Are You Sure' matches 'are you sure').
 */
export function detectFollowupSignal(
  text: string,
  hasPriorAssistantTurn: boolean,
): FollowupSignal {
  if (!text) return { category: null, matched: null };
  const lowered = text.toLowerCase();

  if (hasPriorAssistantTurn) {
    for (const marker of FOLLOWUP_DOUBT_MARKERS) {
      const lower = marker.toLowerCase();
      if (lowered.includes(lower) || text.includes(marker)) {
        return { category: 'doubt', matched: marker };
      }
    }
  }

  for (const marker of FOLLOWUP_DEEPEN_MARKERS) {
    const lower = marker.toLowerCase();
    if (lowered.includes(lower) || text.includes(marker)) {
      return { category: 'deepen', matched: marker };
    }
  }

  return { category: null, matched: null };
}

/**
 * Single-rank bump for L5 escalation, on the canonical effort ladder. `none`
 * is sacrosanct (kill switch dominates user pushback — if the user explicitly
 * disabled thinking, even doubt markers cannot re-enable it). `minimal` is
 * likewise a disable-ish floor and never bumps. `auto` enters the ladder at
 * `low`; concrete efforts step up one rank but never past `high` — preserving
 * the pre-effort behaviour where the deepest legacy mode (`deep`→`high`) did
 * not escalate further. Efforts already at/above `high` (`xhigh`/`max`) stay.
 *
 * Ladder: none/minimal (no bump) | auto → low → medium → high (no bump).
 */
export function escalateEffort(
  effort: KodaXWireReasoningEffort,
): KodaXWireReasoningEffort {
  switch (effort) {
    case 'auto':
      return 'low';
    case 'low':
      return 'medium';
    case 'medium':
      return 'high';
    default:
      // none / minimal (disabled floor) and high / xhigh / max (already deep):
      // no bump, matching the legacy `off`-stays-`off` + `deep`-stays-`deep`.
      return effort;
  }
}

export interface FollowupEscalation {
  /** The effort effective for this round (post-L5 bump if applicable). */
  readonly effective: KodaXWireReasoningEffort;
  /** True iff `effective !== input effort`. */
  readonly escalated: boolean;
  /** Detected signal that triggered escalation, if any. */
  readonly signal: FollowupSignal;
}

/**
 * Apply L5 escalation to a user effort. Returns the effort unchanged
 * (with `escalated: false`) when no signal fires or when bumping would
 * be a no-op (`none`/`minimal` stay; `high`/`xhigh`/`max` stay).
 *
 * Pure function — does not mutate inputs. Callers compute this ONCE per
 * `runKodaX` / `runManagedTaskViaRunner` invocation at the entry point,
 * then thread the resulting `effective` value through `options.effort`.
 * Per-iteration sites in the runner loop see the already-bumped value.
 */
export function applyFollowupEscalation(
  effort: KodaXWireReasoningEffort,
  prompt: string,
  hasPriorAssistantTurn: boolean,
): FollowupEscalation {
  const signal = detectFollowupSignal(prompt, hasPriorAssistantTurn);
  if (signal.category === null) {
    return { effective: effort, escalated: false, signal };
  }
  const bumped = escalateEffort(effort);
  if (bumped === effort) {
    return { effective: effort, escalated: false, signal };
  }
  return { effective: bumped, escalated: true, signal };
}

/**
 * Convenience wrapper: read the effective effort from `options`, count prior
 * assistant turns from `options.session?.initialMessages`, apply L5, return
 * both the escalation result and a fresh `KodaXOptions` with `effort` updated
 * to the bumped value (when bumped).
 *
 * Returns the input options reference unchanged when no escalation fires
 * — callers can rely on `options === result.options` to skip downstream
 * re-resolution if they care.
 */
export function applyFollowupEscalationToOptions<T extends KodaXOptions>(
  options: T,
  prompt: string,
): { options: T; escalation: FollowupEscalation } {
  const effort = options.effort ?? mapLegacyReasoningModeToEffortIntent(resolveReasoningMode(options));
  const initialMessages = options.session?.initialMessages ?? [];
  const hasPriorAssistantTurn = initialMessages.some((m) => m?.role === 'assistant');
  const escalation = applyFollowupEscalation(effort, prompt, hasPriorAssistantTurn);
  if (!escalation.escalated) {
    return { options, escalation };
  }
  return {
    options: { ...options, effort: escalation.effective } as T,
    escalation,
  };
}

const TASK_TYPE_KEYWORDS: Record<
  Exclude<KodaXTaskType, 'unknown'>,
  readonly string[]
> = {
  conversation: [
    'hello',
    'hi',
    'hey',
    '你好',
    '嗨',
    '早上好',
    '下午好',
    '晚上好',
  ],
  lookup: [
    'where is',
    'which file',
    'what file',
    'where does',
    'where do',
    'located',
    'defined',
    '在哪个文件',
    '在哪',
    '在哪里',
    '哪个文件',
    '哪个函数',
    '哪里定义',
    '文件位置',
    '在哪管理',
  ],
  review: [
    'review',
    'code review',
    'pull request',
    'merge blocker',
    'diff',
    'changed files',
    '\u5ba1\u67e5',
    '\u4ee3\u7801\u5ba1\u67e5',
    'review \u4e00\u4e0b',
    '\u770b\u4e0b\u6539\u52a8',
    '\u8bc4\u5ba1',
    'pr',
  ],
  bugfix: [
    'bug',
    'error',
    'exception',
    'failing',
    'fix',
    'failure',
    'traceback',
    'stack trace',
    'runtime error',
    '\u62a5\u9519',
    '\u9519\u8bef',
    '\u5f02\u5e38',
    '\u4fee\u590d',
    '\u5931\u8d25',
    '\u6392\u67e5',
  ],
  edit: [
    'implement',
    'add ',
    'change ',
    'modify ',
    'update ',
    'create ',
    'write ',
    '\u5b9e\u73b0',
    '\u65b0\u589e',
    '\u4fee\u6539',
    '\u6539\u4e00\u4e0b',
    '\u521b\u5efa',
    '\u5199\u4e00\u4e2a',
  ],
  refactor: [
    'refactor',
    'cleanup',
    'restructure',
    'simplify',
    'decouple',
    'rename',
    '\u91cd\u6784',
    '\u6e05\u7406',
    '\u4f18\u5316',
    '\u7b80\u5316',
    '\u89e3\u8026',
    '\u6574\u7406',
  ],
  plan: [
    'plan',
    'design',
    'architecture',
    'migration',
    'strategy',
    'roadmap',
    '\u8ba1\u5212',
    '\u8bbe\u8ba1',
    '\u67b6\u6784',
    '\u65b9\u6848',
    '\u7b56\u7565',
    '\u8def\u7ebf\u56fe',
  ],
  qa: [
    'explain',
    'what is',
    'how does',
    'help me understand',
    '\u89e3\u91ca',
    '\u4e3a\u4ec0\u4e48',
    '\u662f\u4ec0\u4e48',
    '\u600e\u4e48\u7406\u89e3',
    '\u4ec0\u4e48\u610f\u601d',
    '\u8bf4\u660e',
  ],
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasAsciiWordBoundaries(keyword: string): boolean {
  return /^[a-z0-9][a-z0-9 _-]*$/i.test(keyword);
}

function textHasKeyword(text: string, keyword: string): boolean {
  if (!keyword) {
    return false;
  }

  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) {
    return false;
  }

  if (!hasAsciiWordBoundaries(normalizedKeyword)) {
    return text.includes(keyword);
  }

  const pattern = new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(normalizedKeyword)}([^a-z0-9]|$)`,
    'i',
  );
  return pattern.test(text);
}

function scoreTaskTypeKeywords(text: string, keywords: readonly string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword) {
      continue;
    }

    if (textHasKeyword(text, keyword)) {
      score += keyword.length >= 6 || /[^\u0000-\u007f]/.test(keyword) ? 2 : 1;
    }
  }
  return score;
}

export interface KodaXIntentGateDecision {
  primaryTask: KodaXTaskType;
  taskFamily: KodaXTaskFamily;
  actionability: KodaXTaskActionability;
  executionPattern: KodaXExecutionPattern;
  shouldUseRepoSignals: boolean;
  requiresRoutingHeuristics: boolean;
  reason: string;
}

const GREETING_ONLY_PATTERN = /^(?:\s|[!,.?，。！？])*?(?:hi|hello|hey|yo|你好|嗨|哈喽|早上好|下午好|晚上好)(?:\s|[!,.?，。！？])*$/i;
const LOOKUP_PATTERN = /\b(where is|which file|what file|where does|where do|defined in|located in|file manages|manages this|which component|which function)\b/i;
const LOOKUP_PATTERN_ZH = /在哪个文件|在哪管理|在哪里定义|哪个文件|哪个函数|哪个组件|文件位置|在哪\b|在哪里\b/;
const REVIEW_PATTERN = /\b(review|code review|audit|pr|pull request|merge blocker|look at the changes|changed files)\b/i;
const REVIEW_PATTERN_ZH = /审查|评审|review一下|看下改动|代码改动/;
const PLAN_PATTERN = /\b(plan|design|architecture|proposal|strategy|roadmap)\b/i;
const PLAN_PATTERN_ZH = /计划|设计|架构|方案|策略|路线图/;
const INVESTIGATION_PATTERN = /\b(debug|investigate|root cause|why is|why does|failing|failure|runtime error|stack trace|traceback)\b/i;
const INVESTIGATION_PATTERN_ZH = /排查|定位问题|根因|为什么|报错|错误|异常|失败/;
const IMPLEMENTATION_PATTERN = /\b(implement|add|change|modify|update|create|write|fix|refactor|rewrite|replace)\b/i;
const IMPLEMENTATION_PATTERN_ZH = /实现|新增|修改|创建|写一个|修复|重构|改一下|替换/;

const DOCS_ONLY_PATTERN = /\b(docs?|documentation|readme|changelog|release notes?|spec|proposal|design doc|requirements?|prd|adr|hld|dd|guide|runbook|playbook|feature list|known issues?)\b/i;
const DOCS_ONLY_PATTERN_ZH = /\u6587\u6863|\u8bf4\u660e\u6587\u6863|\u8bbe\u8ba1\u6587\u6863|\u9700\u6c42\u6587\u6863|PRD|ADR|HLD|DD|CHANGELOG|README|\u529f\u80fd\u6e05\u5355|\u5df2\u77e5\u95ee\u9898/u;
const DOCS_QUALIFIED_TECHNICAL_TARGET_PATTERN = /\b(?:api|backend|frontend|service|module|endpoint|component|architecture|package|migration|schema|database|auth|sdk|cli)\s+(?:docs?|documentation|guide|readme|changelog|spec|proposal|design doc|requirements?|prd|adr|hld|dd|runbook|playbook)\b|\b(?:docs?|documentation|guide|readme|changelog|spec|proposal|design doc|requirements?|prd|adr|hld|dd|runbook|playbook)\s+(?:for|about|on)\s+(?:the\s+)?(?:api|backend|frontend|service|module|endpoint|component|architecture|package|migration|schema|database|auth|sdk|cli)\b/i;
const DOCS_QUALIFIED_TECHNICAL_TARGET_PATTERN_ZH = /(?:API|\u540e\u7aef|\u524d\u7aef|\u670d\u52a1|\u6a21\u5757|\u63a5\u53e3|\u7ec4\u4ef6|\u67b6\u6784|\u5305|\u8fc1\u79fb|\u6570\u636e\u5e93|\u8ba4\u8bc1)(?:[\u4e00-\u9fffA-Za-z0-9_\-\/\\.\s]{0,8})(?:\u6587\u6863|\u8bf4\u660e\u6587\u6863|README|CHANGELOG|PRD|ADR|HLD|DD|\u6307\u5357)/u;
const EXPLICIT_CODE_MUTATION_ANCHOR_PATTERN = /\b(?:implementation|source code|code comments?|function|class|component|bug|script|tests?|ui)\b/i;
const EXPLICIT_CODE_MUTATION_ANCHOR_PATTERN_ZH = /\u4ee3\u7801\u6ce8\u91ca|\u5b9e\u73b0|\u51fd\u6570|\u7c7b|\u7ec4\u4ef6|bug|\u811a\u672c|\u6d4b\u8bd5|\u754c\u9762/u;
const NO_CODE_CHANGE_PATTERN = /\b(?:do not|don't|dont|without|no)\b[\s\S]{0,12}\b(?:change|modify|edit|touch|rewrite|update|mutate)\b[\s\S]{0,8}\bcode\b|\bno code changes?\b/i;
const NO_CODE_CHANGE_PATTERN_ZH = /\u4e0d\u6539\u4ee3\u7801|\u4e0d\u8981\u6539\u4ee3\u7801|\u4e0d\u4fee\u6539\u4ee3\u7801|\u4e0d\u8981\u4fee\u6539\u4ee3\u7801|\u53ea\u6539\u6587\u6863|\u53ea\u66f4\u65b0\u6587\u6863|\u4ec5\u6539\u6587\u6863|\u4ec5\u66f4\u65b0\u6587\u6863/u;
const EXPLICIT_ASSURANCE_PATTERN = /\b(double[- ]check|re-check|recheck|second pass|second opinion|cross-check|cross check|independently verify|independent review|independent audit|strict audit|extra scrutiny|verify twice)\b/i;
const EXPLICIT_ASSURANCE_PATTERN_ZH = /\u518d\u68c0\u67e5|\u518d\u5ba1\u67e5|\u53cc\u91cd\u68c0\u67e5|\u7b2c\u4e8c\u904d|\u7b2c\u4e8c\u8f6e|\u4e8c\u6b21\u5ba1\u67e5|\u4ea4\u53c9\u68c0\u67e5|\u72ec\u7acb\u9a8c\u8bc1|\u72ec\u7acb\u5ba1\u67e5|\u66f4\u5f3a\u5ba1\u67e5/u;
const CODE_MUTATION_OBJECT_PATTERN = /\b(code|implementation|function|class|component|module|endpoint|service|repo|repository|file|files|test|bug|feature|script|api|ui|backend|frontend)\b/i;
const CODE_MUTATION_OBJECT_PATTERN_ZH = /\u4ee3\u7801|\u5b9e\u73b0|\u51fd\u6570|\u7c7b|\u7ec4\u4ef6|\u6a21\u5757|\u63a5\u53e3|\u670d\u52a1|\u4ed3\u5e93|\u6587\u4ef6|\u6d4b\u8bd5|bug|\u529f\u80fd|\u811a\u672c|API|\u754c\u9762|\u540e\u7aef|\u524d\u7aef/u;
const SYSTEM_MUTATION_PATTERN = /\b(deploy|deployment|restart|reboot|migrate database|run migration|seed database|provision|install dependency|install package|upgrade dependency|kill process|start server|stop server|apply terraform)\b/i;
const SYSTEM_MUTATION_PATTERN_ZH = /\u90e8\u7f72|\u91cd\u542f|\u91cd\u542f\u670d\u52a1|\u8fd0\u884c\u8fc1\u79fb|\u8fc1\u79fb\u6570\u636e\u5e93|\u521d\u59cb\u5316\u6570\u636e\u5e93|\u5b89\u88c5\u4f9d\u8d56|\u5347\u7ea7\u4f9d\u8d56|\u6740\u8fdb\u7a0b|\u542f\u52a8\u670d\u52a1|\u505c\u6b62\u670d\u52a1|\u5e94\u7528terraform/u;

const GREETING_ONLY_PATTERN_ZH_CLEAN = /^(?:\s|[!,.?，。！]*)?(?:你好|哈喽|早上好|下午好|晚上好)(?:\s|[!,.?，。！]*)*$/u;
const LOOKUP_PATTERN_ZH_CLEAN = /在哪个文件|哪个文件|在哪定义|定义在|哪个函数|哪个组件|文件位置|在哪里/u;
const REVIEW_PATTERN_ZH_CLEAN = /审查|评审|review一下|看下改动|代码改动|审阅/u;
const PLAN_PATTERN_ZH_CLEAN = /计划|设计|架构|方案|策略|路线图/u;
const INVESTIGATION_PATTERN_ZH_CLEAN = /排查|定位问题|根因|为什么|报错|错误|异常|失败/u;
const IMPLEMENTATION_PATTERN_ZH_CLEAN = /实现|新增|修改|创建|写一个|修复|重构|改一下|替换/u;
const DOCS_ONLY_PATTERN_ZH_CLEAN = /文档|说明文档|设计文档|需求文档|PRD|ADR|HLD|DD|CHANGELOG|README|功能清单|已知问题/u;
const EXPLICIT_ASSURANCE_PATTERN_ZH_CLEAN = /再检查|再审查|双重检查|第二遍|第二轮|二次审查|交叉检查|独立验证|独立审查|更强审查/u;
const CODE_MUTATION_OBJECT_PATTERN_ZH_CLEAN = /代码|实现|函数|类|组件|模块|接口|服务|仓库|文件|测试|bug|功能|脚本|API|界面|后端|前端/u;
const SYSTEM_MUTATION_PATTERN_ZH_CLEAN = /部署|重启|重启服务|迁移数据库|运行迁移|初始化数据库|安装依赖|升级依赖|杀进程|启动服务|停止服务|应用terraform/u;
const CODE_MUTATION_TARGET_PATTERN_ZH_CLEAN = /代码|实现|函数|类|组件|模块|接口|bug|功能|前端|后端|脚本/u;
const CODE_MUTATION_VERB_PATTERN_ZH_CLEAN = /实现|新增|修改|更新|创建|编写|修复|重构|补丁|重写|替换|编辑|重命名/u;

function isGreetingOnlyPrompt(text: string): boolean {
  return GREETING_ONLY_PATTERN.test(text) || GREETING_ONLY_PATTERN_ZH_CLEAN.test(text);
}

export function inferIntentGate(prompt: string): KodaXIntentGateDecision {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return {
      primaryTask: 'conversation',
      taskFamily: 'conversation',
      actionability: 'non_actionable',
      executionPattern: 'direct',
      shouldUseRepoSignals: false,
      requiresRoutingHeuristics: false,
      reason: 'Empty input is treated as non-actionable conversation.',
    };
  }

  if (isGreetingOnlyPrompt(trimmed)) {
    return {
      primaryTask: 'conversation',
      taskFamily: 'conversation',
      actionability: 'non_actionable',
      executionPattern: 'direct',
      shouldUseRepoSignals: false,
      requiresRoutingHeuristics: false,
      reason: 'Pure greeting input should stay conversational and must not be escalated by repository state.',
    };
  }

  const hasLookupSignal = LOOKUP_PATTERN.test(trimmed) || LOOKUP_PATTERN_ZH_CLEAN.test(trimmed);
  const hasReviewSignal = REVIEW_PATTERN.test(trimmed) || REVIEW_PATTERN_ZH_CLEAN.test(trimmed);
  const hasPlanSignal = PLAN_PATTERN.test(trimmed) || PLAN_PATTERN_ZH_CLEAN.test(trimmed);
  const hasInvestigationSignal = INVESTIGATION_PATTERN.test(trimmed) || INVESTIGATION_PATTERN_ZH_CLEAN.test(trimmed);
  const hasImplementationSignal = IMPLEMENTATION_PATTERN.test(trimmed) || IMPLEMENTATION_PATTERN_ZH_CLEAN.test(trimmed);

  // Heuristic intent gate. FEATURE_193 (v0.7.43) retired both the LLM task
  // router and the Scout calibration round; the harness-LLM-judgment refactor
  // then removed the per-harness prompt overlay for the Worker. Actionable
  // requests run the keyword routing heuristic below; empty input and greetings
  // short-circuit as non-actionable (direct H0).

  if (hasReviewSignal) {
    return {
      primaryTask: 'review',
      taskFamily: 'review',
      actionability: 'actionable',
      executionPattern: 'checked-direct',
      shouldUseRepoSignals: true,
      requiresRoutingHeuristics: true,
      reason: 'Review work is actionable and benefits from harness assessment for accurate scoping.',
    };
  }

  if (hasPlanSignal) {
    return {
      primaryTask: 'plan',
      taskFamily: 'planning',
      actionability: 'actionable',
      executionPattern: 'coordinated',
      shouldUseRepoSignals: true,
      requiresRoutingHeuristics: true,
      reason: 'Planning and design requests may benefit from coordinated execution.',
    };
  }

  if (hasInvestigationSignal) {
    return {
      primaryTask: 'bugfix',
      taskFamily: 'investigation',
      actionability: 'actionable',
      executionPattern: 'checked-direct',
      shouldUseRepoSignals: true,
      requiresRoutingHeuristics: true,
      reason: 'Debugging and root-cause work starts as investigation.',
    };
  }

  if (hasImplementationSignal) {
    return {
      primaryTask: 'edit',
      taskFamily: 'implementation',
      actionability: 'actionable',
      executionPattern: 'checked-direct',
      shouldUseRepoSignals: true,
      requiresRoutingHeuristics: true,
      reason: 'Implementation and editing work is actionable and may later escalate if the evidence warrants it.',
    };
  }

  if (hasLookupSignal) {
    return {
      primaryTask: 'lookup',
      taskFamily: 'lookup',
      actionability: 'actionable',
      executionPattern: 'direct',
      shouldUseRepoSignals: false,
      requiresRoutingHeuristics: true,
      reason: 'Lookup queries are actionable but lightweight — direct execution unless deeper analysis is requested.',
    };
  }

  return {
    primaryTask: 'unknown',
    taskFamily: 'ambiguous',
    actionability: 'ambiguous',
    executionPattern: 'direct',
    shouldUseRepoSignals: false,
    requiresRoutingHeuristics: true,
    reason: 'Ambiguous requests need classification before the work approach is locked in.',
  };
}

function inferTaskFamilyFromPrimaryTask(primaryTask: KodaXTaskType): KodaXTaskFamily {
  switch (primaryTask) {
    case 'conversation':
      return 'conversation';
    case 'lookup':
    case 'qa':
      return 'lookup';
    case 'review':
      return 'review';
    case 'bugfix':
      return 'investigation';
    case 'plan':
      return 'planning';
    case 'edit':
    case 'refactor':
      return 'implementation';
    case 'unknown':
    default:
      return 'ambiguous';
  }
}

function defaultExecutionPatternForFamily(taskFamily: KodaXTaskFamily): KodaXExecutionPattern {
  switch (taskFamily) {
    case 'conversation':
    case 'lookup':
      return 'direct';
    case 'review':
    case 'investigation':
      return 'checked-direct';
    case 'planning':
    case 'implementation':
      return 'coordinated';
    case 'ambiguous':
    default:
      return 'direct';
  }
}

function deriveIntentFields(
  prompt: string,
  decision: Pick<KodaXTaskRoutingDecision, 'primaryTask' | 'taskFamily' | 'actionability' | 'executionPattern'>,
): Pick<KodaXTaskRoutingDecision, 'taskFamily' | 'actionability' | 'executionPattern'> {
  const gate = inferIntentGate(prompt);
  const taskFamily = decision.taskFamily ?? inferTaskFamilyFromPrimaryTask(decision.primaryTask);
  const actionability = decision.actionability
    ?? (taskFamily === 'conversation' ? 'non_actionable' : taskFamily === 'ambiguous' ? gate.actionability : 'actionable');
  const executionPattern = decision.executionPattern ?? defaultExecutionPatternForFamily(taskFamily);
  return {
    taskFamily,
    actionability,
    executionPattern,
  };
}

function deriveMutationSurface(
  prompt: string,
  decision: Pick<KodaXTaskRoutingDecision, 'primaryTask' | 'taskFamily'>,
): KodaXMutationSurface {
  const normalized = ` ${prompt.toLowerCase()} `;
  const hasCjk = /[\u3400-\u9fff]/u.test(prompt);
  const hasDocsSignal = DOCS_ONLY_PATTERN.test(prompt) || (hasCjk && DOCS_ONLY_PATTERN_ZH_CLEAN.test(prompt));
  const hasDocQualifiedTechnicalTarget = DOCS_QUALIFIED_TECHNICAL_TARGET_PATTERN.test(prompt)
    || (hasCjk && DOCS_QUALIFIED_TECHNICAL_TARGET_PATTERN_ZH.test(prompt));
  const hasExplicitCodeMutationAnchor = EXPLICIT_CODE_MUTATION_ANCHOR_PATTERN.test(prompt)
    || (hasCjk && EXPLICIT_CODE_MUTATION_ANCHOR_PATTERN_ZH.test(prompt));
  const hasNoCodeGuard = NO_CODE_CHANGE_PATTERN.test(prompt) || (hasCjk && NO_CODE_CHANGE_PATTERN_ZH.test(prompt));
  const hasSystemSignal = SYSTEM_MUTATION_PATTERN.test(prompt) || (hasCjk && SYSTEM_MUTATION_PATTERN_ZH_CLEAN.test(prompt));
  const hasCodeObjectSignal = CODE_MUTATION_OBJECT_PATTERN.test(normalized) || (hasCjk && CODE_MUTATION_OBJECT_PATTERN_ZH_CLEAN.test(prompt));
  const hasStrongCodeTarget = /\b(code|implementation|function|class|component|module|endpoint|service|bug|script|api|ui|backend|frontend)\b/i.test(normalized)
    || (hasCjk && CODE_MUTATION_OBJECT_PATTERN_ZH_CLEAN.test(prompt));
  const hasMutationVerb = /\b(implement|add|modify|update|create|write|fix|refactor|rewrite|replace|edit|patch|rename)\b/i.test(normalized)
    || (hasCjk && CODE_MUTATION_VERB_PATTERN_ZH_CLEAN.test(prompt));
  const hasStrongCodeTargetByChinese = hasCjk && CODE_MUTATION_TARGET_PATTERN_ZH_CLEAN.test(prompt);
  const hasMutationVerbByChinese = hasCjk && CODE_MUTATION_VERB_PATTERN_ZH_CLEAN.test(prompt);
  const hasStructuralRepoTarget = /\b(monorepo|repo|repository|package|packages|architecture|migration)\b/i.test(normalized);
  const hasStructuralMutationVerb = /\b(refactor|rewrite|reorganize|migrate|split|merge|consolidate|rename)\b/i.test(normalized);
  const safeHasStrongCodeTarget = /\b(code|implementation|function|class|component|module|endpoint|service|bug|script|api|ui|backend|frontend)\b/i.test(normalized)
    || hasStrongCodeTargetByChinese;
  const safeHasMutationVerb = /\b(implement|add|modify|update|create|write|fix|refactor|rewrite|replace|edit|patch|rename)\b/i.test(normalized)
    || hasMutationVerbByChinese;
  const effectiveStrongCodeTarget = (safeHasStrongCodeTarget && !hasDocQualifiedTechnicalTarget)
    || hasExplicitCodeMutationAnchor;
  const effectiveStructuralRepoTarget = hasStructuralRepoTarget && !hasDocQualifiedTechnicalTarget;
  const explicitDocsOnlyGuard = hasDocsSignal && !hasSystemSignal && hasNoCodeGuard;

  if (decision.primaryTask === 'review' && !safeHasMutationVerb && !hasSystemSignal) {
    return hasDocsSignal && (explicitDocsOnlyGuard || !effectiveStrongCodeTarget)
      ? 'docs-only'
      : 'read-only';
  }

  const likelyCodeMutation = decision.primaryTask === 'edit'
    || decision.primaryTask === 'refactor'
    || decision.taskFamily === 'implementation'
    || (decision.primaryTask === 'bugfix' && safeHasMutationVerb)
    || (safeHasMutationVerb && effectiveStrongCodeTarget)
    || (hasStructuralMutationVerb && effectiveStructuralRepoTarget);

  if (explicitDocsOnlyGuard && decision.primaryTask !== 'refactor') {
    return 'docs-only';
  }

  if (hasDocsSignal && !hasSystemSignal && !effectiveStrongCodeTarget && decision.primaryTask !== 'refactor') {
    return 'docs-only';
  }

  if (hasSystemSignal) {
    return 'system';
  }

  if (likelyCodeMutation) {
    return 'code';
  }

  return 'read-only';
}

function deriveAssuranceIntent(
  prompt: string,
  decision: Pick<KodaXTaskRoutingDecision, 'recommendedMode'>,
): KodaXAssuranceIntent {
  const hasCjk = /[\u3400-\u9fff]/u.test(prompt);
  if (
    EXPLICIT_ASSURANCE_PATTERN.test(prompt)
    || (hasCjk && EXPLICIT_ASSURANCE_PATTERN_ZH_CLEAN.test(prompt))
    || decision.recommendedMode === 'strict-audit'
  ) {
    return 'explicit-check';
  }
  return 'default';
}

// `deriveTopologyCeiling` (FEATURE_112 read-only/docs → H1, code/system → H2)
// was removed in ADR-043: the harness tier collapsed to the single H0_DIRECT
// tier, so the ceiling is a constant. The assurance signal it keyed on stays
// queryable on the decision (mutationSurface / assuranceIntent / complexity /
// needsIndependentQA).

function inferTaskSignal(prompt: string): {
  task: KodaXTaskType;
  confidence: number;
  reason: string;
} {
  const normalized = ` ${prompt.toLowerCase()} `;
  const scores = Object.entries(TASK_TYPE_KEYWORDS).map(([task, keywords]) => ({
    task: task as Exclude<KodaXTaskType, 'unknown'>,
    score: scoreTaskTypeKeywords(normalized, keywords),
  }));
  const ranked = [...scores].sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const runnerUp = ranked[1];

  if (!top || top.score === 0) {
    return {
      task: 'unknown',
      confidence: FALLBACK_UNKNOWN_CONFIDENCE,
      reason: 'Fallback task inference did not find enough strong signals, so it kept the task as unknown.',
    };
  }

  if (runnerUp && top.score === runnerUp.score) {
    const preferredTiedTask = resolveTiedTask(prompt, top.task, runnerUp.task);
    if (preferredTiedTask) {
      return {
        task: preferredTiedTask,
        confidence: FALLBACK_CONFIDENCE_BASE,
        reason: `Fallback task inference preferred "${preferredTiedTask}" because the request used an explicit directive even though multiple task signals were present.`,
      };
    }

    return {
      task: 'unknown',
      confidence: FALLBACK_COMPETING_SIGNAL_CONFIDENCE,
      reason: `Fallback task inference saw competing signals for "${top.task}" and "${runnerUp.task}", so it kept the task as unknown.`,
    };
  }

  if (top.task === 'qa' && top.score < 4) {
    return {
      task: 'unknown',
      confidence: FALLBACK_WEAK_QA_CONFIDENCE,
      reason: 'Fallback task inference saw a weak explanation-style signal, but not enough evidence to disable reasoning.',
    };
  }

  const confidence = Math.min(
    FALLBACK_CONFIDENCE_CAP,
    FALLBACK_CONFIDENCE_BASE +
      top.score * FALLBACK_CONFIDENCE_PER_SCORE +
      Math.max(
        0,
        (top.score - (runnerUp?.score ?? 0)) * FALLBACK_CONFIDENCE_PER_GAP,
      ),
  );

  return {
    task: top.task,
    confidence,
    reason: `Fallback task inference selected "${top.task}" from textual signals in the request.`,
  };
}

function resolveTiedTask(
  prompt: string,
  first: Exclude<KodaXTaskType, 'unknown'>,
  second: Exclude<KodaXTaskType, 'unknown'>,
): Exclude<KodaXTaskType, 'unknown'> | null {
  const normalized = ` ${prompt.toLowerCase()} `;
  const hasExplicitReview =
    textHasKeyword(normalized, 'review') ||
    textHasKeyword(normalized, 'code review') ||
    textHasKeyword(normalized, 'merge blocker') ||
    textHasKeyword(normalized, '审查') ||
    textHasKeyword(normalized, '评审');
  const hasExplicitFix =
    textHasKeyword(normalized, 'fix') ||
    textHasKeyword(normalized, 'bug') ||
    textHasKeyword(normalized, '修复') ||
    textHasKeyword(normalized, '报错');
  const hasExplicitPlan =
    textHasKeyword(normalized, 'plan') ||
    textHasKeyword(normalized, 'design') ||
    textHasKeyword(normalized, '方案') ||
    textHasKeyword(normalized, '计划');

  if ((first === 'review' || second === 'review') && hasExplicitReview && !hasExplicitFix) {
    return 'review';
  }

  if ((first === 'bugfix' || second === 'bugfix') && hasExplicitFix && !hasExplicitReview) {
    return 'bugfix';
  }

  if ((first === 'plan' || second === 'plan') && hasExplicitPlan) {
    return 'plan';
  }

  return null;
}

export function inferTaskType(prompt: string): KodaXTaskType {
  return inferTaskSignal(prompt).task;
}

function complexityRank(value: KodaXTaskComplexity): number {
  switch (value) {
    case 'simple':
      return 0;
    case 'moderate':
      return 1;
    case 'complex':
      return 2;
    case 'systemic':
      return 3;
    default:
      return 0;
  }
}

function maxComplexity(
  left: KodaXTaskComplexity,
  right?: KodaXTaskComplexity,
): KodaXTaskComplexity {
  if (!right) {
    return left;
  }
  return complexityRank(right) > complexityRank(left) ? right : left;
}

export function buildFallbackRoutingDecision(
  prompt: string,
  providerPolicy?: KodaXProviderPolicyDecision,
  routingEvidence?: RoutingEvidenceInput,
): KodaXTaskRoutingDecision {
  const gate = inferIntentGate(prompt);
  if (!gate.requiresRoutingHeuristics) {
    const primaryTask = gate.primaryTask;
    return stabilizeRoutingDecision(prompt, {
      primaryTask,
      confidence: gate.actionability === 'non_actionable' ? 0.98 : 0.9,
      riskLevel: 'low',
      recommendedMode: getExecutionModeForTask(primaryTask),
      recommendedThinkingDepth: getDefaultDepthForTask(primaryTask),
      complexity: 'simple',
      workIntent: 'new',
      requiresBrainstorm: false,
      harnessProfile: 'H0_DIRECT',
      taskFamily: gate.taskFamily,
      actionability: gate.actionability,
      executionPattern: gate.executionPattern,
      routingSource: 'fallback',
      routingAttempts: 1,
      reason: gate.reason,
    }, providerPolicy, routingEvidence);
  }

  const inferred = inferTaskSignal(prompt);
  const primaryTask = inferred.task;
  return stabilizeRoutingDecision(prompt, {
    primaryTask,
    taskFamily: inferTaskFamilyFromPrimaryTask(primaryTask),
    actionability: primaryTask === 'unknown' ? 'ambiguous' : 'actionable',
    executionPattern: defaultExecutionPatternForFamily(inferTaskFamilyFromPrimaryTask(primaryTask)),
    confidence: inferred.confidence,
    riskLevel: getRiskLevel(prompt, primaryTask),
    recommendedMode: getExecutionModeForTask(primaryTask),
    recommendedThinkingDepth: getDefaultDepthForTask(primaryTask),
    complexity: 'moderate',
    workIntent: 'new',
    requiresBrainstorm: false,
    // Input harnessProfile is overwritten by selectHarnessProfile (always
    // H0_DIRECT) in stabilizeRoutingDecision — kept as H0_DIRECT to avoid a
    // misleading H1 literal that never survives (ADR-043).
    harnessProfile: 'H0_DIRECT',
    routingSource: 'fallback',
    routingAttempts: 1,
    reason: inferred.reason,
  }, providerPolicy, routingEvidence);
}

export function buildProviderPolicyHintsForDecision(
  decision: KodaXTaskRoutingDecision,
): KodaXProviderPolicyHints {
  const evidenceHeavy =
    decision.primaryTask === 'review' ||
    decision.primaryTask === 'bugfix' ||
    decision.recommendedMode === 'pr-review' ||
    decision.recommendedMode === 'strict-audit' ||
    decision.recommendedMode === 'investigation';

  return {
    harnessProfile: decision.harnessProfile,
    evidenceHeavy,
    brainstorm: decision.requiresBrainstorm,
    workIntent: decision.workIntent,
  };
}

export async function createReasoningPlan(
  options: KodaXOptions,
  prompt: string,
  provider: KodaXBaseProvider,
  routingEvidence?: RoutingEvidenceInput,
): Promise<ReasoningPlan> {
  const mode = resolveReasoningMode(options);
  const intentGate = inferIntentGate(prompt);
  const providerPolicy = evaluateProviderPolicy({
    providerName: provider.name,
    model: options.modelOverride ?? options.model,
    provider,
    prompt,
    options,
    reasoningMode: mode,
  });

  // FEATURE_061 Phase 1 + FEATURE_193 (v0.7.43): all paths use heuristic
  // routing only (no LLM router call here, no Scout calibration round
  // post-routing). The heuristic verdict drives V2 Worker directly.
  const decision = buildFallbackRoutingDecision(
    prompt,
    providerPolicy,
    routingEvidence,
  );
  // Reasoning single-tracking: the plan carries a single canonical `effort`.
  // Prefer the user/session-configured effort; fall back to mapping the legacy
  // reasoning mode (off→none / auto→auto / quick→low / balanced→medium /
  // deep→high) so pre-effort callers keep their behaviour. `'auto'` defers the
  // concrete level to the provider's capability-aware resolver.
  const effort: KodaXWireReasoningEffort =
    options.effort ?? mapLegacyReasoningModeToEffortIntent(mode);
  // `decision.recommendedThinkingDepth` stays on the routing decision (it is
  // part of the router schema); derive it from the legacy mode for back-compat
  // until the decision schema migrates.
  const depth = mode === 'off'
    ? 'off'
    : mode === 'auto'
      ? decision.recommendedThinkingDepth
      : reasoningModeToDepth(mode);
  const finalDecision = {
    ...decision,
    recommendedThinkingDepth: depth,
    routingNotes: [
      ...(decision.routingNotes ?? []),
      intentGate.reason,
      'Heuristic routing only — LLM router skipped (FEATURE_061 Phase 1; FEATURE_193 retired post-routing calibration).',
    ],
  };

  return {
    effort,
    // Router prompt-overlay retired (ADR-043): the Worker (H3) and SA (P1.7)
    // paths self-judge from the static EXECUTION GUIDANCE block, so the field
    // stays on the plan type but no longer carries router-injected text.
    promptOverlay: '',
    decision: finalDecision,
    providerPolicy,
  };
}

function clampUnitInterval(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}


function inferWorkIntent(
  prompt: string,
  current: KodaXTaskWorkIntent,
): KodaXTaskWorkIntent {
  const normalized = ` ${prompt.toLowerCase()} `;

  // Prefer the more destructive interpretation when a prompt mixes "extend" and "rewrite" language.
  if (OVERWRITE_INTENT_KEYWORDS.some((keyword) => textHasKeyword(normalized, keyword))) {
    return 'overwrite';
  }

  if (APPEND_INTENT_KEYWORDS.some((keyword) => textHasKeyword(normalized, keyword))) {
    return 'append';
  }

  return current;
}

function inferComplexity(
  prompt: string,
  decision: KodaXTaskRoutingDecision,
): KodaXTaskComplexity {
  const normalized = ` ${prompt.toLowerCase()} `;
  let score = 0;

  for (const keyword of COMPLEXITY_KEYWORDS.moderate) {
    if (textHasKeyword(normalized, keyword)) {
      score += 1;
    }
  }

  for (const keyword of COMPLEXITY_KEYWORDS.complex) {
    if (textHasKeyword(normalized, keyword)) {
      score += 2;
    }
  }

  for (const keyword of COMPLEXITY_KEYWORDS.systemic) {
    if (textHasKeyword(normalized, keyword)) {
      score += 3;
    }
  }

  if (decision.primaryTask === 'refactor' || decision.primaryTask === 'plan') {
    score += 2;
  }

  if (decision.riskLevel === 'high') {
    score += 2;
  }

  if (decision.workIntent === 'overwrite') {
    score += 1;
  }

  // Thresholds bias toward "simple" unless multiple independent signals agree.
  if (score >= COMPLEXITY_SYSTEMIC_THRESHOLD) {
    return 'systemic';
  }
  if (score >= COMPLEXITY_COMPLEX_THRESHOLD) {
    return 'complex';
  }
  if (score >= COMPLEXITY_MODERATE_THRESHOLD) {
    return 'moderate';
  }
  return 'simple';
}

function inferRequiresBrainstorm(
  prompt: string,
  decision: KodaXTaskRoutingDecision,
  complexity: KodaXTaskComplexity,
): boolean {
  const normalized = ` ${prompt.toLowerCase()} `;

  if (BRAINSTORM_KEYWORDS.some((keyword) => textHasKeyword(normalized, keyword))) {
    return true;
  }

  if (decision.primaryTask === 'plan') {
    return true;
  }

  if (decision.primaryTask === 'unknown' && decision.confidence < 0.7) {
    return true;
  }

  if (complexity === 'systemic') {
    return true;
  }

  if (
    decision.workIntent === 'overwrite' &&
    (decision.primaryTask === 'refactor' || decision.riskLevel === 'high')
  ) {
    return true;
  }

  return false;
}

// FEATURE_061 + FEATURE_193 (v0.7.43): heuristic routing returns a verdict
// that V2 Worker honours directly. The harnessProfile starts at
// `H0_DIRECT` and is upgraded only by the heuristic's own
// `topologyCeiling` derivation — the V1 Scout calibration round that
// could move H0 → H1/H2 mid-task no longer exists. The returned `notes`
// are surfaced to Worker via `routingNotes`; their hints are framed as
// observations the Worker can act on, not as Scout-bound instructions.
function selectHarnessProfile(
  prompt: string,
  decision: KodaXTaskRoutingDecision,
): {
  harnessProfile: KodaXHarnessProfile;
  upgradeCeiling?: KodaXHarnessProfile;
  notes: string[];
} {
  const taskFamily = decision.taskFamily ?? inferTaskFamilyFromPrimaryTask(decision.primaryTask);
  const mutationSurface = deriveMutationSurface(prompt, {
    primaryTask: decision.primaryTask,
    taskFamily,
  });

  const hints: string[] = [];
  if (decision.complexity === 'complex' || decision.complexity === 'systemic') {
    hints.push(`Complexity hint: ${decision.complexity}. Assess whether the recommended harness fits the task scope.`);
  }
  if (decision.needsIndependentQA) {
    hints.push('Independent QA was inferred from prompt signals. Verify whether explicit verification artifacts are needed before declaring the task done.');
  }
  if (decision.requiresBrainstorm) {
    hints.push('Brainstorm/planning signal detected. Judge whether to plan-first via todo_update before executing.');
  }
  if (mutationSurface === 'system' && (decision.riskLevel === 'high' || decision.workIntent === 'overwrite')) {
    hints.push('High-risk system mutation detected. Proceed with caution; consider checkpointing intermediate state.');
  }

  return {
    // Harness tier retired (ADR-043): both the profile and the ceiling are the
    // single H0_DIRECT tier. The fields are kept as accurate constants (REPL /
    // status / checkpoint schema) — they no longer carry H1/H2.
    harnessProfile: 'H0_DIRECT',
    upgradeCeiling: 'H0_DIRECT',
    notes: hints,
  };
}

function getDefaultDepthForTask(taskType: KodaXTaskType): KodaXThinkingDepth {
  switch (taskType) {
    case 'conversation':
      return 'off';
    case 'lookup':
      return 'low';
    case 'review':
      return 'low';
    case 'bugfix':
    case 'edit':
      return 'medium';
    case 'refactor':
    case 'plan':
      return 'high';
    case 'qa':
      return 'off';
    case 'unknown':
    default:
      return 'medium';
  }
}

function getExecutionModeForTask(
  taskType: KodaXTaskType,
): KodaXExecutionMode {
  switch (taskType) {
    case 'conversation':
      return 'conversation';
    case 'lookup':
      return 'lookup';
    case 'review':
      return 'pr-review';
    case 'bugfix':
      return 'investigation';
    case 'plan':
      return 'planning';
    case 'qa':
    case 'edit':
    case 'refactor':
    case 'unknown':
    default:
      return 'implementation';
  }
}

function getRiskLevel(
  prompt: string,
  taskType: KodaXTaskType,
): 'low' | 'medium' | 'high' {
  const text = prompt.toLowerCase();

  if (taskType === 'conversation' || taskType === 'lookup') {
    return 'low';
  }

  if (
    text.includes('security') ||
    text.includes('auth') ||
    text.includes('migration') ||
    text.includes('database') ||
    text.includes('schema') ||
    text.includes('production') ||
    text.includes('\u5b89\u5168') ||
    text.includes('\u9274\u6743') ||
    text.includes('\u6743\u9650') ||
    text.includes('\u8fc1\u79fb') ||
    text.includes('\u6570\u636e\u5e93') ||
    text.includes('\u751f\u4ea7')
  ) {
    return 'high';
  }

  if (taskType === 'review' || taskType === 'bugfix' || taskType === 'plan') {
    return 'medium';
  }

  return 'low';
}

function computeSoloBoundaryConfidence(
  prompt: string,
  decision: Pick<
    KodaXTaskRoutingDecision,
    'primaryTask' | 'complexity' | 'riskLevel' | 'requiresBrainstorm' | 'workIntent' | 'reviewScale'
  >,
  repoSignals?: KodaXRepoRoutingSignals,
): number {
  let score = 0.9;
  const normalized = ` ${prompt.toLowerCase()} `;

  if (decision.primaryTask === 'review') {
    score -= 0.12;
    if (decision.reviewScale === 'large') {
      score -= 0.16;
    } else if (decision.reviewScale === 'massive') {
      score -= 0.28;
    }
  } else if (decision.primaryTask === 'bugfix') {
    score -= 0.08;
  } else if (decision.primaryTask === 'plan') {
    score -= 0.24;
  }

  if (decision.riskLevel === 'medium') {
    score -= 0.12;
  } else if (decision.riskLevel === 'high') {
    score -= 0.26;
  }

  if (decision.complexity === 'moderate') {
    score -= 0.12;
  } else if (decision.complexity === 'complex') {
    score -= 0.28;
  } else if (decision.complexity === 'systemic') {
    score -= 0.42;
  }

  if (decision.requiresBrainstorm) {
    score -= 0.18;
  }
  if (decision.workIntent === 'overwrite') {
    score -= 0.08;
  }

  if (
    /\b(strict review|must[- ]fix|independently verify|browser test|playwright|e2e|frontend verify)\b/.test(normalized)
  ) {
    score -= 0.2;
  }

  if (repoSignals) {
    if (repoSignals.changedFileCount >= 3) {
      score -= 0.12;
    }
    if (repoSignals.changedLineCount >= REVIEW_LARGE_LINE_THRESHOLD) {
      score -= 0.14;
    }
    if (repoSignals.changedLineCount >= REVIEW_MASSIVE_LINE_THRESHOLD) {
      score -= 0.14;
    }
    if (repoSignals.touchedModuleCount >= 2) {
      score -= 0.16;
    }
    if ((repoSignals.impactedModuleCount ?? 0) >= 2) {
      score -= 0.14;
    }
    if (repoSignals.crossModule) {
      score -= 0.2;
    }
    if (repoSignals.lowConfidence) {
      score -= 0.08;
    }
  }

  return clampUnitInterval(score, 0.5);
}

function computeNeedsIndependentQA(
  prompt: string,
  decision: Pick<
    KodaXTaskRoutingDecision,
    'primaryTask' | 'complexity' | 'riskLevel' | 'requiresBrainstorm' | 'reviewScale'
  >,
  repoSignals?: KodaXRepoRoutingSignals,
): boolean {
  const normalized = ` ${prompt.toLowerCase()} `;
  if (
    /\b(must[- ]fix|strict review|audit|independently verify|browser test|playwright|e2e|console errors?|api check|db check)\b/.test(normalized)
  ) {
    return true;
  }

  if (
    decision.primaryTask === 'plan'
    || decision.primaryTask === 'qa'
    || decision.riskLevel === 'high'
    || decision.complexity === 'complex'
    || decision.complexity === 'systemic'
    || decision.requiresBrainstorm
  ) {
    return true;
  }

  if (repoSignals) {
    if (repoSignals.crossModule || repoSignals.lowConfidence) {
      return true;
    }
    if ((repoSignals.impactedModuleCount ?? 0) >= 2 || repoSignals.touchedModuleCount >= 2) {
      return true;
    }
    if (repoSignals.changedLineCount >= REVIEW_LARGE_LINE_THRESHOLD) {
      return true;
    }
  }

  return false;
}

function ensureMinimumDepth(
  current: KodaXThinkingDepth,
  minimum: Exclude<KodaXThinkingDepth, 'off'>,
): Exclude<KodaXThinkingDepth, 'off'> {
  return THINKING_DEPTH_ORDER[current] >= THINKING_DEPTH_ORDER[minimum]
    ? (current === 'off' ? minimum : current)
    : minimum;
}

function isTaskType(value: unknown): value is KodaXTaskType {
  return (
    value === 'conversation' ||
    value === 'lookup' ||
    value === 'review' ||
    value === 'bugfix' ||
    value === 'edit' ||
    value === 'refactor' ||
    value === 'plan' ||
    value === 'qa' ||
    value === 'unknown'
  );
}

function isExecutionMode(value: unknown): value is KodaXExecutionMode {
  return (
    value === 'conversation' ||
    value === 'lookup' ||
    value === 'pr-review' ||
    value === 'strict-audit' ||
    value === 'implementation' ||
    value === 'planning' ||
    value === 'investigation'
  );
}

function isThinkingDepth(value: unknown): value is KodaXThinkingDepth {
  return (
    value === 'off' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high'
  );
}

function isRiskLevel(value: unknown): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isTaskFamily(value: unknown): value is KodaXTaskFamily {
  return (
    value === 'conversation' ||
    value === 'lookup' ||
    value === 'review' ||
    value === 'implementation' ||
    value === 'investigation' ||
    value === 'planning' ||
    value === 'ambiguous'
  );
}

function isTaskActionability(value: unknown): value is KodaXTaskActionability {
  return value === 'non_actionable' || value === 'actionable' || value === 'ambiguous';
}

function isExecutionPattern(value: unknown): value is KodaXExecutionPattern {
  return value === 'direct' || value === 'checked-direct' || value === 'coordinated';
}

function isMutationSurface(value: unknown): value is KodaXMutationSurface {
  return value === 'read-only' || value === 'docs-only' || value === 'code' || value === 'system';
}

function isAssuranceIntent(value: unknown): value is KodaXAssuranceIntent {
  return value === 'default' || value === 'explicit-check';
}

function applyRepoSignalsToDecision(
  stabilized: KodaXTaskRoutingDecision,
  inferredComplexity: KodaXTaskComplexity,
  complexity: KodaXTaskComplexity,
  repoSignals: KodaXRepoRoutingSignals | undefined,
): {
  recommendedMode: KodaXExecutionMode;
  recommendedThinkingDepth: KodaXThinkingDepth;
  repoNotes: string[];
} {
  let recommendedMode = stabilized.recommendedMode;
  let recommendedThinkingDepth = stabilized.recommendedThinkingDepth;
  const repoNotes: string[] = [];

  if (!repoSignals) {
    return {
      recommendedMode,
      recommendedThinkingDepth,
      repoNotes,
    };
  }

  if (
    repoSignals.suggestedComplexity
    && complexityRank(repoSignals.suggestedComplexity) > complexityRank(inferredComplexity)
  ) {
    repoNotes.push(
      `Repository intelligence elevated task complexity to ${repoSignals.suggestedComplexity} (changedFiles=${repoSignals.changedFileCount}, touchedModules=${repoSignals.touchedModuleCount}, impactedModules=${repoSignals.impactedModuleCount ?? 0}).`,
    );
  }

  if (repoSignals.crossModule) {
    repoNotes.push('Repository intelligence indicates cross-module impact; keep evidence and merge boundaries explicit.');
  }

  if (repoSignals.lowConfidence) {
    // FEATURE_163 v0.7.41 — reverse-guidance fix. Previous wording said
    // "validate critical conclusions with direct file evidence" which
    // pushed the model toward `read`/`grep` even when a `module_context`
    // or `symbol_context` refresh would be cheaper AND more accurate
    // for the low-confidence area. The new wording flips the recovery
    // path to pull-tools first (matching FEATURE_161 Worker teaching),
    // with raw read/grep only when a specific claim is load-bearing.
    repoNotes.push(staticText("t12.reasoning.0"));
  }

  if (
    repoSignals.investigationBias
    && (stabilized.primaryTask === 'review' || stabilized.primaryTask === 'bugfix')
    && recommendedMode !== 'investigation'
  ) {
    recommendedMode = 'investigation';
    if (recommendedThinkingDepth === 'off' || recommendedThinkingDepth === 'low') {
      recommendedThinkingDepth = 'medium';
    }
    repoNotes.push('Repository intelligence shifted execution toward investigation because the active area is low-confidence or high-blast-radius.');
  } else if (
    repoSignals.plannerBias
    && stabilized.primaryTask !== 'review'
    && stabilized.primaryTask !== 'bugfix'
    && recommendedMode === 'implementation'
    && (complexity === 'complex' || complexity === 'systemic')
  ) {
    recommendedMode = 'planning';
    if (recommendedThinkingDepth === 'off' || recommendedThinkingDepth === 'low') {
      recommendedThinkingDepth = 'medium';
    }
    repoNotes.push('Repository intelligence shifted execution toward planning because the task spans multiple modules or dependencies.');
  }

  return {
    recommendedMode,
    recommendedThinkingDepth,
    repoNotes,
  };
}

function parsePromptInteger(prompt: string, regex: RegExp): number | undefined {
  const match = regex.exec(prompt);
  if (!match?.[1]) {
    return undefined;
  }

  const rawValue = match[1].replace(/,/g, '').toLowerCase();
  const multiplier = rawValue.endsWith('k') ? 1000 : 1;
  const numeric = rawValue.endsWith('k') ? rawValue.slice(0, -1) : rawValue;
  const value = Number.parseFloat(numeric);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value * multiplier);
}

function inferPromptReviewScale(prompt: string): {
  changedFileCount?: number;
  changedLineCount?: number;
  reviewScale?: KodaXTaskRoutingDecision['reviewScale'];
} {
  const changedFileCount = parsePromptInteger(
    prompt,
    /(?:^|[\s(,])(\d[\d,]*(?:\.\d+)?k?)\s*(?:changed\s+)?files?\b/i,
  );
  const changedLineCount = parsePromptInteger(
    prompt,
    /(?:^|[\s(,])(\d[\d,]*(?:\.\d+)?k?)\s*(?:changed\s+)?lines?\b/i,
  );

  let reviewScale: KodaXTaskRoutingDecision['reviewScale'];
  if (
    (changedFileCount ?? 0) >= REVIEW_MASSIVE_FILE_THRESHOLD
    || (changedLineCount ?? 0) >= REVIEW_MASSIVE_LINE_THRESHOLD
  ) {
    reviewScale = 'massive';
  } else if (
    (changedFileCount ?? 0) >= REVIEW_LARGE_FILE_THRESHOLD
    || (changedLineCount ?? 0) >= REVIEW_LARGE_LINE_THRESHOLD
  ) {
    reviewScale = 'large';
  }

  return {
    changedFileCount,
    changedLineCount,
    reviewScale,
  };
}

function deriveReviewScaleFromSignals(
  repoSignals?: KodaXRepoRoutingSignals,
  prompt?: string,
): KodaXTaskRoutingDecision['reviewScale'] | undefined {
  if (repoSignals?.reviewScale) {
    return repoSignals.reviewScale;
  }
  return inferPromptReviewScale(prompt ?? '').reviewScale;
}

function stabilizeRoutingDecision(
  prompt: string,
  decision: KodaXTaskRoutingDecision,
  providerPolicy?: KodaXProviderPolicyDecision,
  routingEvidence?: RoutingEvidenceInput,
): KodaXTaskRoutingDecision {
  let stabilized = decision;
  const intentFields = deriveIntentFields(prompt, decision);
  const repoSignalsAllowed = intentFields.actionability === 'actionable'
    && intentFields.taskFamily !== 'conversation'
    && intentFields.taskFamily !== 'lookup';

  if (decision.primaryTask === 'unknown' && intentFields.taskFamily === 'ambiguous') {
    stabilized = {
      ...decision,
      recommendedMode: 'implementation',
      recommendedThinkingDepth: 'medium',
      reason: `${decision.reason} Conservative fallback keeps balanced reasoning for ambiguous tasks.`,
    };
  }

  if (stabilized.primaryTask === 'qa' && stabilized.confidence < LOW_CONFIDENCE_QA_THRESHOLD) {
    stabilized = {
      ...stabilized,
      primaryTask: 'unknown',
      confidence: Math.min(stabilized.confidence, LOW_CONFIDENCE_QA_CAP),
      riskLevel: getRiskLevel(prompt, 'unknown'),
      recommendedMode: 'implementation',
      recommendedThinkingDepth: 'medium',
      reason: `${stabilized.reason} Low-confidence QA routing was downgraded to unknown so reasoning stays available.`,
    };
  }

  if (stabilized.confidence < LOW_CONFIDENCE_OFF_THRESHOLD && stabilized.recommendedThinkingDepth === 'off') {
    stabilized = {
      ...stabilized,
      primaryTask: 'unknown',
      recommendedMode: 'implementation',
      recommendedThinkingDepth: 'medium',
      reason: `${stabilized.reason} Low-confidence off-mode routing was upgraded to balanced reasoning for safety.`,
    };
  }

  const workIntent = inferWorkIntent(prompt, stabilized.workIntent);
  const repoSignals = repoSignalsAllowed ? routingEvidence?.repoSignals : undefined;
  const inferredComplexity = inferComplexity(
    prompt,
    {
      ...stabilized,
      workIntent,
    },
  );
  const complexity = repoSignalsAllowed
    ? maxComplexity(inferredComplexity, repoSignals?.suggestedComplexity)
    : inferredComplexity;
  const reviewScale = decision.reviewScale ?? deriveReviewScaleFromSignals(repoSignals, prompt);
  const mutationSurface = deriveMutationSurface(prompt, {
    primaryTask: stabilized.primaryTask,
    taskFamily: intentFields.taskFamily,
  });
  const assuranceIntent = deriveAssuranceIntent(prompt, stabilized);
  // Harness tier retired (ADR-043): the ceiling collapsed to the single
  // H0_DIRECT tier. The assurance/complexity signal that used to lift it to
  // H1/H2 stays queryable on the decision (assuranceIntent / complexity /
  // mutationSurface / needsIndependentQA); the ceiling field is a constant.
  const topologyCeiling: KodaXHarnessProfile = 'H0_DIRECT';
  const requiresBrainstorm = inferRequiresBrainstorm(
    prompt,
    {
      ...stabilized,
      workIntent,
      complexity,
      reviewScale,
      mutationSurface,
      assuranceIntent,
      topologyCeiling,
    },
    complexity,
  ) || Boolean(
    repoSignals?.plannerBias
    && (complexity === 'complex' || complexity === 'systemic'),
  );
  const soloBoundaryConfidence = clampUnitInterval(
    decision.soloBoundaryConfidence
      ?? computeSoloBoundaryConfidence(
        prompt,
        {
          primaryTask: stabilized.primaryTask,
          complexity,
          riskLevel: stabilized.riskLevel,
          requiresBrainstorm,
          workIntent,
          reviewScale,
        },
      repoSignals,
    ),
    0.5,
  );
  const computedNeedsIndependentQA = decision.needsIndependentQA
    ?? computeNeedsIndependentQA(
      prompt,
      {
        primaryTask: stabilized.primaryTask,
        complexity,
        riskLevel: stabilized.riskLevel,
        requiresBrainstorm,
        reviewScale,
      },
      repoSignals,
    );
  const needsIndependentQA = (mutationSurface === 'read-only' || mutationSurface === 'docs-only')
    ? assuranceIntent === 'explicit-check'
    : computedNeedsIndependentQA;
  const harnessDecision = selectHarnessProfile(
    prompt,
    {
      ...stabilized,
      workIntent,
      complexity,
      requiresBrainstorm,
      reviewScale,
      soloBoundaryConfidence,
      needsIndependentQA,
      mutationSurface,
      assuranceIntent,
      topologyCeiling,
    },
  );
  const {
    recommendedMode,
    recommendedThinkingDepth,
    repoNotes,
  } = applyRepoSignalsToDecision(
    {
      ...stabilized,
      taskFamily: intentFields.taskFamily,
      actionability: intentFields.actionability,
      executionPattern: intentFields.executionPattern,
    },
    inferredComplexity,
    complexity,
    repoSignals,
  );

  let nextRecommendedMode = recommendedMode;
  let nextThinkingDepth = recommendedThinkingDepth;
  // FEATURE_061 + FEATURE_193 (v0.7.43): heuristic routing produces a
  // binding H0_DIRECT verdict with `direct` execution pattern. The V1
  // Scout post-analysis upgrade path no longer exists; V2 Worker
  // executes against this verdict as-is.
  const finalExecutionPattern: KodaXExecutionPattern = 'direct';

  if (intentFields.taskFamily === 'conversation') {
    nextRecommendedMode = 'conversation';
    nextThinkingDepth = 'off';
  } else if (intentFields.taskFamily === 'lookup') {
    nextRecommendedMode = 'lookup';
    nextThinkingDepth = recommendedThinkingDepth === 'high' ? 'medium' : recommendedThinkingDepth;
  }

  return {
    ...stabilized,
    taskFamily: intentFields.taskFamily,
    actionability: intentFields.actionability,
    executionPattern: finalExecutionPattern,
    mutationSurface,
    assuranceIntent,
    recommendedMode: nextRecommendedMode,
    recommendedThinkingDepth: nextThinkingDepth,
    workIntent,
    complexity,
    requiresBrainstorm,
    topologyCeiling,
    reviewScale,
    soloBoundaryConfidence,
    needsIndependentQA,
    harnessProfile: harnessDecision.harnessProfile,
    upgradeCeiling: harnessDecision.upgradeCeiling,
    routingSource: stabilized.routingSource ?? 'fallback',
    routingAttempts: stabilized.routingAttempts ?? 1,
    routingNotes: [
      ...(stabilized.routingNotes ?? []),
      ...harnessDecision.notes,
      ...repoNotes,
      ...(repoSignalsAllowed ? [] : ['Intent gate ignored repository scaling signals for this request.']),
    ],
  };
}

function isTaskComplexity(value: unknown): value is KodaXTaskComplexity {
  return (
    value === 'simple' ||
    value === 'moderate' ||
    value === 'complex' ||
    value === 'systemic'
  );
}

function isTaskWorkIntent(value: unknown): value is KodaXTaskWorkIntent {
  return value === 'append' || value === 'overwrite' || value === 'new';
}

function isHarnessProfile(value: unknown): value is KodaXHarnessProfile {
  return (
    value === 'H0_DIRECT' ||
    value === 'H1_EXECUTE_EVAL' ||
    value === 'H2_PLAN_EXECUTE_EVAL'
  );
}
