import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  KodaXExecutionMode,
  KodaXHarnessProfile,
  KodaXMessage,
  KodaXOptions,
  KodaXProviderPolicyHints,
  KodaXReasoningMode,
  SessionErrorMetadata,
  KodaXTaskComplexity,
  KodaXTaskRoutingDecision,
  KodaXTaskType,
  KodaXTaskWorkIntent,
  KodaXThinkingDepth,
} from './types.js';
import {
  getDefaultThinkingDepthForMode,
  KODAX_REASONING_MODE_SEQUENCE,
} from '@kodax/ai';
import type { KodaXBaseProvider } from '@kodax/ai';
import {
  hasNonTransientRuntimeEvidence,
  hasTransientRetryEvidence,
  looksLikeActionableRuntimeEvidence,
} from './runtime-evidence.js';
import {
  evaluateProviderPolicy,
  type KodaXProviderPolicyDecision,
} from './provider-policy.js';

export { KODAX_REASONING_MODE_SEQUENCE };

const execAsync = promisify(exec);

const FALLBACK_REASONING_MODE: KodaXReasoningMode = 'off';
const ROUTING_DEBUG_ENV_VAR = 'KODAX_DEBUG_ROUTING';

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

const EXECUTION_MODE_OVERLAYS: Record<KodaXExecutionMode, string> = {
  'pr-review': [
    '[Execution Mode: pr-review]',
    '- Report only high-confidence, actionable issues that materially affect correctness, reliability, security, or merge readiness.',
    '- Do not count naming preferences, formatting, or minor best-practice nits as findings.',
    '- Prefer the output structure: Must fix, then Optional improvements.',
    '- Limit must-fix findings to the most important 5 items, ordered by impact.',
    '- Every reported issue must explain the concrete consequence.',
  ].join('\n'),
  'strict-audit': [
    '[Execution Mode: strict-audit]',
    '- Perform a broad audit across correctness, security, performance, and maintainability.',
    '- Separate confirmed issues from lower-confidence risks.',
    '- You may include broader risks and follow-up checks when clearly labeled.',
  ].join('\n'),
  implementation: [
    '[Execution Mode: implementation]',
    '- Focus on direct execution and high-signal reasoning.',
    '- Prefer making progress over extended commentary.',
    '- Keep explanations concise unless a tradeoff materially affects the result.',
  ].join('\n'),
  planning: [
    '[Execution Mode: planning]',
    '- Focus on architecture, constraints, sequencing, and risk management.',
    '- Prefer structured plans, tradeoffs, and validation steps before code changes.',
  ].join('\n'),
  investigation: [
    '[Execution Mode: investigation]',
    '- Focus on isolating root cause, validating assumptions, and narrowing uncertainty.',
    '- Prefer concrete evidence, reproduction steps, and targeted checks before broad changes.',
  ].join('\n'),
};

const HARNESS_PROFILE_OVERLAYS: Record<KodaXHarnessProfile, string> = {
  H0_DIRECT: [
    '[Harness Profile: H0_DIRECT]',
    '- Keep the task in a single direct pass unless concrete evidence forces escalation.',
    '- Prefer concise execution without extra discovery scaffolding.',
  ].join('\n'),
  H1_EXECUTE_EVAL: [
    '[Harness Profile: H1_EXECUTE_EVAL]',
    '- Execute the task, then self-check the result against the request before finalizing.',
    '- Prefer evidence-backed completion over speculative confidence.',
  ].join('\n'),
  H2_PLAN_EXECUTE_EVAL: [
    '[Harness Profile: H2_PLAN_EXECUTE_EVAL]',
    '- Start with a short explicit plan or option framing before making changes.',
    '- After execution, verify the result and call out any residual uncertainty.',
  ].join('\n'),
  H3_MULTI_WORKER: [
    '[Harness Profile: H3_MULTI_WORKER]',
    '- Decompose the work into independent slices and treat execution as coordinated multi-track work.',
    '- Keep contracts, evidence, and merge points explicit so the task can scale beyond one linear pass.',
  ].join('\n'),
};

