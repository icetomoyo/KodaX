import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  KodaXExecutionMode,
  KodaXMessage,
  KodaXOptions,
  KodaXReasoningMode,
  SessionErrorMetadata,
  KodaXTaskRoutingDecision,
  KodaXTaskType,
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

const ROUTER_SYSTEM_PROMPT = [
  'You are a task router for a coding agent.',
  'Classify the user request into one primary task and an optional secondary task.',
  'Return valid JSON only.',
  'Allowed primaryTask and secondaryTask values: review, bugfix, edit, refactor, plan, qa, unknown.',
  'Allowed riskLevel values: low, medium, high.',
  'Allowed recommendedMode values: pr-review, strict-audit, implementation, planning, investigation.',
  'Allowed recommendedThinkingDepth values: off, low, medium, high.',
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

export interface ReasoningPlan {
  mode: KodaXReasoningMode;
  depth: KodaXThinkingDepth;
  decision: KodaXTaskRoutingDecision;
  promptOverlay: string;
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
): KodaXTaskRoutingDecision {
  const inferred = inferTaskSignal(prompt);
  const primaryTask = inferred.task;
  return {
    primaryTask,
    confidence: inferred.confidence,
    riskLevel: getRiskLevel(prompt, primaryTask),
    recommendedMode: getExecutionModeForTask(primaryTask),
    recommendedThinkingDepth: getDefaultDepthForTask(primaryTask),
    reason: inferred.reason,
  };
}

export function buildPromptOverlay(
  decision: KodaXTaskRoutingDecision,
  extraNotes: string[] = [],
): string {
  return [
    EXECUTION_MODE_OVERLAYS[decision.recommendedMode],
    `[Task Routing] primary=${decision.primaryTask}; risk=${decision.riskLevel}; confidence=${decision.confidence.toFixed(2)}.`,
    `[Task Routing Reason] ${decision.reason}`,
    ...extraNotes,
  ].join('\n');
}

export async function createReasoningPlan(
  options: KodaXOptions,
  prompt: string,
  provider: KodaXBaseProvider,
  routingEvidence?: RoutingEvidenceInput,
): Promise<ReasoningPlan> {
  const mode = resolveReasoningMode(options);

  if (mode === 'auto') {
    const decision = await routeTaskWithLLM(provider, prompt, options, routingEvidence);
    return {
      mode,
      depth: decision.recommendedThinkingDepth,
      promptOverlay: buildPromptOverlay(decision),
      decision,
    };
  }

  const fallbackDecision = buildFallbackRoutingDecision(prompt);
  const depth = mode === 'off' ? 'off' : reasoningModeToDepth(mode);
  const decision: KodaXTaskRoutingDecision = {
    ...fallbackDecision,
    recommendedThinkingDepth: depth,
  };

  return {
    mode,
    depth,
    promptOverlay: buildPromptOverlay(decision),
    decision,
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

  const nextDecision = {
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
  } satisfies KodaXTaskRoutingDecision;

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
    promptOverlay: buildPromptOverlay(nextDecision, [
      followUpGuidance,
      `${followUpLabel} Focus on high-confidence, high-signal output for this follow-up pass.`,
    ]),
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
  routingEvidence?: RoutingEvidenceInput,
): Promise<KodaXTaskRoutingDecision> {
  const fallback = buildFallbackRoutingDecision(prompt);
  const repoSummary = await buildRepositoryRoutingSummary(
    options.context?.gitRoot ?? undefined,
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
    return stabilizeRoutingDecision(prompt, parsed ?? fallback);
  } catch (error) {
    logRoutingDebug('task router', error);
    return stabilizeRoutingDecision(prompt, fallback);
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
): KodaXTaskRoutingDecision {
  if (decision.primaryTask === 'unknown') {
    return {
      ...decision,
      recommendedMode: 'implementation',
      recommendedThinkingDepth: 'medium',
      reason: `${decision.reason} Conservative fallback keeps balanced reasoning for ambiguous tasks.`,
    };
  }

  if (decision.primaryTask === 'qa' && decision.confidence < LOW_CONFIDENCE_QA_THRESHOLD) {
    return {
      primaryTask: 'unknown',
      confidence: Math.min(decision.confidence, LOW_CONFIDENCE_QA_CAP),
      riskLevel: getRiskLevel(prompt, 'unknown'),
      recommendedMode: 'implementation',
      recommendedThinkingDepth: 'medium',
      reason: `${decision.reason} Low-confidence QA routing was downgraded to unknown so reasoning stays available.`,
    };
  }

  if (decision.confidence < LOW_CONFIDENCE_OFF_THRESHOLD && decision.recommendedThinkingDepth === 'off') {
    return {
      ...decision,
      primaryTask: 'unknown',
      recommendedMode: 'implementation',
      recommendedThinkingDepth: 'medium',
      reason: `${decision.reason} Low-confidence off-mode routing was upgraded to balanced reasoning for safety.`,
    };
  }

  return decision;
}
