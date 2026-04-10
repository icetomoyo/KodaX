import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  KodaXAmaControllerDecision,
  KodaXAmaFanoutClass,
  KodaXAmaProfile,
  KodaXAmaTactic,
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
  conversation: [
    '[Execution Mode: conversation]',
    '- Answer conversationally and directly.',
    '- Do not expand into repo analysis, planning, or tool-heavy investigation unless the user asks for work.',
  ].join('\n'),
  lookup: [
    '[Execution Mode: lookup]',
    '- Answer the navigation or lookup question directly.',
    '- Prefer precise paths, symbols, or locations over broad commentary.',
    '- Do not escalate into planning or validation ceremony unless the user explicitly asks for deeper analysis.',
  ].join('\n'),
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
};

const ROUTER_SYSTEM_PROMPT = [
  'You are a task router for a coding agent.',
  'Classify the user request into one primary task and an optional secondary task.',
  'Return valid JSON only.',
  'Allowed primaryTask and secondaryTask values: conversation, lookup, review, bugfix, edit, refactor, plan, qa, unknown.',
  'Allowed taskFamily values: conversation, lookup, review, implementation, investigation, planning, ambiguous.',
  'Allowed actionability values: non_actionable, actionable, ambiguous.',
  'Allowed mutationSurface values: read-only, docs-only, code, system.',
  'Allowed assuranceIntent values: default, explicit-check.',
  'Allowed riskLevel values: low, medium, high.',
  'Allowed recommendedMode values: conversation, lookup, pr-review, strict-audit, implementation, planning, investigation.',
  'Allowed recommendedThinkingDepth values: off, low, medium, high.',
  'Allowed complexity values: simple, moderate, complex, systemic.',
  'Allowed workIntent values: append, overwrite, new.',
  'Allowed executionPattern values: direct, checked-direct, coordinated.',
  'Allowed harnessProfile values: H0_DIRECT, H1_EXECUTE_EVAL, H2_PLAN_EXECUTE_EVAL.',
  'Allowed topologyCeiling values: H0_DIRECT, H1_EXECUTE_EVAL, H2_PLAN_EXECUTE_EVAL.',
  'requiresBrainstorm must be a boolean.',
  'soloBoundaryConfidence must be a number between 0 and 1.',
  'needsIndependentQA must be a boolean.',
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

const STRUCTURED_DECISION_MAX_ATTEMPTS = 3;
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
  mode: KodaXReasoningMode;
  depth: KodaXThinkingDepth;
  decision: KodaXTaskRoutingDecision;
  amaControllerDecision: KodaXAmaControllerDecision;
  promptOverlay: string;
  providerPolicy?: KodaXProviderPolicyDecision;
}