const ROUTER_SYSTEM_PROMPT = [
  'You are a task router for a coding agent.',
  'Classify the user request into one primary task and an optional secondary task.',
  'Return valid JSON only.',
  'Allowed primaryTask and secondaryTask values: review, bugfix, edit, refactor, plan, qa, unknown.',
  'Allowed riskLevel values: low, medium, high.',
  'Allowed recommendedMode values: pr-review, strict-audit, implementation, planning, investigation.',
  'Allowed recommendedThinkingDepth values: off, low, medium, high.',
  'Allowed complexity values: simple, moderate, complex, systemic.',
  'Allowed workIntent values: append, overwrite, new.',
  'Allowed harnessProfile values: H0_DIRECT, H1_EXECUTE_EVAL, H2_PLAN_EXECUTE_EVAL, H3_MULTI_WORKER.',
  'requiresBrainstorm must be a boolean.',
  'routingNotes, when present, must be an array of short strings.',
  'Confidence must be a number between 0 and 1.',
  'Prefer conservative decisions when the request is ambiguous.',
].join('\n');

const AUTO_REROUTE_SYSTEM_PROMPT = [
  'You are a reroute judge for a coding agent.',
  'Decide whether the first-pass response should be rerun with stronger reasoning or investigation mode.',
  'Return valid JSON only.',
  'Allowed nextPrimaryTask values: review, bugfix, edit, refactor, plan, qa, unknown.',
  'Allowed nextRecommendedMode values: pr-review, strict-audit, implementation, planning, investigation.',
  'Allowed nextThinkingDepth values: low, medium, high.',
  'Only reroute when there is clear evidence the first pass was mismatched, too uncertain, or too low-value.',
  'Prefer no reroute unless the evidence is strong.',
].join('\n');

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
  mode: KodaXReasoningMode;
  depth: KodaXThinkingDepth;
  decision: KodaXTaskRoutingDecision;
  promptOverlay: string;
  providerPolicy?: KodaXProviderPolicyDecision;
}

export interface RoutingEvidenceInput {
  recentMessages?: KodaXMessage[];
  sessionErrorMetadata?: SessionErrorMetadata;
  additionalSignals?: string[];
}

export interface AutoRerouteEvidence {
  toolEvidence?: string;
}

export interface AutoRerouteDecision {
  shouldReroute: boolean;
  nextPrimaryTask?: KodaXTaskType;
  nextRecommendedMode?: KodaXExecutionMode;
  nextThinkingDepth?: Exclude<KodaXThinkingDepth, 'off'>;
  reason: string;
}

export type ReasoningFollowUpKind = 'depth-escalation' | 'task-reroute';

export interface ReasoningFollowUpPlan extends ReasoningPlan {
  kind: ReasoningFollowUpKind;
}

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

const TASK_TYPE_KEYWORDS: Record<
  Exclude<KodaXTaskType, 'unknown'>,
  readonly string[]
> = {
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

function isRoutingDebugEnabled(): boolean {
  const value = process.env[ROUTING_DEBUG_ENV_VAR]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function logRoutingDebug(scope: string, error: unknown): void {
  if (!isRoutingDebugEnabled()) {
    return;
  }

  console.error(`[Routing] ${scope} failed:`, error);
}

export function buildFallbackRoutingDecision(
  prompt: string,
  providerPolicy?: KodaXProviderPolicyDecision,
): KodaXTaskRoutingDecision {
  const inferred = inferTaskSignal(prompt);
  const primaryTask = inferred.task;
  return stabilizeRoutingDecision(prompt, {
    primaryTask,
    confidence: inferred.confidence,
    riskLevel: getRiskLevel(prompt, primaryTask),
    recommendedMode: getExecutionModeForTask(primaryTask),
    recommendedThinkingDepth: getDefaultDepthForTask(primaryTask),
    complexity: 'moderate',
    workIntent: 'new',
    requiresBrainstorm: false,
    harnessProfile: 'H1_EXECUTE_EVAL',
    reason: inferred.reason,
  }, providerPolicy);
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

export function buildPromptOverlay(
  decision: KodaXTaskRoutingDecision,
  extraNotes: string[] = [],
  _providerPolicy?: KodaXProviderPolicyDecision,
): string {
  const routingNotes = decision.routingNotes?.map(
    (note) => `[Task Routing Note] ${note}`,
  ) ?? [];
  const workIntentGuidance = buildWorkIntentGuidance(decision.workIntent);
  const brainstormGuidance = decision.requiresBrainstorm
    ? [
      '[Brainstorm Trigger] Resolve ambiguity with a brief option framing before locking in the implementation path.',
      '- Make the chosen path explicit before performing irreversible edits.',
    ].join('\n')
    : null;

  return [
    EXECUTION_MODE_OVERLAYS[decision.recommendedMode],
    HARNESS_PROFILE_OVERLAYS[decision.harnessProfile],
    `[Task Routing] primary=${decision.primaryTask}; risk=${decision.riskLevel}; complexity=${decision.complexity}; intent=${decision.workIntent}; brainstorm=${decision.requiresBrainstorm ? 'yes' : 'no'}; harness=${decision.harnessProfile}; confidence=${decision.confidence.toFixed(2)}.`,
    `[Task Routing Reason] ${decision.reason}`,
    `[Work Intent] ${workIntentGuidance}`,
    brainstormGuidance,
    ...routingNotes,
    ...extraNotes,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function createReasoningPlan(
  options: KodaXOptions,
  prompt: string,
  provider: KodaXBaseProvider,
  routingEvidence?: RoutingEvidenceInput,
): Promise<ReasoningPlan> {
  const mode = resolveReasoningMode(options);
  const providerPolicy = evaluateProviderPolicy({
    providerName: provider.name,
    model: options.modelOverride ?? options.model,
    provider,
    prompt,
    options,
    reasoningMode: mode,
  });

  if (mode === 'auto') {
    const decision = await routeTaskWithLLM(
      provider,
      prompt,
      options,
      providerPolicy,
      routingEvidence,
    );
    return {
      mode,
      depth: decision.recommendedThinkingDepth,
      promptOverlay: buildPromptOverlay(
        decision,
        providerPolicy.routingNotes,
        providerPolicy,
      ),
      decision,
      providerPolicy,
    };
  }

  const fallbackDecision = buildFallbackRoutingDecision(prompt, providerPolicy);
  const depth = mode === 'off' ? 'off' : reasoningModeToDepth(mode);
  const decision: KodaXTaskRoutingDecision = {
    ...fallbackDecision,
    recommendedThinkingDepth: depth,
  };

  return {
    mode,
    depth,
    promptOverlay: buildPromptOverlay(
      decision,
      providerPolicy.routingNotes,
      providerPolicy,
    ),
    decision,
    providerPolicy,
  };
}

export async function maybeCreateAutoReroutePlan(
  provider: KodaXBaseProvider,
  options: KodaXOptions,
  prompt: string,
  currentPlan: ReasoningPlan,
  assistantText: string,
  allowances: {
    allowDepthEscalation: boolean;
    allowTaskReroute: boolean;
  },
  evidence?: AutoRerouteEvidence,
): Promise<ReasoningFollowUpPlan | null> {
  const rerouteEvidenceText = [assistantText.trim(), evidence?.toolEvidence?.trim()]
    .filter(Boolean)
    .join('\n\n[Tool Evidence]\n');

  if (currentPlan.mode !== 'auto' || !rerouteEvidenceText.trim()) {
    return null;
  }

  if (
    currentPlan.decision.primaryTask === 'review' &&
    hasTransientRetryEvidence(rerouteEvidenceText) &&
    !hasNonTransientRuntimeEvidence(rerouteEvidenceText)
  ) {
    return null;
  }

  const fallback = buildHeuristicAutoRerouteDecision(currentPlan, rerouteEvidenceText);
  const judged = await judgeAutoRerouteWithLLM(
    provider,
    options,
    prompt,
    currentPlan,
    assistantText,
    evidence,
  );
  const normalized = normalizeAutoRerouteDecision(
    currentPlan,
    judged ?? fallback,
    allowances,
  );

  if (!normalized) {
    return null;
  }

  const nextDecision = stabilizeRoutingDecision(prompt, {
    ...currentPlan.decision,
    primaryTask: normalized.nextPrimaryTask,
    confidence: Math.max(currentPlan.decision.confidence, 0.82),
    riskLevel:
      normalized.nextRecommendedMode === 'investigation'
        ? 'high'
        : currentPlan.decision.riskLevel,
    recommendedMode: normalized.nextRecommendedMode,
    recommendedThinkingDepth: normalized.nextThinkingDepth,
    reason: normalized.reason,
  } satisfies KodaXTaskRoutingDecision, currentPlan.providerPolicy);

  const followUpLabel =
    normalized.kind === 'task-reroute' ? '[Auto Reroute]' : '[Auto Depth Escalation]';
  const followUpGuidance =
    normalized.kind === 'task-reroute'
      ? `${followUpLabel} Re-running the request because: ${normalized.reason}`
      : `${followUpLabel} Keeping the task/mode the same, but using one deeper pass because: ${normalized.reason}`;

  return {
    kind: normalized.kind,
    mode: currentPlan.mode,
    depth: nextDecision.recommendedThinkingDepth,
    decision: nextDecision,
    providerPolicy: currentPlan.providerPolicy,
    promptOverlay: buildPromptOverlay(nextDecision, [
      followUpGuidance,
      `${followUpLabel} Focus on high-confidence, high-signal output for this follow-up pass.`,
    ], currentPlan.providerPolicy),
  };
}

export function buildHeuristicAutoRerouteDecision(
  currentPlan: ReasoningPlan,
  assistantText: string,
): AutoRerouteDecision {
  const text = assistantText.toLowerCase();
  const hasUncertainty = UNCERTAINTY_MARKERS.some((marker) => text.includes(marker));
  const hasRuntimeEvidence = hasNonTransientRuntimeEvidence(assistantText);
  const hasTransientRetryEvidenceOnly =
    hasTransientRetryEvidence(assistantText) && !hasRuntimeEvidence;
  const hasLowValueReview = LOW_VALUE_REVIEW_MARKERS.some((marker) => text.includes(marker));
  const hasHighImpact = HIGH_IMPACT_MARKERS.some((marker) => text.includes(marker));

  if (currentPlan.decision.primaryTask === 'review' && hasTransientRetryEvidenceOnly) {
    return {
      shouldReroute: false,
      reason: 'Transient retry evidence such as a timeout should be retried before rerouting review into investigation.',
    };
  }

  if (currentPlan.decision.primaryTask === 'review' && hasRuntimeEvidence) {
    return {
      shouldReroute: true,
      nextPrimaryTask: 'bugfix',
      nextRecommendedMode: 'investigation',
      nextThinkingDepth: ensureMinimumDepth(currentPlan.depth, 'medium'),
      reason: 'The first pass surfaced runtime or test-failure evidence, so the task should switch from review into investigation.',
    };
  }

  if (hasUncertainty) {
    const nextDepth = escalateThinkingDepth(currentPlan.depth);
    if (nextDepth !== currentPlan.depth) {
      return {
        shouldReroute: true,
        nextPrimaryTask: currentPlan.decision.primaryTask,
        nextRecommendedMode: currentPlan.decision.recommendedMode,
        nextThinkingDepth: nextDepth,
        reason: 'The first pass sounded uncertain and likely needs one deeper pass before returning the final answer.',
      };
    }
  }

  if (
    currentPlan.decision.primaryTask === 'review' &&
    hasLowValueReview &&
    !hasHighImpact
  ) {
    const nextDepth = escalateThinkingDepth(currentPlan.depth);
    if (nextDepth !== currentPlan.depth) {
      return {
        shouldReroute: true,
        nextPrimaryTask: 'review',
        nextRecommendedMode: 'pr-review',
        nextThinkingDepth: nextDepth,
        reason: 'The first pass focused on low-value review nits and should be rerun with a stricter merge-blocking review lens.',
      };
    }
  }

  return {
    shouldReroute: false,
    reason: 'No strong reroute signal was detected.',
  };
}

export function escalateThinkingDepth(
  depth: KodaXThinkingDepth,
): Exclude<KodaXThinkingDepth, 'off'> {
  switch (depth) {
    case 'off':
      return 'low';
    case 'low':
      return 'medium';
    case 'medium':
    case 'high':
    default:
      return 'high';
  }
}

async function routeTaskWithLLM(
  provider: KodaXBaseProvider,
  prompt: string,
  options: KodaXOptions,
  providerPolicy: KodaXProviderPolicyDecision,
  routingEvidence?: RoutingEvidenceInput,
): Promise<KodaXTaskRoutingDecision> {
  const fallback = buildFallbackRoutingDecision(prompt, providerPolicy);
  const repoSummary = await buildRepositoryRoutingSummary(
    options.context?.gitRoot ?? undefined,
    providerPolicy,
    routingEvidence,
  );

  try {
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          'Route this coding-agent request.',
          '',
          `User request: ${prompt}`,
          '',
          'Repository signals:',
          repoSummary,
          '',
          'Return JSON only.',
        ].join('\n'),
      },
    ];

    const result = await provider.stream(
      messages,
      [],
      ROUTER_SYSTEM_PROMPT,
      false,
      {
        modelOverride: options.modelOverride ?? options.model,
        signal: options.abortSignal,
      },
      options.abortSignal,
    );

    const raw = result.textBlocks.map((block) => block.text).join('\n').trim();
    const parsed = parseRoutingDecision(raw);
    return stabilizeRoutingDecision(prompt, parsed ?? fallback, providerPolicy);
  } catch (error) {
    logRoutingDebug('task router', error);
    return stabilizeRoutingDecision(prompt, fallback, providerPolicy);
  }
}

async function judgeAutoRerouteWithLLM(
  provider: KodaXBaseProvider,
  options: KodaXOptions,
  prompt: string,
  currentPlan: ReasoningPlan,
  assistantText: string,
  evidence?: AutoRerouteEvidence,
): Promise<AutoRerouteDecision | null> {
  try {
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          'Judge whether the first-pass response should be rerouted.',
          '',
          `Original user request: ${prompt}`,
          `Current primary task: ${currentPlan.decision.primaryTask}`,
          `Current execution mode: ${currentPlan.decision.recommendedMode}`,
          `Current thinking depth: ${currentPlan.depth}`,
          `Current confidence: ${currentPlan.decision.confidence.toFixed(2)}`,
          '',
          'First-pass response:',
          assistantText,
          evidence?.toolEvidence?.trim()
            ? ['', 'Tool evidence:', evidence.toolEvidence.trim()].join('\n')
            : '',
          '',
          'Return JSON only.',
        ].join('\n'),
      },
    ];

    const result = await provider.stream(
      messages,
      [],
      AUTO_REROUTE_SYSTEM_PROMPT,
      false,
      {
        modelOverride: options.modelOverride ?? options.model,
        signal: options.abortSignal,
      },
      options.abortSignal,
    );

    const raw = result.textBlocks.map((block) => block.text).join('\n').trim();
    return parseAutoRerouteDecision(raw);
  } catch (error) {
    logRoutingDebug('reroute judge', error);
    return null;
  }
}