export interface RoutingEvidenceInput {
  recentMessages?: KodaXMessage[];
  sessionErrorMetadata?: SessionErrorMetadata;
  additionalSignals?: string[];
  repoSignals?: KodaXRepoRoutingSignals;
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

const REVIEW_LARGE_FILE_THRESHOLD = 10;
const REVIEW_LARGE_LINE_THRESHOLD = 1200;
const REVIEW_LARGE_MODULE_THRESHOLD = 3;
const REVIEW_MASSIVE_FILE_THRESHOLD = 30;
const REVIEW_MASSIVE_LINE_THRESHOLD = 4000;
const REVIEW_MASSIVE_MODULE_THRESHOLD = 5;

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
  shouldUseModelRouter: boolean;
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
      shouldUseModelRouter: false,
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
      shouldUseModelRouter: false,
      reason: 'Pure greeting input should stay conversational and must not be escalated by repository state.',
    };
  }

  const hasLookupSignal = LOOKUP_PATTERN.test(trimmed) || LOOKUP_PATTERN_ZH_CLEAN.test(trimmed);
  const hasReviewSignal = REVIEW_PATTERN.test(trimmed) || REVIEW_PATTERN_ZH_CLEAN.test(trimmed);
  const hasPlanSignal = PLAN_PATTERN.test(trimmed) || PLAN_PATTERN_ZH_CLEAN.test(trimmed);
  const hasInvestigationSignal = INVESTIGATION_PATTERN.test(trimmed) || INVESTIGATION_PATTERN_ZH_CLEAN.test(trimmed);
  const hasImplementationSignal = IMPLEMENTATION_PATTERN.test(trimmed) || IMPLEMENTATION_PATTERN_ZH_CLEAN.test(trimmed);

  if (hasReviewSignal) {
    return {
      primaryTask: 'review',
      taskFamily: 'review',
      actionability: 'actionable',
      executionPattern: 'checked-direct',
      shouldUseRepoSignals: true,
      shouldUseModelRouter: false,
      reason: 'Explicit review language should stay on the lightweight review path unless later evidence explicitly justifies stronger assurance.',
    };
  }

  if (hasPlanSignal) {
    return {
      primaryTask: 'plan',
      taskFamily: 'planning',
      actionability: 'actionable',
      executionPattern: 'coordinated',
      shouldUseRepoSignals: true,
      shouldUseModelRouter: true,
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
      shouldUseModelRouter: true,
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
      shouldUseModelRouter: true,
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
      shouldUseModelRouter: false,
      reason: 'Pure codebase lookup/navigation queries should stay on the direct path.',
    };
  }

  return {
    primaryTask: 'unknown',
    taskFamily: 'ambiguous',
    actionability: 'ambiguous',
    executionPattern: 'direct',
    shouldUseRepoSignals: false,
    shouldUseModelRouter: false,
    reason: 'Ambiguous requests stay lightweight until there is stronger task evidence.',
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

function deriveTopologyCeiling(
  mutationSurface: KodaXMutationSurface,
  assuranceIntent: KodaXAssuranceIntent,
): KodaXHarnessProfile {
  if (mutationSurface === 'read-only' || mutationSurface === 'docs-only') {
    return assuranceIntent === 'explicit-check'
      ? 'H1_EXECUTE_EVAL'
      : 'H0_DIRECT';
  }

  return 'H2_PLAN_EXECUTE_EVAL';
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

function logRoutingDebug(scope: string, error: unknown): void {
  if (!isRoutingDebugEnabled()) {
    return;
  }

  console.error(`[Routing] ${scope} failed:`, error);
}

export function buildFallbackRoutingDecision(
  prompt: string,
  providerPolicy?: KodaXProviderPolicyDecision,
  routingEvidence?: RoutingEvidenceInput,
): KodaXTaskRoutingDecision {
  const gate = inferIntentGate(prompt);
  if (!gate.shouldUseModelRouter) {
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
    harnessProfile: 'H1_EXECUTE_EVAL',
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

function dedupeAmaTactics(
  tactics: KodaXAmaTactic[],
): KodaXAmaTactic[] {
  return Array.from(new Set(tactics));
}

function resolveAmaFanoutClass(
  decision: KodaXTaskRoutingDecision,
): KodaXAmaFanoutClass | undefined {
  if (decision.primaryTask === 'review') {
    return 'finding-validation';
  }
  if (
    decision.primaryTask === 'bugfix'
    || decision.recommendedMode === 'investigation'
  ) {
    return decision.mutationSurface === 'read-only'
      ? 'evidence-scan'
      : 'hypothesis-check';
  }
  if (decision.primaryTask === 'lookup') {
    return 'module-triage';
  }
  return undefined;
}

function resolveAmaFanoutMaxChildren(
  decision: KodaXTaskRoutingDecision,
): number | undefined {
  if (decision.primaryTask === 'review') {
    switch (decision.reviewScale) {
      case 'massive':
        return 4;
      case 'large':
        return 3;
      default:
        return 2;
    }
  }
  if (
    decision.primaryTask === 'bugfix'
    || decision.recommendedMode === 'investigation'
  ) {
    return 2;
  }
  return undefined;
}

function isAmaFanoutClassActive(
  fanoutClass: KodaXAmaFanoutClass | undefined,
  decision: KodaXTaskRoutingDecision,
): boolean {
  if (!fanoutClass) {
    return false;
  }

  if (
    decision.primaryTask === 'plan'
    || decision.taskFamily === 'conversation'
    || decision.taskFamily === 'ambiguous'
  ) {
    return false;
  }

  switch (fanoutClass) {
    case 'finding-validation':
      return true;
    case 'evidence-scan':
      return decision.mutationSurface === 'read-only'
        && decision.harnessProfile === 'H0_DIRECT'
        && (
          decision.primaryTask === 'bugfix'
          || decision.recommendedMode === 'investigation'
        );
    case 'module-triage':
      return decision.mutationSurface === 'read-only'
        && decision.harnessProfile === 'H0_DIRECT'
        && decision.executionPattern === 'checked-direct'
        && decision.primaryTask === 'lookup';
    case 'hypothesis-check':
      return false;
    default:
      return false;
  }
}

export function buildAmaControllerDecision(
  decision: KodaXTaskRoutingDecision,
): KodaXAmaControllerDecision {
  const readOnlyLike = decision.mutationSurface === 'read-only'
    || decision.mutationSurface === 'docs-only';
  const managed =
    decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
    || decision.primaryTask === 'plan'
    || decision.complexity === 'systemic'
    || (
      decision.complexity === 'complex'
      && decision.mutationSurface === 'code'
      && Boolean(decision.needsIndependentQA)
    )
    || (
      decision.requiresBrainstorm
      && decision.mutationSurface === 'code'
    );
  const profile: KodaXAmaProfile = managed ? 'managed' : 'tactical';
  const fanoutClass = resolveAmaFanoutClass(decision);
  const activeFanoutClass = profile === 'tactical' && isAmaFanoutClassActive(fanoutClass, decision)
    ? fanoutClass
    : undefined;
  const fanoutAdmissible = Boolean(activeFanoutClass);

  const tactics = dedupeAmaTactics([
    'direct',
    ...(profile === 'managed' ? ['planning-pass', 'verification-pass', 'repair-loop'] as KodaXAmaTactic[] : []),
    ...(decision.harnessProfile !== 'H0_DIRECT' || Boolean(decision.needsIndependentQA) ? ['verification-pass'] as KodaXAmaTactic[] : []),
    ...(fanoutAdmissible ? ['child-fanout'] as KodaXAmaTactic[] : []),
  ]);

  const fanoutReason = !fanoutClass
    ? 'No high-value shard class was detected for this task.'
    : !fanoutAdmissible
      ? fanoutClass === 'hypothesis-check'
        ? 'Hypothesis-check shards remain defined for future rollout, but mutation-side child fan-out is intentionally disabled for now.'
        : fanoutClass === 'evidence-scan'
          ? 'Evidence-scan shards only activate for tactical H0 read-only investigation in the current rollout.'
        : fanoutClass === 'module-triage'
            ? 'Module-triage shards only activate for tactical H0 read-only lookup in the current rollout.'
        : 'Child fan-out stays disabled because this rollout only activates read-only tactical shard classes that are already backed by runtime support.'
      : activeFanoutClass === 'finding-validation'
        ? 'Review work benefits from finding-level validation shards to keep the main context focused on synthesis.'
        : activeFanoutClass === 'evidence-scan'
          ? 'Investigation work benefits from bounded evidence shards before the parent commits to a diagnosis.'
          : activeFanoutClass === 'module-triage'
            ? 'Lookup work can shard module triage when the task stays read-only.'
            : 'Investigation work benefits from hypothesis-check shards when multiple explanations can be tested independently.';

  const upgradeTriggers: string[] = [];
  if (profile === 'tactical') {
    if (decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL') {
      upgradeTriggers.push('Existing routing already requires H2 managed coordination.');
    }
    if (decision.complexity === 'complex' || decision.complexity === 'systemic') {
      upgradeTriggers.push('Complex or systemic work may outgrow tactical reduction and need managed coordination.');
    }
    if (decision.requiresBrainstorm) {
      upgradeTriggers.push('Explicit option framing or plan-first work should upgrade into managed planning.');
    }
  } else {
    upgradeTriggers.push('Managed profile stays active because the task needs explicit planning, QA, or multi-round convergence.');
  }

  return {
    profile,
    tactics,
    fanout: {
      admissible: fanoutAdmissible,
      class: activeFanoutClass,
      reason: fanoutReason,
      maxChildren: fanoutAdmissible ? resolveAmaFanoutMaxChildren(decision) : undefined,
      requiresReadOnly: fanoutAdmissible && readOnlyLike ? true : undefined,
    },
    reason: profile === 'managed'
      ? 'AMA controller selected the managed profile because explicit coordination, planning, or heavier assurance remains load-bearing.'
      : 'AMA controller selected the tactical profile so one main agent can stay in control while using hidden tactics only when they reduce context pressure.',
    upgradeTriggers,
  };
}

function buildAmaControllerOverlay(
  controller: KodaXAmaControllerDecision,
): string {
  return [
    `[AMA Controller] profile=${controller.profile}; tactics=${controller.tactics.join(',')}; fanoutAdmissible=${controller.fanout.admissible ? 'yes' : 'no'}; fanoutClass=${controller.fanout.class ?? 'none'}; maxChildren=${controller.fanout.maxChildren ?? 'n/a'}.`,
    `[AMA Controller Reason] ${controller.reason}`,
    `[AMA Fan-Out] ${controller.fanout.reason}`,
    controller.upgradeTriggers.length > 0
      ? `[AMA Upgrade Triggers] ${controller.upgradeTriggers.join(' ')}`
      : undefined,
  ].filter(Boolean).join('\n');
}

export function buildPromptOverlay(
  decision: KodaXTaskRoutingDecision,
  extraNotes: string[] = [],
  _providerPolicy?: KodaXProviderPolicyDecision,
  amaControllerDecision: KodaXAmaControllerDecision = buildAmaControllerDecision(decision),
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
    buildAmaControllerOverlay(amaControllerDecision),
    `[Task Routing] primary=${decision.primaryTask}; family=${decision.taskFamily ?? 'unknown'}; actionability=${decision.actionability ?? 'unknown'}; mutationSurface=${decision.mutationSurface ?? 'unknown'}; assuranceIntent=${decision.assuranceIntent ?? 'default'}; pattern=${decision.executionPattern ?? 'unknown'}; risk=${decision.riskLevel}; complexity=${decision.complexity}; intent=${decision.workIntent}; brainstorm=${decision.requiresBrainstorm ? 'yes' : 'no'}; harness=${decision.harnessProfile}; topologyCeiling=${decision.topologyCeiling ?? 'none'}; upgradeCeiling=${decision.upgradeCeiling ?? 'none'}; reviewScale=${decision.reviewScale ?? 'unknown'}; confidence=${decision.confidence.toFixed(2)}.`,
    decision.soloBoundaryConfidence !== undefined
      ? `[Task Routing Signals] soloBoundaryConfidence=${decision.soloBoundaryConfidence.toFixed(2)}; needsIndependentQA=${decision.needsIndependentQA ? 'yes' : 'no'}; source=${decision.routingSource ?? 'unknown'}; attempts=${decision.routingAttempts ?? 1}.`
      : undefined,
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
  const intentGate = inferIntentGate(prompt);
  const providerPolicy = evaluateProviderPolicy({
    providerName: provider.name,
    model: options.modelOverride ?? options.model,
    provider,
    prompt,
    options,
    reasoningMode: mode,
  });

  if (!intentGate.shouldUseModelRouter) {
    const decision = buildFallbackRoutingDecision(
      prompt,
      providerPolicy,
      routingEvidence,
    );
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
      ],
    };
    const amaControllerDecision = buildAmaControllerDecision(finalDecision);

    return {
      mode,
      depth,
      amaControllerDecision,
      promptOverlay: buildPromptOverlay(
        finalDecision,
        providerPolicy.routingNotes,
        providerPolicy,
        amaControllerDecision,
      ),
      decision: finalDecision,
      providerPolicy,
    };
  }

  if (mode === 'auto') {
    const decision = await routeTaskWithLLM(
      provider,
      prompt,
      options,
      providerPolicy,
      routingEvidence,
    );
    const amaControllerDecision = buildAmaControllerDecision(decision);
    return {
      mode,
      depth: decision.recommendedThinkingDepth,
      amaControllerDecision,
      promptOverlay: buildPromptOverlay(
        decision,
        providerPolicy.routingNotes,
        providerPolicy,
        amaControllerDecision,
      ),
      decision,
      providerPolicy,
    };
  }

  const fallbackDecision = buildFallbackRoutingDecision(
    prompt,
    providerPolicy,
    routingEvidence,
  );
  const depth = mode === 'off' ? 'off' : reasoningModeToDepth(mode);
  const decision: KodaXTaskRoutingDecision = {
    ...fallbackDecision,
    recommendedThinkingDepth: depth,
  };
  const amaControllerDecision = buildAmaControllerDecision(decision);

  return {
    mode,
    depth,
    amaControllerDecision,
    promptOverlay: buildPromptOverlay(
      decision,
      providerPolicy.routingNotes,
      providerPolicy,
      amaControllerDecision,
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
    amaControllerDecision: buildAmaControllerDecision(nextDecision),
    providerPolicy: currentPlan.providerPolicy,
    promptOverlay: buildPromptOverlay(nextDecision, [
      followUpGuidance,
      `${followUpLabel} Focus on high-confidence, high-signal output for this follow-up pass.`,
    ], currentPlan.providerPolicy, buildAmaControllerDecision(nextDecision)),
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
  const fallback = buildFallbackRoutingDecision(prompt, providerPolicy, routingEvidence);
  const repoSummary = await buildRepositoryRoutingSummary(
    options.context?.gitRoot ?? undefined,
    providerPolicy,
    routingEvidence,
  );
  const decision = await retryStructuredDecision('task router', options, async () => {
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
    return parseRoutingDecision(raw);
  });

  if (!decision.value) {
    return stabilizeRoutingDecision(prompt, {
      ...fallback,
      routingSource: decision.retried ? 'retried-fallback' : 'fallback',
      routingAttempts: decision.attempts,
      routingNotes: [
        ...(fallback.routingNotes ?? []),
        `Structured router fell back after ${decision.attempts} attempt${decision.attempts === 1 ? '' : 's'}.`,
      ],
    }, providerPolicy, routingEvidence);
  }

  return stabilizeRoutingDecision(prompt, {
    ...decision.value,
    routingSource: decision.retried ? 'retried-model' : 'model',
    routingAttempts: decision.attempts,
  }, providerPolicy, routingEvidence);
}

function clampUnitInterval(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function createErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function waitForStructuredDecisionBackoff(
  attempt: number,
  signal?: AbortSignal,
): Promise<void> {
  const delayMs = Math.min(1500, 250 * 2 ** Math.max(0, attempt - 1));
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Structured decision retry aborted.'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    function onAbort(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Structured decision retry aborted.'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isNonRetryableStructuredDecisionError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }

  const message = createErrorMessage(error).toLowerCase();
  return (
    message.includes('aborted')
    || message.includes('aborterror')
    || message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('authentication')
    || message.includes('invalid request')
    || message.includes('not supported')
    || message.includes('unsupported')
    || message.includes('policy')
    || message.includes('refus')
  );
}

async function retryStructuredDecision<T>(
  label: string,
  options: KodaXOptions,
  execute: () => Promise<T | null>,
): Promise<{ value: T | null; attempts: number; retried: boolean }> {
  let attempts = 0;
  let lastError: unknown;

  while (attempts < STRUCTURED_DECISION_MAX_ATTEMPTS) {
    attempts += 1;
    try {
      const value = await execute();
      if (value !== null) {
        return {
          value,
          attempts,
          retried: attempts > 1,
        };
      }
      lastError = new Error(`${label} returned invalid or incomplete structured output.`);
    } catch (error) {
      lastError = error;
      if (isNonRetryableStructuredDecisionError(error, options.abortSignal)) {
        break;
      }
    }

      if (attempts < STRUCTURED_DECISION_MAX_ATTEMPTS) {
        if (process.env.KODAX_DEBUG_ROUTING) {
          options.events?.onRetry?.(`${label} structured decision retry`, attempts, STRUCTURED_DECISION_MAX_ATTEMPTS);
        }
        await waitForStructuredDecisionBackoff(attempts, options.abortSignal);
      }
  }

  logRoutingDebug(label, lastError);
  return {
    value: null,
    attempts,
    retried: attempts > 1,
  };
}

async function judgeAutoRerouteWithLLM(
  provider: KodaXBaseProvider,
  options: KodaXOptions,
  prompt: string,
  currentPlan: ReasoningPlan,
  assistantText: string,
  evidence?: AutoRerouteEvidence,
): Promise<AutoRerouteDecision | null> {
  const decision = await retryStructuredDecision('reroute judge', options, async () => {
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
  });

  return decision.value;
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
    const soloBoundaryConfidence =
      typeof parsed.soloBoundaryConfidence === 'number'
      && parsed.soloBoundaryConfidence >= 0
      && parsed.soloBoundaryConfidence <= 1
        ? parsed.soloBoundaryConfidence
        : undefined;
    const needsIndependentQA =
      typeof parsed.needsIndependentQA === 'boolean'
        ? parsed.needsIndependentQA
        : undefined;
    const reviewScale =
      parsed.reviewScale === 'small'
      || parsed.reviewScale === 'large'
      || parsed.reviewScale === 'massive'
        ? parsed.reviewScale
        : undefined;
    const taskFamily = isTaskFamily(parsed.taskFamily)
      ? parsed.taskFamily
      : undefined;
    const actionability = isTaskActionability(parsed.actionability)
      ? parsed.actionability
      : undefined;
    const executionPattern = isExecutionPattern(parsed.executionPattern)
      ? parsed.executionPattern
      : undefined;
    const mutationSurface = isMutationSurface(parsed.mutationSurface)
      ? parsed.mutationSurface
      : undefined;
    const assuranceIntent = isAssuranceIntent(parsed.assuranceIntent)
      ? parsed.assuranceIntent
      : undefined;
    const topologyCeiling = isHarnessProfile(parsed.topologyCeiling)
      ? parsed.topologyCeiling
      : undefined;
    const upgradeCeiling = isHarnessProfile(parsed.upgradeCeiling)
      ? parsed.upgradeCeiling
      : undefined;

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
      taskFamily,
      actionability,
      executionPattern,
      mutationSurface,
      assuranceIntent,
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
      topologyCeiling,
      upgradeCeiling,
      reviewScale,
      soloBoundaryConfidence,
      needsIndependentQA,
      routingSource: parsed.routingSource === 'model'
        || parsed.routingSource === 'fallback'
        || parsed.routingSource === 'retried-model'
        || parsed.routingSource === 'retried-fallback'
        ? parsed.routingSource
        : undefined,
      routingAttempts: typeof parsed.routingAttempts === 'number' && parsed.routingAttempts > 0
        ? parsed.routingAttempts
        : undefined,
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

  const repoSignalSummary = summarizeRepoRoutingSignals(routingEvidence?.repoSignals);
  if (repoSignalSummary.length > 0) {
    parts.push(...repoSignalSummary);
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

const HARNESS_ORDER: KodaXHarnessProfile[] = [
  'H0_DIRECT',
  'H1_EXECUTE_EVAL',
  'H2_PLAN_EXECUTE_EVAL',
];

function getHarnessRank(harness: KodaXHarnessProfile): number {
  return HARNESS_ORDER.indexOf(harness);
}

function selectHarnessProfile(
  prompt: string,
  decision: KodaXTaskRoutingDecision,
  providerPolicy?: KodaXProviderPolicyDecision,
): {
  harnessProfile: KodaXHarnessProfile;
  upgradeCeiling?: KodaXHarnessProfile;
  notes: string[];
} {
  let harnessProfile: KodaXHarnessProfile;
  let upgradeCeiling = decision.upgradeCeiling;
  const taskFamily = decision.taskFamily ?? inferTaskFamilyFromPrimaryTask(decision.primaryTask);
  const actionability = decision.actionability ?? (taskFamily === 'conversation' ? 'non_actionable' : taskFamily === 'ambiguous' ? 'ambiguous' : 'actionable');
  const mutationSurface = deriveMutationSurface(prompt, {
    primaryTask: decision.primaryTask,
    taskFamily,
  });
  const assuranceIntent = deriveAssuranceIntent(prompt, decision);
  const topologyCeiling = deriveTopologyCeiling(mutationSurface, assuranceIntent);

  if (actionability !== 'actionable' || taskFamily === 'conversation' || taskFamily === 'lookup') {
    return {
      harnessProfile: 'H0_DIRECT',
      upgradeCeiling: undefined,
      notes: actionability === 'non_actionable'
        ? ['Intent gate kept a non-actionable request on the direct path.']
        : ['Intent gate kept this lightweight lookup/ambiguous request on the direct path.'],
    };
  }

  if (mutationSurface === 'read-only' || mutationSurface === 'docs-only') {
    harnessProfile = assuranceIntent === 'explicit-check'
      ? 'H1_EXECUTE_EVAL'
      : 'H0_DIRECT';
    upgradeCeiling = topologyCeiling;
  } else {
    const needsCoordinatedHarness = mutationSurface === 'system'
      ? (
        decision.requiresBrainstorm
        || decision.needsIndependentQA
        || decision.riskLevel === 'high'
        || decision.complexity === 'complex'
        || decision.complexity === 'systemic'
        || decision.workIntent === 'overwrite'
      )
      : (
        decision.requiresBrainstorm
        || decision.complexity === 'systemic'
        || (
          decision.complexity === 'complex'
          && (
            taskFamily === 'implementation'
            || decision.primaryTask === 'edit'
            || decision.primaryTask === 'refactor'
            || decision.workIntent === 'overwrite'
            || decision.needsIndependentQA
          )
        )
      );

    if (needsCoordinatedHarness) {
      harnessProfile = 'H2_PLAN_EXECUTE_EVAL';
    } else if (
      decision.needsIndependentQA
      || decision.soloBoundaryConfidence === undefined
      || decision.soloBoundaryConfidence < SOLO_BOUNDARY_DIRECT_THRESHOLD
      || decision.riskLevel !== 'low'
      || decision.complexity === 'moderate'
      || decision.workIntent === 'overwrite'
    ) {
      harnessProfile = 'H1_EXECUTE_EVAL';
    } else {
      harnessProfile = 'H0_DIRECT';
    }
    upgradeCeiling = topologyCeiling;
  }

  const notes: string[] = [];
  if (getHarnessRank(harnessProfile) > getHarnessRank(topologyCeiling)) {
    notes.push(`Topology ceiling kept the task at or below ${topologyCeiling} because ${mutationSurface} work should stay lightweight by default.`);
    harnessProfile = topologyCeiling;
    upgradeCeiling = topologyCeiling;
  }

  const snapshot = providerPolicy?.snapshot;
  if (
    snapshot
    && harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
    && (
      snapshot.contextFidelity === 'lossy'
      || snapshot.sessionSupport === 'stateless'
      || snapshot.toolCallingFidelity === 'none'
      || snapshot.evidenceSupport === 'none'
    )
  ) {
    harnessProfile = 'H1_EXECUTE_EVAL';
    upgradeCeiling = undefined;
    notes.push('Downgraded from H2 to H1 because provider semantics are too lossy for coordinated execution.');
  }

  return {
    harnessProfile,
    upgradeCeiling: harnessProfile === 'H0_DIRECT' ? undefined : upgradeCeiling,
    notes,
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

function isEscalationDepth(
  value: unknown,
): value is Exclude<KodaXThinkingDepth, 'off'> {
  return value === 'low' || value === 'medium' || value === 'high';
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
    repoNotes.push('Repository intelligence for the active area is low-confidence; validate critical conclusions with direct file evidence.');
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
  const topologyCeiling = deriveTopologyCeiling(
    mutationSurface,
    assuranceIntent,
  );
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
    providerPolicy,
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
  const finalExecutionPattern: KodaXExecutionPattern = harnessDecision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
      ? 'coordinated'
      : harnessDecision.harnessProfile === 'H1_EXECUTE_EVAL'
        ? 'checked-direct'
        : 'direct';

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

function summarizeRepoRoutingSignals(
  signals?: KodaXRepoRoutingSignals,
): string[] {
  if (!signals) {
    return [];
  }

  const parts: string[] = [
    [
      '- repo intelligence:',
      `changedFiles=${signals.changedFileCount}`,
      `changedLines=${signals.changedLineCount}`,
      `touchedModules=${signals.touchedModuleCount}`,
      `crossModule=${signals.crossModule ? 'yes' : 'no'}`,
      `plannerBias=${signals.plannerBias ? 'yes' : 'no'}`,
      `investigationBias=${signals.investigationBias ? 'yes' : 'no'}`,
      `lowConfidence=${signals.lowConfidence ? 'yes' : 'no'}`,
      signals.suggestedComplexity ? `suggestedComplexity=${signals.suggestedComplexity}` : null,
      signals.reviewScale ? `reviewScale=${signals.reviewScale}` : null,
      signals.predominantCapabilityTier ? `capability=${signals.predominantCapabilityTier}` : null,
    ]
      .filter(Boolean)
      .join(' '),
  ];

  if (signals.activeModuleId) {
    parts.push(
      `- active module: ${signals.activeModuleId} confidence=${(signals.activeModuleConfidence ?? 0).toFixed(2)} impactedModules=${signals.impactedModuleCount ?? 0} impactedSymbols=${signals.impactedSymbolCount ?? 0}`,
    );
  }

  if (signals.changedModules.length > 0) {
    parts.push(`- touched modules: ${signals.changedModules.slice(0, 6).join(', ')}`);
  }

  for (const hint of signals.riskHints.slice(0, 4)) {
    parts.push(`- repo risk hint: ${hint}`);
  }

  return parts;
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