function parseRoutingDecision(
  text: string,
): KodaXTaskRoutingDecision | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<KodaXTaskRoutingDecision>;
    const primaryTask = isTaskType(parsed.primaryTask) ? parsed.primaryTask : null;
    const riskLevel = isRiskLevel(parsed.riskLevel) ? parsed.riskLevel : null;
    const recommendedMode = isExecutionMode(parsed.recommendedMode)
      ? parsed.recommendedMode
      : null;
    const recommendedThinkingDepth = isThinkingDepth(parsed.recommendedThinkingDepth)
      ? parsed.recommendedThinkingDepth
      : null;
    const confidence =
      typeof parsed.confidence === 'number' &&
      parsed.confidence >= 0 &&
      parsed.confidence <= 1
        ? parsed.confidence
        : null;

    if (
      !primaryTask ||
      !riskLevel ||
      !recommendedMode ||
      !recommendedThinkingDepth ||
      confidence === null
    ) {
      return null;
    }

    return {
      primaryTask,
      secondaryTask: isTaskType(parsed.secondaryTask)
        ? parsed.secondaryTask
        : undefined,
      confidence,
      riskLevel,
      recommendedMode,
      recommendedThinkingDepth,
      complexity: isTaskComplexity(parsed.complexity)
        ? parsed.complexity
        : 'moderate',
      workIntent: isTaskWorkIntent(parsed.workIntent)
        ? parsed.workIntent
        : 'new',
      requiresBrainstorm: typeof parsed.requiresBrainstorm === 'boolean'
        ? parsed.requiresBrainstorm
        : false,
      harnessProfile: isHarnessProfile(parsed.harnessProfile)
        ? parsed.harnessProfile
        : 'H1_EXECUTE_EVAL',
      routingNotes: Array.isArray(parsed.routingNotes)
        ? parsed.routingNotes.filter((note): note is string =>
          typeof note === 'string' && note.trim().length > 0,
        )
        : undefined,
      reason:
        typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim()
          : 'Router returned a structured routing decision.',
    };
  } catch (error) {
    logRoutingDebug('routing decision parser', error);
    return null;
  }
}

function parseAutoRerouteDecision(
  text: string,
): AutoRerouteDecision | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<AutoRerouteDecision>;
    if (typeof parsed.shouldReroute !== 'boolean') {
      return null;
    }

    const nextPrimaryTask = isTaskType(parsed.nextPrimaryTask)
      ? parsed.nextPrimaryTask
      : undefined;
    const nextRecommendedMode = isExecutionMode(parsed.nextRecommendedMode)
      ? parsed.nextRecommendedMode
      : undefined;
    const nextThinkingDepth = isEscalationDepth(parsed.nextThinkingDepth)
      ? parsed.nextThinkingDepth
      : undefined;
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim()
        : parsed.shouldReroute
          ? 'The reroute judge recommended a stronger second pass.'
          : 'The reroute judge found no need to rerun the response.';

    return {
      shouldReroute: parsed.shouldReroute,
      nextPrimaryTask,
      nextRecommendedMode,
      nextThinkingDepth,
      reason,
    };
  } catch (error) {
    logRoutingDebug('auto reroute parser', error);
    return null;
  }
}

function normalizeAutoRerouteDecision(
  currentPlan: ReasoningPlan,
  decision: AutoRerouteDecision,
  allowances: {
    allowDepthEscalation: boolean;
    allowTaskReroute: boolean;
  },
): {
  kind: ReasoningFollowUpKind;
  nextPrimaryTask: KodaXTaskType;
  nextRecommendedMode: KodaXExecutionMode;
  nextThinkingDepth: Exclude<KodaXThinkingDepth, 'off'>;
  reason: string;
} | null {
  if (!decision.shouldReroute) {
    return null;
  }

  if (allowances.allowTaskReroute) {
    const reroute = normalizeTaskRerouteDecision(currentPlan, decision);
    if (reroute) {
      return {
        kind: 'task-reroute',
        ...reroute,
      };
    }
  }

  if (allowances.allowDepthEscalation) {
    const depthEscalation = normalizeDepthEscalationDecision(
      currentPlan,
      decision,
    );
    if (depthEscalation) {
      return {
        kind: 'depth-escalation',
        ...depthEscalation,
      };
    }
  }

  return null;
}

function normalizeTaskRerouteDecision(
  currentPlan: ReasoningPlan,
  decision: AutoRerouteDecision,
): {
  nextPrimaryTask: KodaXTaskType;
  nextRecommendedMode: KodaXExecutionMode;
  nextThinkingDepth: Exclude<KodaXThinkingDepth, 'off'>;
  reason: string;
} | null {
  const nextMode = decision.nextRecommendedMode ?? currentPlan.decision.recommendedMode;
  const nextTask = decision.nextPrimaryTask ?? currentPlan.decision.primaryTask;
  const nextDepth = decision.nextThinkingDepth ?? escalateThinkingDepth(currentPlan.depth);
  const currentDepthRank = THINKING_DEPTH_ORDER[currentPlan.depth];
  const nextDepthRank = THINKING_DEPTH_ORDER[nextDepth];
  const modeChanged = nextMode !== currentPlan.decision.recommendedMode;
  const taskChanged = nextTask !== currentPlan.decision.primaryTask;

  if (!taskChanged && !modeChanged) {
    return null;
  }

  if (
    nextMode === 'investigation' &&
    currentPlan.decision.recommendedMode !== 'pr-review'
  ) {
    return null;
  }

  const stabilizedDepth =
    nextDepthRank < currentDepthRank
      ? ensureMinimumDepth(currentPlan.depth, 'low')
      : nextDepth;

  return {
    nextPrimaryTask: nextMode === 'investigation' ? 'bugfix' : nextTask,
    nextRecommendedMode: nextMode,
    nextThinkingDepth:
      nextMode === 'investigation'
        ? ensureMinimumDepth(stabilizedDepth, 'medium')
        : stabilizedDepth,
    reason: decision.reason,
  };
}

function normalizeDepthEscalationDecision(
  currentPlan: ReasoningPlan,
  decision: AutoRerouteDecision,
): {
  nextPrimaryTask: KodaXTaskType;
  nextRecommendedMode: KodaXExecutionMode;
  nextThinkingDepth: Exclude<KodaXThinkingDepth, 'off'>;
  reason: string;
} | null {
  const nextMode = decision.nextRecommendedMode ?? currentPlan.decision.recommendedMode;
  const nextTask = decision.nextPrimaryTask ?? currentPlan.decision.primaryTask;
  const nextDepth = decision.nextThinkingDepth ?? escalateThinkingDepth(currentPlan.depth);
  const currentDepthRank = THINKING_DEPTH_ORDER[currentPlan.depth];
  const nextDepthRank = THINKING_DEPTH_ORDER[nextDepth];

  if (
    nextMode !== currentPlan.decision.recommendedMode ||
    nextTask !== currentPlan.decision.primaryTask
  ) {
    return null;
  }

  if (nextDepthRank <= currentDepthRank) {
    return null;
  }

  return {
    nextPrimaryTask: nextTask,
    nextRecommendedMode: nextMode,
    nextThinkingDepth: nextDepth,
    reason: decision.reason,
  };
}

async function buildRepositoryRoutingSummary(
  gitRoot?: string,
  providerPolicy?: KodaXProviderPolicyDecision,
  routingEvidence?: RoutingEvidenceInput,
): Promise<string> {
  const parts: string[] = [];
  if (!gitRoot) {
    parts.push('- git: unavailable');
  } else {
    const status = await runCommand('git status --short', gitRoot);
    const diffStat = await runCommand('git diff --stat', gitRoot);
    const changedFiles = await runCommand('git diff --name-only', gitRoot);

    if (status) {
      parts.push(`- git status: ${status.split('\n').slice(0, 5).join(' | ')}`);
    }

    if (diffStat) {
      parts.push(`- diff stat: ${diffStat.split('\n').slice(0, 3).join(' | ')}`);
    }

    if (changedFiles) {
      parts.push(
        `- changed files: ${changedFiles.split('\n').slice(0, 8).join(', ')}`,
      );
    }
  }

  const recentEvidence = summarizeRoutingEvidence(routingEvidence);
  if (recentEvidence.length > 0) {
    parts.push(...recentEvidence);
  }

  if (providerPolicy) {
    parts.push(
      [
        `- provider semantics: ${providerPolicy.snapshot.provider}${providerPolicy.snapshot.model ? `/${providerPolicy.snapshot.model}` : ''}`,
        `transport=${providerPolicy.snapshot.transport}`,
        `context=${providerPolicy.snapshot.contextFidelity}`,
        `toolCalling=${providerPolicy.snapshot.toolCallingFidelity}`,
        `session=${providerPolicy.snapshot.sessionSupport}`,
        `longRunning=${providerPolicy.snapshot.longRunningSupport}`,
        `multimodal=${providerPolicy.snapshot.multimodalSupport}`,
        `evidence=${providerPolicy.snapshot.evidenceSupport}`,
        `mcp=${providerPolicy.snapshot.mcpSupport}`,
        `reasoning=${providerPolicy.snapshot.reasoningCapability}`,
      ].join('; '),
    );

    for (const issue of providerPolicy.issues) {
      parts.push(`- provider constraint (${issue.severity}): ${issue.summary}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : '- git: clean or unavailable';
}

async function runCommand(
  command: string,
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await execAsync(command, {
      cwd,
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    logRoutingDebug(`repository command (${command})`, error);
    return '';
  }
}

function summarizeRoutingEvidence(
  routingEvidence?: RoutingEvidenceInput,
): string[] {
  if (!routingEvidence) {
    return [];
  }

  const parts = new Set<string>();
  for (const line of summarizeRecentMessageEvidence(routingEvidence.recentMessages ?? [])) {
    parts.add(line);
  }

  const sessionError = routingEvidence.sessionErrorMetadata?.lastError?.trim();
  if (sessionError && looksLikeRuntimeEvidence(sessionError)) {
    parts.add(`- recent session error: ${truncateEvidence(sessionError)}`);
  }

  for (const signal of routingEvidence.additionalSignals ?? []) {
    const normalized = signal.trim();
    if (!normalized || !looksLikeRuntimeEvidence(normalized)) {
      continue;
    }
    parts.add(`- runtime evidence: ${truncateEvidence(normalized)}`);
  }

  return Array.from(parts).slice(0, 6);
}

function summarizeRecentMessageEvidence(messages: KodaXMessage[]): string[] {
  const evidence: string[] = [];
  const recentMessages = messages.slice(-8);

  for (const message of recentMessages) {
    if (typeof message.content === 'string') {
      if (looksLikeRuntimeEvidence(message.content)) {
        evidence.push(`- recent message evidence: ${truncateEvidence(message.content)}`);
      }
      continue;
    }

    for (const block of message.content) {
      if (block.type === 'tool_result' && looksLikeRuntimeEvidence(block.content)) {
        evidence.push(`- recent tool result: ${truncateEvidence(block.content)}`);
      } else if (block.type === 'text' && looksLikeRuntimeEvidence(block.text)) {
        evidence.push(`- recent assistant evidence: ${truncateEvidence(block.text)}`);
      }
    }
  }

  return Array.from(new Set(evidence)).slice(0, 4);
}

function looksLikeRuntimeEvidence(text: string): boolean {
  return looksLikeActionableRuntimeEvidence(text);
}

function truncateEvidence(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function buildWorkIntentGuidance(workIntent: KodaXTaskWorkIntent): string {
  switch (workIntent) {
    case 'append':
      return 'Extend or continue the existing artifact without rewriting stable parts unnecessarily.';
    case 'overwrite':
      return 'A substantial rewrite or replacement is expected, but keep the boundaries and consequences explicit.';
    case 'new':
    default:
      return 'Treat this as net-new work unless repo evidence proves the request is really an append or rewrite.';
  }
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

function selectHarnessProfile(
  prompt: string,
  decision: KodaXTaskRoutingDecision,
  providerPolicy?: KodaXProviderPolicyDecision,
): {
  harnessProfile: KodaXHarnessProfile;
  notes: string[];
} {
  const normalized = ` ${prompt.toLowerCase()} `;
  let harnessProfile: KodaXHarnessProfile;

  if (
    textHasKeyword(normalized, 'multi-agent') ||
    textHasKeyword(normalized, 'parallel') ||
    textHasKeyword(normalized, 'across the monorepo') ||
    decision.complexity === 'systemic'
  ) {
    harnessProfile = 'H3_MULTI_WORKER';
  } else if (
    decision.requiresBrainstorm ||
    decision.primaryTask === 'plan' ||
    decision.complexity === 'complex' ||
    (decision.workIntent === 'overwrite' && decision.riskLevel !== 'low')
  ) {
    harnessProfile = 'H2_PLAN_EXECUTE_EVAL';
  } else if (
    decision.primaryTask === 'review' ||
    decision.primaryTask === 'bugfix' ||
    decision.riskLevel !== 'low' ||
    decision.complexity === 'moderate'
  ) {
    harnessProfile = 'H1_EXECUTE_EVAL';
  } else {
    harnessProfile = 'H0_DIRECT';
  }

  const notes: string[] = [];
  const snapshot = providerPolicy?.snapshot;
  if (snapshot && harnessProfile === 'H3_MULTI_WORKER') {
    if (
      snapshot.contextFidelity === 'lossy' ||
      snapshot.sessionSupport === 'stateless' ||
      snapshot.toolCallingFidelity === 'none' ||
      snapshot.evidenceSupport === 'none'
    ) {
      harnessProfile = 'H1_EXECUTE_EVAL';
      notes.push('Downgraded from H3 to H1 because provider semantics are too lossy for multi-worker coordination.');
    } else if (
      snapshot.toolCallingFidelity === 'limited' ||
      snapshot.evidenceSupport === 'limited' ||
      snapshot.transport === 'cli-bridge'
    ) {
      harnessProfile = 'H2_PLAN_EXECUTE_EVAL';
      notes.push('Downgraded from H3 to H2 because provider semantics may lose coordination or evidence fidelity.');
    }
  }

  return {
    harnessProfile,
    notes,
  };
}

function getDefaultDepthForTask(taskType: KodaXTaskType): KodaXThinkingDepth {
  switch (taskType) {
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

function isEscalationDepth(
  value: unknown,
): value is Exclude<KodaXThinkingDepth, 'off'> {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isRiskLevel(value: unknown): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high';
}

function stabilizeRoutingDecision(
  prompt: string,
  decision: KodaXTaskRoutingDecision,
  providerPolicy?: KodaXProviderPolicyDecision,
): KodaXTaskRoutingDecision {
  let stabilized = decision;

  if (decision.primaryTask === 'unknown') {
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
  const complexity = inferComplexity(
    prompt,
    {
      ...stabilized,
      workIntent,
    },
  );
  const requiresBrainstorm = inferRequiresBrainstorm(
    prompt,
    {
      ...stabilized,
      workIntent,
      complexity,
    },
    complexity,
  );
  const harnessDecision = selectHarnessProfile(
    prompt,
    {
      ...stabilized,
      workIntent,
      complexity,
      requiresBrainstorm,
    },
    providerPolicy,
  );

  return {
    ...stabilized,
    workIntent,
    complexity,
    requiresBrainstorm,
    harnessProfile: harnessDecision.harnessProfile,
    routingNotes: [
      ...(stabilized.routingNotes ?? []),
      ...harnessDecision.notes,
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
    value === 'H2_PLAN_EXECUTE_EVAL' ||
    value === 'H3_MULTI_WORKER'
  );
}
