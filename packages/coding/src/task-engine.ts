import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runKodaX as runDirectKodaX } from './agent.js';
import {
  createKodaXTaskRunner,
  runOrchestration,
  type KodaXAgentWorkerSpec,
  type OrchestrationRunEvents,
  type OrchestrationRunResult,
} from './orchestration.js';
import { resolveProvider } from './providers/index.js';
import {
  buildAmaControllerDecision,
  buildFallbackRoutingDecision,
  buildPromptOverlay,
  buildProviderPolicyHintsForDecision,
  createReasoningPlan,
  inferIntentGate,
  reasoningModeToDepth,
  resolveReasoningMode,
  type ReasoningPlan,
} from './reasoning.js';
import {
  applyFanoutBranchTransition,
  buildFanoutSchedulerPlan,
  countActiveFanoutBranches,
  createFanoutSchedulerInput,
} from './fanout-scheduler.js';
import {
  analyzeChangedScope,
  getRepoOverview,
  renderChangedScope,
  renderRepoOverview,
} from './repo-intelligence/index.js';
import { debugLogRepoIntelligence } from './repo-intelligence/internal.js';
import {
  getImpactEstimate,
  getModuleContext,
  getRepoPreturnBundle,
  getRepoRoutingSignals,
  resolveKodaXAutoRepoMode,
} from './repo-intelligence/runtime.js';
import {
  renderImpactEstimate,
  renderModuleContext,
} from './repo-intelligence/query.js';
import { filterRepoIntelligenceWorkingToolNames, isRepoIntelligenceWorkingToolName } from './tools/index.js';
import { createRepoIntelligenceTraceEvent } from './repo-intelligence/trace-events.js';
import type {
  KodaXAmaControllerDecision,
  KodaXAmaFanoutClass,
  KodaXAgentMode,
  KodaXBudgetDisclosureZone,
  KodaXBudgetExtensionRequest,
  KodaXChildAgentResult,
  KodaXChildContextBundle,
  KodaXEvents,
  KodaXFanoutBranchRecord,
  KodaXFanoutSchedulerPlan,
  KodaXHarnessProfile,
  KodaXJsonValue,
  KodaXManagedTaskHarnessTransition,
  KodaXManagedTask,
  KodaXManagedTaskRuntimeState,
  KodaXManagedBudgetSnapshot,
  KodaXManagedTaskStatusEvent,
  KodaXMemoryStrategy,
  KodaXOptions,
  KodaXRepoIntelligenceCarrier,
  KodaXRepoIntelligenceMode,
  KodaXRepoRoutingSignals,
  KodaXResult,
  KodaXRoleRoundSummary,
  KodaXParentReductionContract,
  KodaXSessionData,
  KodaXSessionStorage,
  KodaXSkillInvocationContext,
  KodaXSkillMap,
  KodaXRuntimeVerificationContract,
  KodaXTaskCapabilityHint,
  KodaXTaskEvidenceArtifact,
  KodaXTaskEvidenceEntry,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
  KodaXTaskStatus,
  KodaXTaskSurface,
  KodaXTaskToolPolicy,
  KodaXTaskVerificationCriterion,
  KodaXTaskVerificationContract,
  KodaXVerificationScorecard,
} from './types.js';

interface ManagedTaskWorkerSpec extends KodaXAgentWorkerSpec {
  role: KodaXTaskRole;
  toolPolicy?: KodaXTaskToolPolicy;
  memoryStrategy?: KodaXMemoryStrategy;
  budgetSnapshot?: KodaXManagedBudgetSnapshot;
  terminalAuthority?: boolean;
}

interface ManagedTaskShape {
  task: KodaXManagedTask;
  terminalWorkerId: string;
  workers: ManagedTaskWorkerSpec[];
  workspaceDir: string;
  routingPromptOverlay?: string;
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode;
  providerPolicy?: ReasoningPlan['providerPolicy'];
  amaControllerDecision: KodaXAmaControllerDecision;
}

interface ManagedTaskRepoIntelligenceSnapshot {
  artifacts: KodaXTaskEvidenceArtifact[];
}

interface ManagedTaskRepoIntelligenceContext {
  executionCwd?: string;
  gitRoot?: string;
  repoIntelligenceMode?: KodaXRepoIntelligenceMode;
}

interface ManagedTaskVerdictDirective {
  source: 'evaluator' | 'worker';
  status: 'accept' | 'revise' | 'blocked';
  reason?: string;
  followups: string[];
  userFacingText: string;
  userAnswer?: string;
  artifactPath?: string;
  nextHarness?: KodaXTaskRoutingDecision['harnessProfile'];
}

function shouldEmitRepoIntelligenceTrace(options: KodaXOptions): boolean {
  return options.context?.repoIntelligenceTrace === true
    || process.env.KODAX_REPO_INTELLIGENCE_TRACE === '1';
}

function emitManagedRepoIntelligenceTrace(
  events: KodaXEvents | undefined,
  options: KodaXOptions,
  stage: 'routing' | 'preturn' | 'module' | 'impact' | 'task-snapshot',
  carrier: KodaXRepoIntelligenceCarrier | null | undefined,
  detail?: string,
): void {
  if (!events?.onRepoIntelligenceTrace || !shouldEmitRepoIntelligenceTrace(options) || !carrier) {
    return;
  }
  const traceEvent = createRepoIntelligenceTraceEvent(stage, carrier, detail);
  if (traceEvent) {
    events.onRepoIntelligenceTrace(traceEvent);
  }
}

interface ManagedTaskScoutDirective {
  summary?: string;
  scope: string[];
  requiredEvidence: string[];
  reviewFilesOrAreas?: string[];
  evidenceAcquisitionMode?: ManagedEvidenceAcquisitionMode;
  confirmedHarness?: KodaXTaskRoutingDecision['harnessProfile'];
  userFacingText?: string;
  skillMap?: {
    skillSummary?: string;
    executionObligations: string[];
    verificationObligations: string[];
    ambiguities: string[];
    projectionConfidence?: KodaXSkillMap['projectionConfidence'];
  };
}

interface ManagedTaskContractDirective {
  summary?: string;
  successCriteria: string[];
  requiredEvidence: string[];
  constraints: string[];
}

interface ManagedTaskHandoffDirective {
  status: 'ready' | 'incomplete' | 'blocked';
  summary?: string;
  evidence: string[];
  followup: string[];
  userFacingText: string;
}

interface TacticalReviewFinding {
  id: string;
  title: string;
  claim: string;
  priority: 'high' | 'medium' | 'low';
  files: string[];
  evidence: string[];
}

interface TacticalReviewFindingsDirective {
  summary: string;
  findings: TacticalReviewFinding[];
  userFacingText: string;
}

interface TacticalInvestigationShard {
  id: string;
  question: string;
  scope: string;
  priority: 'high' | 'medium' | 'low';
  files: string[];
  evidence: string[];
}

interface TacticalInvestigationShardsDirective {
  summary: string;
  shards: TacticalInvestigationShard[];
  userFacingText: string;
}

interface TacticalChildResultLedger {
  generatedAt: string;
  fanoutClass: KodaXFanoutSchedulerPlan['fanoutClass'];
  reductionStrategy: KodaXParentReductionContract['strategy'];
  branches: KodaXFanoutSchedulerPlan['branches'];
  bundles: KodaXChildContextBundle[];
  childResults: KodaXChildAgentResult[];
}

interface ManagedTaskRoundExecution {
  workerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] };
  workerResults: Map<string, KodaXResult>;
  contractDirectives: Map<string, ManagedTaskContractDirective>;
  orchestrationResult: OrchestrationRunResult<ManagedTaskWorkerSpec, string>;
  taskSnapshot: KodaXManagedTask;
  workspaceDir: string;
  directive?: ManagedTaskVerdictDirective;
  budgetRequest?: KodaXBudgetExtensionRequest;
  budgetExtensionGranted?: number;
  budgetExtensionReason?: string;
}

type ManagedTaskQualityAssuranceMode = 'required' | 'optional';

interface ManagedTaskBudgetController {
  totalBudget: number;
  reserveBudget: number;
  reserveRemaining: number;
  upgradeReserveBudget: number;
  upgradeReserveRemaining: number;
  plannedRounds: number;
  spentBudget: number;
  currentHarness: KodaXTaskRoutingDecision['harnessProfile'];
  upgradeCeiling?: KodaXTaskRoutingDecision['harnessProfile'];
  lastApprovalBudgetTotal?: number;
}

function truncateText(value: string, maxLength = 400): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function resolveManagedOriginalTask(
  context: KodaXOptions['context'] | undefined,
  prompt: string,
): string {
  return context?.rawUserInput?.trim() || prompt;
}

function splitAllowedToolList(value: string | undefined): string[] {
  return value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    ?? [];
}

function getManagedSkillArtifactPaths(workspaceDir: string): {
  rawSkillPath: string;
  skillMapJsonPath: string;
  skillMapMarkdownPath: string;
} {
  return {
    rawSkillPath: path.join(workspaceDir, 'skill-execution.md'),
    skillMapJsonPath: path.join(workspaceDir, 'skill-map.json'),
    skillMapMarkdownPath: path.join(workspaceDir, 'skill-map.md'),
  };
}

function withManagedSkillArtifactPromptPaths(
  rolePromptContext: ManagedRolePromptContext | undefined,
  workspaceDir: string,
): ManagedRolePromptContext | undefined {
  if (!rolePromptContext) {
    return undefined;
  }
  const artifactPaths = getManagedSkillArtifactPaths(workspaceDir);
  return {
    ...rolePromptContext,
    skillExecutionArtifactPath: artifactPaths.rawSkillPath,
    skillMapArtifactPath: artifactPaths.skillMapMarkdownPath,
  };
}

function formatOptionalListSection(title: string, items: string[] | undefined): string | undefined {
  const cleaned = items?.map((item) => item.trim()).filter(Boolean) ?? [];
  if (cleaned.length === 0) {
    return undefined;
  }
  return [title, ...cleaned.map((item) => `- ${item}`)].join('\n');
}

function formatSkillInvocationSummary(
  skillInvocation: KodaXSkillInvocationContext,
  rawSkillPath?: string,
): string {
  return [
    'Active skill invocation:',
    `- Name: ${skillInvocation.name}`,
    `- Path: ${skillInvocation.path}`,
    skillInvocation.arguments ? `- Arguments: ${skillInvocation.arguments}` : undefined,
    skillInvocation.description ? `- Description: ${skillInvocation.description}` : undefined,
    skillInvocation.allowedTools ? `- Allowed tools: ${skillInvocation.allowedTools}` : undefined,
    skillInvocation.agent ? `- Preferred agent: ${skillInvocation.agent}` : undefined,
    skillInvocation.model ? `- Preferred model: ${skillInvocation.model}` : undefined,
    skillInvocation.context ? `- Invocation context: ${skillInvocation.context}` : undefined,
    skillInvocation.hookEvents?.length ? `- Hook events: ${skillInvocation.hookEvents.join(', ')}` : undefined,
    rawSkillPath ? `- Raw skill artifact: ${rawSkillPath}` : undefined,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function formatSkillMapSection(
  skillMap: KodaXSkillMap,
  skillMapArtifactPath?: string,
): string {
  return [
    'Skill map:',
    `- Summary: ${skillMap.skillSummary}`,
    `- Projection confidence: ${skillMap.projectionConfidence}`,
    skillMap.allowedTools ? `- Allowed tools: ${skillMap.allowedTools}` : undefined,
    skillMap.preferredAgent ? `- Preferred agent: ${skillMap.preferredAgent}` : undefined,
    skillMap.preferredModel ? `- Preferred model: ${skillMap.preferredModel}` : undefined,
    skillMap.invocationContext ? `- Invocation context: ${skillMap.invocationContext}` : undefined,
    skillMap.hookEvents?.length ? `- Hook events: ${skillMap.hookEvents.join(', ')}` : undefined,
    skillMap.rawSkillFallbackAllowed ? '- Raw skill fallback: allowed when the map is incomplete or claims conflict.' : undefined,
    skillMapArtifactPath ? `- Skill map artifact: ${skillMapArtifactPath}` : undefined,
    formatOptionalListSection('Execution obligations:', skillMap.executionObligations),
    formatOptionalListSection('Verification obligations:', skillMap.verificationObligations),
    formatOptionalListSection('Required evidence:', skillMap.requiredEvidence),
    formatOptionalListSection('Ambiguities:', skillMap.ambiguities),
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function formatFullSkillSection(skillInvocation: KodaXSkillInvocationContext): string {
  return [
    'Full expanded skill (authoritative execution reference):',
    '```markdown',
    skillInvocation.expandedContent.trim(),
    '```',
  ].join('\n');
}

function formatRoleRoundSummarySection(summary: KodaXRoleRoundSummary): string {
  return [
    'Previous same-role summary:',
    `- Round: ${summary.round}`,
    `- Objective: ${summary.objective}`,
    `- Summary: ${summary.summary}`,
    formatOptionalListSection('Confirmed conclusions:', summary.confirmedConclusions),
    formatOptionalListSection('Unresolved questions:', summary.unresolvedQuestions),
    formatOptionalListSection('Next focus:', summary.nextFocus),
  ].filter((line): line is string => Boolean(line)).join('\n');
}

type ManagedEvidenceAcquisitionMode = NonNullable<KodaXManagedTask['runtime']>['evidenceAcquisitionMode'];
type ManagedReviewTarget = NonNullable<KodaXTaskRoutingDecision['reviewTarget']>;

interface ManagedToolTelemetry {
  toolOutputTruncated: boolean;
  toolOutputTruncationNotes: string[];
  evidenceAcquisitionMode?: ManagedEvidenceAcquisitionMode;
  consecutiveEvidenceOnlyIterations?: number;
}

interface ManagedPlanningResult {
  plan: ReasoningPlan;
  repoRoutingSignals?: KodaXRepoRoutingSignals;
  rawDecision: KodaXTaskRoutingDecision;
  reviewTarget: ManagedReviewTarget;
  routingOverrideReason?: string;
}

interface ManagedRolePromptContext {
  originalTask: string;
  skillInvocation?: KodaXSkillInvocationContext;
  skillMap?: KodaXSkillMap;
  skillExecutionArtifactPath?: string;
  skillMapArtifactPath?: string;
  previousRoleSummaries?: Partial<Record<KodaXTaskRole, KodaXRoleRoundSummary>>;
}

const MANAGED_TASK_CONTRACT_BLOCK = 'kodax-task-contract';
const MANAGED_TASK_VERDICT_BLOCK = 'kodax-task-verdict';
const MANAGED_TASK_SCOUT_BLOCK = 'kodax-task-scout';
const MANAGED_TASK_HANDOFF_BLOCK = 'kodax-task-handoff';
const TACTICAL_REVIEW_FINDINGS_BLOCK = 'kodax-review-findings';
const TACTICAL_INVESTIGATION_SHARDS_BLOCK = 'kodax-investigation-shards';
const TACTICAL_CHILD_RESULT_BLOCK = 'kodax-child-result';
const TACTICAL_CHILD_RESULT_ARTIFACT_JSON = 'child-result.json';
const TACTICAL_CHILD_HANDOFF_JSON = 'dependency-handoff.json';
const TACTICAL_CHILD_LEDGER_JSON = 'child-result-ledger.json';
const TACTICAL_CHILD_LEDGER_MARKDOWN = 'child-result-ledger.md';
const MANAGED_TASK_BUDGET_REQUEST_BLOCK = 'kodax-budget-request';
const MANAGED_TASK_MAX_REFINEMENT_ROUND_CAP = 2;
const MANAGED_TASK_MIN_REFINEMENT_ROUNDS = 1;
const MANAGED_TASK_ROUTER_MAX_RETRIES = 2;
const EVIDENCE_ONLY_ITERATION_THRESHOLD = 3;
const GLOBAL_WORK_BUDGET_APPROVAL_THRESHOLD = 0.9;
const GLOBAL_WORK_BUDGET_INCREMENT = 200;
const DEFAULT_MANAGED_WORK_BUDGET = 200;
const MANAGED_TASK_BUDGET_BASE: Record<KodaXTaskRoutingDecision['harnessProfile'], number> = {
  H0_DIRECT: 50,
  H1_EXECUTE_EVAL: DEFAULT_MANAGED_WORK_BUDGET,
  H2_PLAN_EXECUTE_EVAL: DEFAULT_MANAGED_WORK_BUDGET,
};

function getManagedTaskSurface(options: KodaXOptions): KodaXTaskSurface {
  return options.context?.taskSurface
    ?? (options.context?.providerPolicyHints?.harness === 'project' ? 'project' : 'cli');
}

function getManagedTaskWorkspaceRoot(options: KodaXOptions, surface: KodaXTaskSurface): string {
  if (options.context?.managedTaskWorkspaceDir?.trim()) {
    return path.resolve(options.context.managedTaskWorkspaceDir);
  }

  const cwd = options.context?.executionCwd ?? options.context?.gitRoot ?? process.cwd();
  if (surface === 'project') {
    return path.resolve(cwd, '.agent', 'project', 'managed-tasks');
  }
  return path.resolve(cwd, '.agent', 'managed-tasks');
}

function resolveManagedAgentMode(options: KodaXOptions): KodaXAgentMode {
  return options.agentMode ?? 'ama';
}

function applyAgentModeToPlan(
  plan: ReasoningPlan,
  agentMode: KodaXAgentMode,
): ReasoningPlan {
  if (agentMode === 'sa') {
    return plan;
  }

  return {
    ...plan,
    promptOverlay: [
      plan.promptOverlay,
      '[Agent Mode: AMA] Single-agent-first harness escalation is enabled.',
    ].filter(Boolean).join('\n\n'),
  };
}

function applyDirectPathTaskFamilyShaping(
  plan: ReasoningPlan,
  promptOverlayPrefix?: string,
): string {
  return buildDirectPathTaskFamilyPromptOverlay(
    plan.decision.taskFamily,
    [promptOverlayPrefix, plan.promptOverlay],
  );
}

function buildDirectPathTaskFamilyPromptOverlay(
  family: KodaXTaskRoutingDecision['taskFamily'] | undefined,
  sections: Array<string | undefined>,
): string {
  const familyRule = family === 'review'
    ? '[Direct Path Rule] Return a review report, not a plan. Findings first when issues exist; otherwise explicitly say no findings.'
    : family === 'lookup'
      ? '[Direct Path Rule] Return a concise factual answer with the relevant file path(s) and only the minimum supporting detail.'
      : family === 'planning'
        ? '[Direct Path Rule] Return a concrete plan, not an implementation report.'
        : family === 'investigation'
          ? '[Direct Path Rule] Return diagnosis, evidence, and next steps.'
          : undefined;

  return [...sections, familyRule].filter(Boolean).join('\n\n');
}

function applyScoutDecisionToPlan(
  plan: ReasoningPlan,
  scout: ManagedTaskScoutDirective | undefined,
): ReasoningPlan {
  if (!scout?.confirmedHarness) {
    return plan;
  }

  const topologyCeiling = plan.decision.topologyCeiling ?? plan.decision.upgradeCeiling;
  const confirmedHarness = topologyCeiling
    ? clampHarnessToCeiling(scout.confirmedHarness, topologyCeiling)
    : scout.confirmedHarness;
  const ceilingNote = confirmedHarness !== scout.confirmedHarness
    ? `Scout requested ${scout.confirmedHarness} but runtime ceiling kept the task at ${confirmedHarness}.`
    : undefined;
  if (
    confirmedHarness === plan.decision.harnessProfile
    && !scout.summary
    && !ceilingNote
  ) {
    return plan;
  }

  const decision: KodaXTaskRoutingDecision = {
    ...plan.decision,
    harnessProfile: confirmedHarness,
    reason: scout.summary
      ? `${plan.decision.reason} Scout confirmed ${confirmedHarness}: ${scout.summary}`
      : plan.decision.reason,
    routingNotes: [
      ...(plan.decision.routingNotes ?? []),
      ...(scout.summary ? [`Scout decision: ${scout.summary}`] : []),
      ...(ceilingNote ? [ceilingNote] : []),
    ],
  };
  const amaControllerDecision = buildAmaControllerDecision(decision);

  return {
    ...plan,
    decision,
    amaControllerDecision,
    promptOverlay: buildPromptOverlay(
      decision,
      plan.providerPolicy?.routingNotes,
      plan.providerPolicy,
      amaControllerDecision,
    ),
  };
}

function clampHarnessToCeiling(
  harness: KodaXHarnessProfile,
  topologyCeiling: KodaXHarnessProfile,
): KodaXHarnessProfile {
  return getHarnessRank(harness) > getHarnessRank(topologyCeiling)
    ? topologyCeiling
    : harness;
}

function shouldBypassScoutForManagedH0(
  decision: Pick<KodaXTaskRoutingDecision, 'primaryTask' | 'taskFamily' | 'actionability' | 'harnessProfile'>,
): boolean {
  if (decision.harnessProfile !== 'H0_DIRECT') {
    return false;
  }

  const taskFamily = decision.taskFamily ?? (
    decision.primaryTask === 'conversation'
      ? 'conversation'
      : decision.primaryTask === 'lookup'
        ? 'lookup'
        : decision.primaryTask === 'review'
          ? 'review'
          : decision.primaryTask === 'plan'
            ? 'planning'
            : decision.primaryTask === 'bugfix'
              ? 'investigation'
              : decision.primaryTask === 'edit' || decision.primaryTask === 'refactor'
                ? 'implementation'
                : 'ambiguous'
  );
  const actionability = decision.actionability ?? (
    taskFamily === 'conversation'
      ? 'non_actionable'
      : taskFamily === 'ambiguous'
        ? 'ambiguous'
        : 'actionable'
  );
  return actionability !== 'actionable' || taskFamily === 'conversation' || taskFamily === 'lookup';
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function inferVerificationRubricFamily(
  verification: KodaXTaskVerificationContract | undefined,
  primaryTask: KodaXTaskRoutingDecision['primaryTask'],
): NonNullable<KodaXTaskVerificationContract['rubricFamily']> | undefined {
  if (verification?.rubricFamily) {
    return verification.rubricFamily;
  }
  if (verification?.capabilityHints?.some((hint) => /agent-browser|playwright/i.test(hint.name))) {
    return 'frontend';
  }
  if (primaryTask === 'review') {
    return 'code-review';
  }
  if (primaryTask === 'bugfix') {
    return 'functionality';
  }
  return 'code-quality';
}

function resolveVerificationCriteria(
  verification: KodaXTaskVerificationContract | undefined,
  primaryTask: KodaXTaskRoutingDecision['primaryTask'],
): KodaXTaskVerificationCriterion[] {
  if (verification?.criteria?.length) {
    return verification.criteria.map((criterion) => ({
      ...criterion,
      threshold: clampNumber(criterion.threshold, 0, 100),
      weight: clampNumber(criterion.weight, 0, 1),
    }));
  }

  const rubricFamily = inferVerificationRubricFamily(verification, primaryTask);
  const requiredEvidence = verification?.requiredEvidence ?? [];
  const requiredChecks = verification?.requiredChecks ?? [];
  if (rubricFamily === 'frontend') {
    return [
      {
        id: 'ui-flow',
        label: 'UI flow verification',
        description: 'Critical browser path completes without visible breakage.',
        threshold: 75,
        weight: 0.4,
        requiredEvidence,
      },
      {
        id: 'console-clean',
        label: 'Console and runtime health',
        description: 'Browser or app runtime should not show blocking errors.',
        threshold: 75,
        weight: 0.25,
        requiredEvidence,
      },
      {
        id: 'check-evidence',
        label: 'Deterministic checks',
        description: 'Required checks or tests must be explicitly reported.',
        threshold: 70,
        weight: 0.35,
        requiredEvidence: [...requiredEvidence, ...requiredChecks],
      },
    ];
  }

  if (rubricFamily === 'code-review') {
    return [
      {
        id: 'finding-accuracy',
        label: 'Finding accuracy',
        description: 'Reported issues should be grounded in concrete evidence.',
        threshold: 80,
        weight: 0.45,
        requiredEvidence,
      },
      {
        id: 'verification',
        label: 'Independent verification',
        description: 'Claims should be independently verified before acceptance.',
        threshold: 75,
        weight: 0.35,
        requiredEvidence: [...requiredEvidence, ...requiredChecks],
      },
      {
        id: 'completeness',
        label: 'Review completeness',
        description: 'High-risk changes should not truncate before the critical findings are delivered.',
        threshold: 70,
        weight: 0.2,
        requiredEvidence,
      },
    ];
  }

  return [
    {
      id: 'functionality',
      label: 'Functional correctness',
      description: 'The requested behavior is implemented and evidenced.',
      threshold: 75,
      weight: 0.5,
      requiredEvidence,
    },
    {
      id: 'checks',
      label: 'Check coverage',
      description: 'Relevant checks and validation evidence are reported.',
      threshold: 70,
      weight: 0.3,
      requiredEvidence: [...requiredEvidence, ...requiredChecks],
    },
    {
      id: 'quality',
      label: 'Quality and safety',
      description: 'The result does not leave obvious correctness or safety gaps behind.',
      threshold: 70,
      weight: 0.2,
      requiredEvidence,
    },
  ];
}

function deriveRuntimeVerificationContract(
  verification: KodaXTaskVerificationContract | undefined,
  options: KodaXOptions,
): KodaXRuntimeVerificationContract | undefined {
  if (verification?.runtime) {
    return verification.runtime;
  }

  if (!verification) {
    return undefined;
  }

  const runtime: KodaXRuntimeVerificationContract = {
    cwd: options.context?.executionCwd ?? options.context?.gitRoot ?? process.cwd(),
    uiFlows: verification.capabilityHints?.some((hint) => /agent-browser|playwright/i.test(hint.name))
      ? ['Open the live app, execute the critical user path, and reject completion on visual or console failure.']
      : undefined,
    apiChecks: verification.requiredChecks?.filter((check) => /api|http|curl|endpoint/i.test(check)),
    dbChecks: verification.requiredChecks?.filter((check) => /\bdb\b|database|sql/i.test(check)),
    fixtures: verification.requiredEvidence?.filter((item) => /fixture|seed|sample/i.test(item)),
  };

  return Object.values(runtime).some((value) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return Boolean(value);
  }) ? runtime : undefined;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractRuntimeCommandCandidate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const suffixMatch = trimmed.match(/^[^:]+:\s*(.+)$/);
  const candidate = suffixMatch?.[1]?.trim() || trimmed;
  return /^(?:npm|pnpm|yarn|bun|npx|node|python|pytest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|curl|Invoke-WebRequest|Invoke-RestMethod|agent-browser|sqlite3|psql|mysql)\b/i.test(candidate)
    ? candidate
    : undefined;
}

function buildRuntimeVerificationShellPatterns(
  verification: KodaXTaskVerificationContract | undefined,
): string[] {
  const runtime = verification?.runtime;
  if (!runtime) {
    return [];
  }

  const exactCommands = [
    runtime.startupCommand,
    ...(runtime.apiChecks ?? []),
    ...(runtime.dbChecks ?? []),
  ]
    .map(extractRuntimeCommandCandidate)
    .filter((value): value is string => Boolean(value));
  const patterns = exactCommands.map((command) => `^${escapeRegexLiteral(command)}(?:\\s+.*)?$`);

  if (runtime.baseUrl || (runtime.apiChecks?.length ?? 0) > 0) {
    patterns.push('^(?:curl|Invoke-WebRequest|Invoke-RestMethod)\\b');
  }

  return Array.from(new Set(patterns));
}

function buildRuntimeExecutionGuide(
  verification: KodaXTaskVerificationContract | undefined,
): string | undefined {
  const runtime = verification?.runtime;
  if (!runtime) {
    return undefined;
  }

  const lines = [
    '# Runtime Execution Guide',
    '',
    'Use this guide to drive live verification against the runtime under test.',
    '',
    runtime.cwd ? `- Working directory: ${runtime.cwd}` : undefined,
    runtime.startupCommand ? `- Startup command: ${runtime.startupCommand}` : undefined,
    runtime.readySignal ? `- Ready signal: ${runtime.readySignal}` : undefined,
    runtime.baseUrl ? `- Base URL: ${runtime.baseUrl}` : undefined,
    runtime.env && Object.keys(runtime.env).length > 0
      ? `- Environment keys: ${Object.keys(runtime.env).join(', ')}`
      : undefined,
    '',
    'Execution protocol:',
    runtime.startupCommand
      ? '1. Start or confirm the runtime using the declared startup command before accepting the task.'
      : '1. Confirm the target runtime is available before accepting the task.',
    runtime.readySignal || runtime.baseUrl
      ? '2. Wait until the runtime is ready, using the ready signal or base URL when available.'
      : '2. Confirm runtime readiness using the strongest observable signal you have.',
    runtime.uiFlows?.length
      ? ['3. Execute the declared UI flows:', ...runtime.uiFlows.map((flow, index) => `   ${index + 1}. ${flow}`)].join('\n')
      : '3. Execute the critical user-facing flow when browser verification is required.',
    runtime.apiChecks?.length
      ? ['4. Run the declared API checks:', ...runtime.apiChecks.map((check, index) => `   ${index + 1}. ${check}`)].join('\n')
      : undefined,
    runtime.dbChecks?.length
      ? ['5. Run the declared DB checks:', ...runtime.dbChecks.map((check, index) => `   ${index + 1}. ${check}`)].join('\n')
      : undefined,
    runtime.fixtures?.length
      ? ['6. Account for the declared fixtures:', ...runtime.fixtures.map((fixture, index) => `   ${index + 1}. ${fixture}`)].join('\n')
      : undefined,
    '',
    'Evidence requirements:',
    '- Capture concrete evidence for every hard-threshold criterion before accepting the task.',
    '- Reject completion if the runtime cannot be started, cannot reach readiness, or any declared flow/check fails.',
  ].filter((line): line is string => Boolean(line));

  return `${lines.join('\n')}\n`;
}

const HARNESS_ORDER: KodaXTaskRoutingDecision['harnessProfile'][] = [
  'H0_DIRECT',
  'H1_EXECUTE_EVAL',
  'H2_PLAN_EXECUTE_EVAL',
];

const HARNESS_UPGRADE_COST: Record<KodaXTaskRoutingDecision['harnessProfile'], number> = {
  H0_DIRECT: 0,
  H1_EXECUTE_EVAL: 16,
  H2_PLAN_EXECUTE_EVAL: 24,
};

function getHarnessRank(harness: KodaXTaskRoutingDecision['harnessProfile']): number {
  return HARNESS_ORDER.indexOf(harness);
}

function isHarnessUpgrade(
  from: KodaXTaskRoutingDecision['harnessProfile'],
  to: KodaXTaskRoutingDecision['harnessProfile'] | undefined,
): to is KodaXTaskRoutingDecision['harnessProfile'] {
  if (!to) {
    return false;
  }
  return getHarnessRank(to) > getHarnessRank(from);
}

function getHarnessUpgradeCost(
  from: KodaXTaskRoutingDecision['harnessProfile'],
  to: KodaXTaskRoutingDecision['harnessProfile'],
): number {
  if (!isHarnessUpgrade(from, to)) {
    return 0;
  }
  return Math.max(8, HARNESS_UPGRADE_COST[to] - HARNESS_UPGRADE_COST[from]);
}

function createManagedBudgetController(
  _options: KodaXOptions,
  plan: ReasoningPlan,
  agentMode: KodaXAgentMode,
): ManagedTaskBudgetController {
  if (agentMode !== 'ama' || plan.decision.harnessProfile === 'H0_DIRECT') {
    return {
      totalBudget: MANAGED_TASK_BUDGET_BASE.H0_DIRECT,
      reserveBudget: 0,
      reserveRemaining: 0,
      upgradeReserveBudget: 0,
      upgradeReserveRemaining: 0,
      plannedRounds: 1,
      spentBudget: 0,
      currentHarness: 'H0_DIRECT',
      upgradeCeiling: undefined,
    };
  }

  const totalBudget = MANAGED_TASK_BUDGET_BASE[plan.decision.harnessProfile];
  const reserveBudget = clampNumber(Math.round(totalBudget * 0.2), 0, Math.max(0, totalBudget - 25));
  const hasUpgradePath = isHarnessUpgrade(plan.decision.harnessProfile, plan.decision.upgradeCeiling);
  const upgradeReserveBudget = hasUpgradePath
    ? clampNumber(Math.round(reserveBudget * 0.6), 8, reserveBudget)
    : 0;
  const plannedRounds = 1;

  return {
    totalBudget,
    reserveBudget,
    reserveRemaining: reserveBudget,
    upgradeReserveBudget,
    upgradeReserveRemaining: upgradeReserveBudget,
    plannedRounds,
    spentBudget: 0,
    currentHarness: plan.decision.harnessProfile,
    upgradeCeiling: plan.decision.upgradeCeiling,
  };
}

function resolveBudgetZone(
  round: number,
  plannedRounds: number,
  role: KodaXTaskRole,
): KodaXBudgetDisclosureZone {
  const ratio = plannedRounds <= 0 ? 1 : round / plannedRounds;
  const earlyConvergeRole = role === 'scout' || role === 'planner' || role === 'evaluator';
  const yellowThreshold = earlyConvergeRole ? 0.5 : 0.6;
  const orangeThreshold = earlyConvergeRole ? 0.78 : 0.85;
  const redThreshold = earlyConvergeRole ? 0.9 : 0.95;

  if (ratio >= redThreshold || round >= plannedRounds) {
    return 'red';
  }
  if (ratio >= orangeThreshold || plannedRounds - round <= 1) {
    return 'orange';
  }
  if (ratio >= yellowThreshold) {
    return 'yellow';
  }
  return 'green';
}

function resolveWorkerIterLimits(
  harness: KodaXTaskRoutingDecision['harnessProfile'],
  role: KodaXTaskRole,
): { soft: number; hard: number } {
  const budgets: Record<KodaXTaskRoutingDecision['harnessProfile'], Partial<Record<KodaXTaskRole, { soft: number; hard: number }>>> = {
    H0_DIRECT: {
      direct: { soft: 18, hard: 24 },
    },
    H1_EXECUTE_EVAL: {
      scout: { soft: 6, hard: 10 },
      generator: { soft: 24, hard: 30 },
      evaluator: { soft: 12, hard: 16 },
    },
    H2_PLAN_EXECUTE_EVAL: {
      scout: { soft: 6, hard: 10 },
      planner: { soft: 8, hard: 12 },
      generator: { soft: 28, hard: 36 },
      evaluator: { soft: 14, hard: 18 },
    },
  };
  const explicit = budgets[harness][role];
  if (explicit) {
    return explicit;
  }

  return harness === 'H2_PLAN_EXECUTE_EVAL'
    ? { soft: 28, hard: 36 }
    : harness === 'H1_EXECUTE_EVAL'
      ? { soft: 24, hard: 30 }
      : { soft: 18, hard: 24 };
}

function createBudgetSnapshot(
  controller: ManagedTaskBudgetController,
  harness: KodaXTaskRoutingDecision['harnessProfile'],
  round: number,
  role: KodaXTaskRole | undefined,
  workerId?: string,
): KodaXManagedBudgetSnapshot {
  const effectiveRole = role ?? 'direct';
  const zone = resolveBudgetZone(round, controller.plannedRounds, effectiveRole);
  const iterLimits = resolveWorkerIterLimits(
    harness,
    effectiveRole,
  );
  return {
    totalBudget: controller.totalBudget,
    reserveBudget: controller.reserveBudget,
    reserveRemaining: controller.reserveRemaining,
    upgradeReserveBudget: controller.upgradeReserveBudget,
    upgradeReserveRemaining: controller.upgradeReserveRemaining,
    plannedRounds: controller.plannedRounds,
    currentRound: round,
    spentBudget: controller.spentBudget,
    remainingBudget: Math.max(0, controller.totalBudget - controller.spentBudget),
    workerId,
    role,
    currentHarness: controller.currentHarness || harness,
    upgradeCeiling: controller.upgradeCeiling,
    zone,
    showExactRoundCounter: zone === 'orange' || zone === 'red',
    allowExtensionRequest: zone === 'orange' || zone === 'red',
    mustConverge: zone === 'red',
    softMaxIter: iterLimits.soft,
    hardMaxIter: iterLimits.hard,
  };
}

function applyManagedBudgetRuntimeState(
  runtime: KodaXManagedTask['runtime'] | undefined,
  controller: ManagedTaskBudgetController,
  budgetApprovalRequired = false,
): NonNullable<KodaXManagedTask['runtime']> {
  return {
    ...(runtime ?? {}),
    currentHarness: controller.currentHarness,
    upgradeCeiling: controller.upgradeCeiling,
    globalWorkBudget: controller.totalBudget,
    budgetUsage: controller.spentBudget,
    budgetApprovalRequired,
  };
}

function buildManagedStatusBudgetFields(
  controller: ManagedTaskBudgetController | undefined,
  budgetApprovalRequired = false,
): Pick<KodaXManagedTaskStatusEvent, 'globalWorkBudget' | 'budgetUsage' | 'budgetApprovalRequired'> {
  return {
    globalWorkBudget: controller?.totalBudget,
    budgetUsage: controller?.spentBudget,
    budgetApprovalRequired,
  };
}

function incrementManagedBudgetUsage(
  controller: ManagedTaskBudgetController,
  amount = 1,
): void {
  controller.spentBudget = Math.max(0, controller.spentBudget + amount);
}

function resolveRemainingManagedWorkBudget(controller: ManagedTaskBudgetController): number {
  return Math.max(1, controller.totalBudget - controller.spentBudget);
}

function extendManagedWorkBudget(
  controller: ManagedTaskBudgetController,
  additionalUnits = GLOBAL_WORK_BUDGET_INCREMENT,
): void {
  const reserveAdd = clampNumber(Math.round(additionalUnits * 0.2), 0, additionalUnits);
  controller.totalBudget += additionalUnits;
  controller.reserveBudget += reserveAdd;
  controller.reserveRemaining += reserveAdd;

  if (isHarnessUpgrade(controller.currentHarness, controller.upgradeCeiling)) {
    const upgradeReserveAdd = clampNumber(Math.round(reserveAdd * 0.6), 8, reserveAdd);
    controller.upgradeReserveBudget += upgradeReserveAdd;
    controller.upgradeReserveRemaining += upgradeReserveAdd;
  }
}

async function maybeRequestAdditionalWorkBudget(
  events: KodaXEvents | undefined,
  controller: ManagedTaskBudgetController,
  context: {
    summary: string;
    currentRound: number;
    maxRounds: number;
  },
): Promise<'approved' | 'denied' | 'skipped'> {
  if (!events?.askUser) {
    return 'skipped';
  }

  const threshold = Math.ceil(controller.totalBudget * GLOBAL_WORK_BUDGET_APPROVAL_THRESHOLD);
  if (controller.spentBudget < threshold) {
    return 'skipped';
  }
  if (controller.lastApprovalBudgetTotal === controller.totalBudget) {
    return 'skipped';
  }

  const usedPercent = Math.min(100, Math.round((controller.spentBudget / Math.max(1, controller.totalBudget)) * 100));
  const choice = await events.askUser({
    question: `This AMA run has used ${controller.spentBudget}/${controller.totalBudget} work units (${usedPercent}%) and needs more work. Add ${GLOBAL_WORK_BUDGET_INCREMENT} more work units?`,
    options: [
      {
        label: `Continue (+${GLOBAL_WORK_BUDGET_INCREMENT})`,
        value: 'continue',
        description: `Grant ${GLOBAL_WORK_BUDGET_INCREMENT} more work units and continue from round ${context.currentRound}/${context.maxRounds}.`,
      },
      {
        label: 'Stop here',
        value: 'stop',
        description: `Finish now with the current best result. Latest note: ${truncateText(context.summary, 80)}`,
      },
    ],
    default: 'continue',
    intent: 'generic',
    scope: 'session',
    resumeBehavior: 'continue',
  });

  const promptedBudgetTotal = controller.totalBudget;
  if (choice === 'continue') {
    controller.lastApprovalBudgetTotal = promptedBudgetTotal;
    extendManagedWorkBudget(controller, GLOBAL_WORK_BUDGET_INCREMENT);
    return 'approved';
  }
  controller.lastApprovalBudgetTotal = promptedBudgetTotal;
  return 'denied';
}

function formatBudgetAdvisory(snapshot: KodaXManagedBudgetSnapshot | undefined): string | undefined {
  if (!snapshot) {
    return undefined;
  }

  if (snapshot.zone === 'green') {
    return [
      'Budget advisory:',
      '- You are in the normal execution window. Stay focused and avoid unbounded exploration.',
    ].join('\n');
  }

  if (snapshot.zone === 'yellow') {
    return [
      'Budget advisory:',
      '- Begin converging. Reduce branch exploration and organize a completion path.',
    ].join('\n');
  }

  const lines = [
    'Budget advisory:',
    `- Current round: ${snapshot.currentRound}/${snapshot.plannedRounds}`,
    `- Global work budget: used=${snapshot.spentBudget}/${snapshot.totalBudget}, remaining=${snapshot.remainingBudget}.`,
    snapshot.zone === 'red'
      ? '- Final completion window: return a complete result, a blocked verdict, or a clear continuation summary.'
      : '- You are approaching the execution boundary. Do not open new exploration branches.',
  ];

  return lines.join('\n');
}

function resolveManagedMemoryStrategy(
  options: KodaXOptions,
  plan: ReasoningPlan | undefined,
  role: KodaXTaskRole,
  round: number,
  previousDirective?: ManagedTaskVerdictDirective,
): KodaXMemoryStrategy {
  if (previousDirective?.status === 'revise' && previousDirective.nextHarness) {
    return 'reset-handoff';
  }
  if (role === 'planner' || role === 'evaluator' || role === 'scout') {
    return 'reset-handoff';
  }

  const tokenCount = options.context?.contextTokenSnapshot?.currentTokens ?? 0;
  const providerSnapshot = plan?.providerPolicy?.snapshot;
  if (
    providerSnapshot?.sessionSupport === 'stateless'
    || providerSnapshot?.contextFidelity === 'lossy'
    || providerSnapshot?.transport === 'cli-bridge'
  ) {
    return 'reset-handoff';
  }

  if (
    tokenCount >= 120_000
    || (round >= 3 && previousDirective?.status === 'revise')
  ) {
    return 'compact';
  }

  return 'continuous';
}

class ManagedWorkerSessionStorage implements KodaXSessionStorage {
  private sessions = new Map<string, {
    data: KodaXSessionData;
    createdAt: string;
  }>();
  private memoryNotes = new Map<string, string>();

  async save(id: string, data: KodaXSessionData): Promise<void> {
    const existing = this.sessions.get(id);
    this.sessions.set(id, {
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      data: structuredClone(data),
    });
  }

  async load(id: string): Promise<KodaXSessionData | null> {
    return structuredClone(this.sessions.get(id)?.data ?? null);
  }

  async list(_gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>> {
    return Array.from(this.sessions.entries())
      .map(([id, entry]) => ({
        id,
        title: entry.data.title,
        msgCount: entry.data.messages.length,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  saveMemoryNote(id: string, note: string): void {
    this.memoryNotes.set(id, note);
  }

  loadMemoryNote(id: string): string | undefined {
    return this.memoryNotes.get(id);
  }

  snapshotMemoryNotes(): Record<string, string> {
    return Object.fromEntries(this.memoryNotes.entries());
  }
}

function buildManagedWorkerMemoryNote(
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  result: KodaXResult | undefined,
  round: number,
): string {
  const latestSummary = truncateText(extractMessageText(result) || result?.lastText || 'No prior worker output captured.', 800);
  const latestFeedbackArtifact = task.evidence.artifacts
    .filter((artifact) => artifact.path.endsWith(`${path.sep}feedback.json`) || artifact.path.endsWith('/feedback.json'))
    .at(-1)?.path;
  const runtimeGuidePath = path.join(task.evidence.workspaceDir, 'runtime-execution.md');
  const lines = [
    'Compacted managed-task memory:',
    `- Objective: ${task.contract.objective}`,
    `- Role: ${worker.role}`,
    `- Harness: ${task.contract.harnessProfile}`,
    `- Round reached: ${round}`,
    task.contract.contractSummary ? `- Contract summary: ${task.contract.contractSummary}` : undefined,
    task.contract.successCriteria.length > 0
      ? `- Success criteria: ${task.contract.successCriteria.join(' | ')}`
      : undefined,
    task.contract.requiredEvidence.length > 0
      ? `- Required evidence: ${task.contract.requiredEvidence.join(' | ')}`
      : undefined,
    task.runtime?.reviewFilesOrAreas?.length
      ? `- Review targets: ${task.runtime.reviewFilesOrAreas.join(' | ')}`
      : undefined,
    task.runtime?.evidenceAcquisitionMode
      ? `- Evidence acquisition mode: ${task.runtime.evidenceAcquisitionMode}`
      : undefined,
    task.runtime?.toolOutputTruncated
      ? `- Tool output truncation observed: ${(task.runtime.toolOutputTruncationNotes ?? []).join(' | ') || 'yes'}`
      : undefined,
    (task.runtime?.consecutiveEvidenceOnlyIterations ?? 0) >= EVIDENCE_ONLY_ITERATION_THRESHOLD
      ? '- Recovery: recent iterations stayed in serial diff paging. Switch to changed_diff_bundle before drilling deeper with changed_diff.'
      : undefined,
    `- Latest worker summary: ${latestSummary}`,
    latestFeedbackArtifact ? `- Latest feedback artifact: ${latestFeedbackArtifact}` : undefined,
    task.contract.verification?.runtime ? `- Runtime guide: ${runtimeGuidePath}` : undefined,
    `- Contract path: ${path.join(task.evidence.workspaceDir, 'contract.json')}`,
    `- Round history path: ${path.join(task.evidence.workspaceDir, 'round-history.json')}`,
    'Use the current contract and artifacts as the source of truth; do not rely on stale assumptions from older rounds.',
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
}

function buildRoleRoundSummaryObjective(
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
): string {
  switch (worker.role) {
    case 'scout':
      return `Decide whether "${task.contract.objective}" should stay direct or escalate, and identify the next evidence path.`;
    case 'planner':
      return `Turn "${task.contract.objective}" into a workable contract, risks, and evidence checklist.`;
    case 'evaluator':
      return `Judge whether the current execution satisfies the contract for "${task.contract.objective}".`;
    default:
      return task.contract.objective;
  }
}

function buildManagedWorkerRoundSummary(
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  result: KodaXResult,
  round: number,
  directive: ManagedTaskScoutDirective | ManagedTaskContractDirective | ManagedTaskVerdictDirective | undefined,
): KodaXRoleRoundSummary | undefined {
  if (worker.role !== 'scout' && worker.role !== 'planner' && worker.role !== 'evaluator') {
    return undefined;
  }

  const visibleText = sanitizeManagedUserFacingText(extractMessageText(result) || result.lastText).trim();
  const fallbackSummary = truncateText(visibleText || 'No prior visible summary captured.', 320);
  const summary: KodaXRoleRoundSummary = {
    role: worker.role,
    round,
    objective: buildRoleRoundSummaryObjective(task, worker),
    confirmedConclusions: [],
    unresolvedQuestions: [],
    nextFocus: [],
    summary: fallbackSummary,
    sourceWorkerId: worker.id,
    updatedAt: new Date().toISOString(),
  };

  if (worker.role === 'scout') {
    const scoutDirective = directive as ManagedTaskScoutDirective | undefined;
    summary.summary = truncateText(scoutDirective?.summary || fallbackSummary, 320);
    summary.confirmedConclusions = [
      scoutDirective?.summary,
      scoutDirective?.confirmedHarness ? `Recommended harness: ${scoutDirective.confirmedHarness}` : undefined,
    ].filter((item): item is string => Boolean(item)).slice(0, 3);
    summary.unresolvedQuestions = (scoutDirective?.requiredEvidence ?? []).slice(0, 4);
    summary.nextFocus = [
      ...(scoutDirective?.reviewFilesOrAreas ?? []),
      ...(scoutDirective?.scope ?? []),
    ].filter(Boolean).slice(0, 4);
    return summary;
  }

  if (worker.role === 'planner') {
    const contractDirective = directive as ManagedTaskContractDirective | undefined;
    summary.summary = truncateText(contractDirective?.summary || fallbackSummary, 320);
    summary.confirmedConclusions = [
      contractDirective?.summary,
      ...(contractDirective?.successCriteria ?? []),
    ].filter((item): item is string => Boolean(item)).slice(0, 4);
    summary.unresolvedQuestions = (contractDirective?.requiredEvidence ?? []).slice(0, 4);
    summary.nextFocus = (contractDirective?.constraints ?? []).slice(0, 4);
    return summary;
  }

  const verdictDirective = directive as ManagedTaskVerdictDirective | undefined;
  summary.summary = truncateText(verdictDirective?.reason || fallbackSummary, 320);
  summary.confirmedConclusions = [
    verdictDirective?.status ? `Verdict: ${verdictDirective.status}` : undefined,
    verdictDirective?.reason,
  ].filter((item): item is string => Boolean(item)).slice(0, 3);
  summary.unresolvedQuestions = verdictDirective?.status === 'accept'
    ? []
    : (verdictDirective?.followups ?? []).slice(0, 4);
  summary.nextFocus = (verdictDirective?.followups ?? []).slice(0, 4);
  return summary;
}

function buildProtocolRetryRoleSummary(
  worker: ManagedTaskWorkerSpec,
  result: KodaXResult | undefined,
  round: number,
  reason: string,
): KodaXRoleRoundSummary | undefined {
  if (!result) {
    return undefined;
  }

  const visibleText = sanitizeManagedUserFacingText(extractMessageText(result) || result.lastText).trim();
  return {
    role: worker.role,
    round,
    objective: `Retry the ${worker.title} role after a protocol formatting failure.`,
    confirmedConclusions: visibleText ? [truncateText(visibleText, 200)] : [],
    unresolvedQuestions: [reason],
    nextFocus: [`Re-run ${worker.title} and append the required closing block exactly once.`],
    summary: truncateText(visibleText || `Previous ${worker.title} output could not be consumed.`, 320),
    sourceWorkerId: worker.id,
    updatedAt: new Date().toISOString(),
  };
}

function buildCompactInitialMessages(
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  storage: ManagedWorkerSessionStorage | undefined,
  round: number,
): KodaXSessionData['messages'] | undefined {
  const sessionId = buildManagedWorkerSessionId(task, worker);
  const memoryNote = storage?.loadMemoryNote(sessionId)
    ?? buildManagedWorkerMemoryNote(task, worker, undefined, round);
  if (!memoryNote.trim()) {
    return undefined;
  }
  return [
    {
      role: 'system',
      content: memoryNote,
    },
  ];
}

function resolveManagedTaskMaxRounds(
  options: KodaXOptions,
  plan: ReasoningPlan,
  agentMode: KodaXAgentMode,
): number {
  return createManagedBudgetController(options, plan, agentMode).plannedRounds;
}

function resolveManagedTaskQualityAssuranceMode(
  options: KodaXOptions,
  plan: ReasoningPlan,
): ManagedTaskQualityAssuranceMode {
  if (plan.decision.harnessProfile === 'H1_EXECUTE_EVAL' || plan.decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL') {
    return 'required';
  }

  const primaryTask = String(plan.decision.primaryTask);
  const verification = options.context?.taskVerification;
  const explicitVerification = Boolean(
    verification?.instructions?.length
    || verification?.requiredChecks?.length
    || verification?.requiredEvidence?.length
    || verification?.capabilityHints?.length
  );
  const readOnlyLike =
    plan.decision.mutationSurface === 'read-only'
    || plan.decision.mutationSurface === 'docs-only';

  if (readOnlyLike) {
    return explicitVerification || plan.decision.assuranceIntent === 'explicit-check' || primaryTask === 'verify'
      ? 'required'
      : 'optional';
  }

  if (
    plan.decision.needsIndependentQA
    || plan.decision.riskLevel === 'high'
    || plan.decision.requiresBrainstorm
    || options.context?.taskSurface === 'project'
    || options.context?.providerPolicyHints?.longRunning
    || options.context?.longRunning
    || explicitVerification
    || primaryTask === 'verify'
    || primaryTask === 'plan'
    || plan.decision.recommendedMode === 'pr-review'
    || plan.decision.recommendedMode === 'strict-audit'
  ) {
    return 'required';
  }

  return 'optional';
}

function isReviewEvidenceTask(decision: KodaXTaskRoutingDecision): boolean {
  return decision.primaryTask === 'review' || decision.recommendedMode === 'strict-audit';
}

function formatManagedEvidenceRuntime(
  runtime: KodaXManagedTask['runtime'],
): string | undefined {
  if (!runtime) {
    return undefined;
  }

  const parts: string[] = [];
  if (runtime.evidenceAcquisitionMode) {
    parts.push(`mode=${runtime.evidenceAcquisitionMode}`);
  }
  if (runtime.toolOutputTruncated) {
    parts.push('toolOutputTruncated=yes');
  }
  if (runtime.reviewFilesOrAreas?.length) {
    parts.push(`reviewTargets=${runtime.reviewFilesOrAreas.slice(0, 6).join(' | ')}`);
  }
  if (runtime.toolOutputTruncationNotes?.length) {
    parts.push(`truncationHints=${runtime.toolOutputTruncationNotes.slice(0, 3).join(' | ')}`);
  }
  if ((runtime.consecutiveEvidenceOnlyIterations ?? 0) >= EVIDENCE_ONLY_ITERATION_THRESHOLD) {
    parts.push('recovery=switch-to-diff-bundle');
  }

  if (parts.length === 0) {
    return undefined;
  }

  return `[Managed Task Evidence] ${parts.join('; ')}.`;
}

function getEvidenceAcquisitionModeRank(mode: ManagedEvidenceAcquisitionMode | undefined): number {
  switch (mode) {
    case 'diff-bundle':
      return 4;
    case 'diff-slice':
      return 3;
    case 'file-read':
      return 2;
    case 'overview':
      return 1;
    default:
      return 0;
  }
}

function mergeEvidenceAcquisitionMode(
  current: ManagedEvidenceAcquisitionMode | undefined,
  next: ManagedEvidenceAcquisitionMode | undefined,
): ManagedEvidenceAcquisitionMode | undefined {
  return getEvidenceAcquisitionModeRank(next) >= getEvidenceAcquisitionModeRank(current)
    ? next
    : current;
}

const TOOL_TRUNCATION_MARKERS = [
  'Tool output truncated',
  'Bash output truncated',
  'stdout capture capped',
  'stderr capture capped',
  'Diff preview truncated',
] as const;

function collectManagedToolTelemetry(result: KodaXResult): ManagedToolTelemetry {
  const toolNamesById = new Map<string, string>();
  const truncationNotes: string[] = [];
  let evidenceAcquisitionMode: ManagedEvidenceAcquisitionMode | undefined;
  let toolOutputTruncated = false;

  for (const message of result.messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'tool_use') {
        toolNamesById.set(part.id, part.name);
        continue;
      }
      if (part.type !== 'tool_result' || typeof part.content !== 'string') {
        continue;
      }
      const toolName = toolNamesById.get(part.tool_use_id);
      if (toolName === 'changed_diff_bundle') {
        evidenceAcquisitionMode = mergeEvidenceAcquisitionMode(evidenceAcquisitionMode, 'diff-bundle');
      } else if (toolName === 'changed_diff') {
        evidenceAcquisitionMode = mergeEvidenceAcquisitionMode(evidenceAcquisitionMode, 'diff-slice');
      } else if (toolName === 'read') {
        evidenceAcquisitionMode = mergeEvidenceAcquisitionMode(evidenceAcquisitionMode, 'file-read');
      } else if (toolName === 'changed_scope' || toolName === 'repo_overview') {
        evidenceAcquisitionMode = mergeEvidenceAcquisitionMode(evidenceAcquisitionMode, 'overview');
      }

      const matchingLines = part.content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => TOOL_TRUNCATION_MARKERS.some((marker) => line.includes(marker)));
      if (matchingLines.length > 0) {
        toolOutputTruncated = true;
        for (const line of matchingLines) {
          if (!truncationNotes.includes(line)) {
            truncationNotes.push(line);
          }
        }
      }
    }
  }

  return {
    toolOutputTruncated,
    toolOutputTruncationNotes: truncationNotes.slice(0, 6),
    evidenceAcquisitionMode,
  };
}

const REVIEW_PROGRESS_PREFIXES = [
  'now let me',
  'let me',
  'i will now',
  '现在让我',
  '让我',
  '接下来我',
  '现在我来',
] as const;

function looksLikeEvidenceOnlyProgress(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return REVIEW_PROGRESS_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isSubstantiveReviewSynthesis(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.length >= 160) {
    return true;
  }

  return (
    normalized.includes('must fix')
    || normalized.includes('optional improvements')
    || normalized.includes('finding')
    || normalized.includes('必须修复')
    || normalized.includes('建议')
    || normalized.includes('问题')
  );
}

function computeEvidenceOnlyIterationCount(
  runtime: KodaXManagedTask['runtime'],
  telemetry: ManagedToolTelemetry,
  result: KodaXResult,
): number | undefined {
  const visibleText = sanitizeManagedUserFacingText(extractMessageText(result) || result.lastText).trim();
  const mode = telemetry.evidenceAcquisitionMode;
  if (!mode) {
    return isSubstantiveReviewSynthesis(visibleText) ? 0 : runtime?.consecutiveEvidenceOnlyIterations;
  }

  if (mode === 'diff-bundle') {
    return 0;
  }

  if (mode !== 'diff-slice' && mode !== 'file-read') {
    return runtime?.consecutiveEvidenceOnlyIterations;
  }

  const evidenceOnly = !isSubstantiveReviewSynthesis(visibleText) && looksLikeEvidenceOnlyProgress(visibleText);
  if (!evidenceOnly) {
    return 0;
  }

  return (runtime?.consecutiveEvidenceOnlyIterations ?? 0) + 1;
}

function applyManagedToolTelemetry(
  task: KodaXManagedTask,
  result: KodaXResult,
): KodaXManagedTask {
  const telemetry = collectManagedToolTelemetry(result);
  if (
    !telemetry.toolOutputTruncated
    && !telemetry.evidenceAcquisitionMode
    && telemetry.toolOutputTruncationNotes.length === 0
  ) {
    return task;
  }

  const runtime = task.runtime ?? {};
  const truncationNotes = Array.from(new Set([
    ...(runtime.toolOutputTruncationNotes ?? []),
    ...telemetry.toolOutputTruncationNotes,
  ]));
  const consecutiveEvidenceOnlyIterations = computeEvidenceOnlyIterationCount(runtime, telemetry, result);

  return {
    ...task,
    runtime: {
      ...runtime,
      toolOutputTruncated: runtime.toolOutputTruncated || telemetry.toolOutputTruncated,
      toolOutputTruncationNotes: truncationNotes.length > 0 ? truncationNotes : runtime.toolOutputTruncationNotes,
      evidenceAcquisitionMode: mergeEvidenceAcquisitionMode(
        runtime.evidenceAcquisitionMode,
        telemetry.evidenceAcquisitionMode,
      ),
      consecutiveEvidenceOnlyIterations,
    },
  };
}

const WRITE_ONLY_TOOLS = new Set([
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'delete',
  'remove',
  'rename',
  'move',
  'create',
  'create_file',
  'create_resource',
  'scene_create',
  'scene_node_add',
  'scene_node_delete',
  'scene_node_set',
  'scene_save',
  'script_create',
  'script_modify',
  'project_setting_set',
  'signal_connect',
]);

const SHELL_PATTERN_CACHE = new Map<string, RegExp>();
const WRITE_PATH_PATTERN_CACHE = new Map<string, RegExp>();

const INSPECTION_SHELL_PATTERNS = [
  '^(?:git\\s+(?:status|diff|show|log|branch|rev-parse|ls-files))\\b',
  '^(?:Get-ChildItem|Get-Content|Select-String|type|dir|ls|cat)\\b',
  '^(?:findstr|where|pwd|cd)\\b',
  '^(?:node|npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:lint|typecheck|check|list|why)\\b',
];

const DOCS_ONLY_WRITE_PATH_PATTERNS = [
  '\\.(?:md|mdx|txt|rst|adoc)$',
  '(?:^|/)(?:docs?|documentation|design|requirements?|specs?|plans?|notes?|reports?)(?:/|$)',
  '(?:^|/)(?:README|CHANGELOG|FEATURE_LIST|KNOWN_ISSUES|PRD|ADR|HLD|DD)(?:\\.[^/]+)?$',
] as const;

const SCOUT_ALLOWED_TOOLS = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'glob',
  'grep',
  'read',
] as const;

const PLANNER_ALLOWED_TOOLS = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'glob',
  'grep',
  'read',
] as const;

const H1_EVALUATOR_ALLOWED_TOOLS = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'changed_diff',
  'glob',
  'grep',
  'read',
] as const;

const H1_READONLY_GENERATOR_ALLOWED_TOOLS = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'changed_diff',
  'glob',
  'grep',
  'read',
] as const;

const VERIFICATION_SHELL_PATTERNS = [
  ...INSPECTION_SHELL_PATTERNS,
  '^(?:agent-browser)\\b',
  '^(?:npx\\s+)?playwright\\b',
  '^(?:npx\\s+)?vitest\\b',
  '^(?:npx\\s+)?jest\\b',
  '^(?:npx\\s+)?cypress\\b',
  '^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|test:[^\\s]+|e2e|e2e:[^\\s]+|verify|verify:[^\\s]+|build|build:[^\\s]+|lint|lint:[^\\s]+|typecheck|typecheck:[^\\s]+)\\b',
  '^(?:pytest|go\\s+test|cargo\\s+test|dotnet\\s+test|mvn\\s+test|gradle\\s+test)\\b',
];

const SHELL_WRITE_PATTERNS = [
  '\\b(?:Set-Content|Add-Content|Out-File|Tee-Object|Copy-Item|Move-Item|Rename-Item|Remove-Item|New-Item|Clear-Content)\\b',
  '\\b(?:rm|mv|cp|del|erase|touch|mkdir|rmdir|rename|ren)\\b',
  '\\b(?:sed\\s+-i|perl\\s+-pi|python\\s+-c|node\\s+-e)\\b',
  '(?:^|\\s)(?:>|>>)(?!(?:\\s*&1|\\s*2>&1))',
];

const REVIEW_LARGE_FILE_THRESHOLD = 10;
const REVIEW_LARGE_LINE_THRESHOLD = 1200;
const REVIEW_LARGE_MODULE_THRESHOLD = 3;
const REVIEW_MASSIVE_FILE_THRESHOLD = 30;
const REVIEW_MASSIVE_LINE_THRESHOLD = 4000;
const REVIEW_MASSIVE_MODULE_THRESHOLD = 5;

function parsePromptInteger(prompt: string, pattern: RegExp): number | undefined {
  const match = prompt.match(pattern);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1]?.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferPromptReviewScale(
  prompt: string,
): KodaXTaskRoutingDecision['reviewScale'] | undefined {
  const normalized = prompt.toLowerCase();
  const promptFileCount = parsePromptInteger(normalized, /(\d[\d,]*)\s*(?:\+)?\s*files?\b/);
  const promptLineCount = parsePromptInteger(
    normalized,
    /(\d[\d,]*)\s*(?:\+)?\s*(?:changed\s*)?(?:lines?|loc)\b/,
  );

  if (
    (promptFileCount ?? 0) >= REVIEW_MASSIVE_FILE_THRESHOLD
    || (promptLineCount ?? 0) >= REVIEW_MASSIVE_LINE_THRESHOLD
  ) {
    return 'massive';
  }

  if (
    (promptFileCount ?? 0) >= REVIEW_LARGE_FILE_THRESHOLD
    || (promptLineCount ?? 0) >= REVIEW_LARGE_LINE_THRESHOLD
  ) {
    return 'large';
  }

  return undefined;
}

function deriveFallbackReviewScale(
  prompt: string,
  repoSignals?: KodaXRepoRoutingSignals,
): KodaXTaskRoutingDecision['reviewScale'] | undefined {
  if (repoSignals?.reviewScale) {
    return repoSignals.reviewScale;
  }

  const touchedModules = repoSignals?.touchedModuleCount ?? 0;
  const changedFiles = repoSignals?.changedFileCount ?? 0;
  const changedLines = repoSignals?.changedLineCount ?? 0;

  if (
    changedFiles >= REVIEW_MASSIVE_FILE_THRESHOLD
    || changedLines >= REVIEW_MASSIVE_LINE_THRESHOLD
    || touchedModules >= REVIEW_MASSIVE_MODULE_THRESHOLD
  ) {
    return 'massive';
  }

  if (
    changedFiles >= REVIEW_LARGE_FILE_THRESHOLD
    || changedLines >= REVIEW_LARGE_LINE_THRESHOLD
    || touchedModules >= REVIEW_LARGE_MODULE_THRESHOLD
  ) {
    return 'large';
  }

  return inferPromptReviewScale(prompt);
}

function inferReviewTarget(prompt: string): ManagedReviewTarget {
  const normalized = ` ${prompt.toLowerCase()} `;
  if (
    /\b(compare|range|between|since|from\s+\S+\s+to\s+\S+|commit-range|commit range|diff range)\b/.test(normalized)
    || /提交范围|提交区间|版本范围|对比.*提交|比较.*提交/.test(prompt)
  ) {
    return 'compare-range';
  }

  if (
    /\b(current|worktree|workspace|working tree|staged|unstaged|uncommitted|local changes?|current code changes?|current workspace changes?)\b/.test(normalized)
    || /当前(?:工作区|代码)?改动|当前代码改动|当前工作区改动|所有当前代码改动/.test(prompt)
  ) {
    return 'current-worktree';
  }

  return 'general';
}

function isDiffDrivenReviewPrompt(prompt: string): boolean {
  const normalized = ` ${prompt.toLowerCase()} `;
  return (
    /\b(review|code review|audit|look at the changes|changed files|current code changes?|current workspace changes?)\b/.test(normalized)
    || /review一下|评审|审查|看下改动|代码改动/.test(prompt)
  );
}

function cloneRoutingDecisionWithReviewTarget(
  decision: KodaXTaskRoutingDecision,
  reviewTarget: ManagedReviewTarget,
): KodaXTaskRoutingDecision {
  return {
    ...decision,
    reviewTarget,
  };
}

function formatHarnessProfileShort(
  harnessProfile?: KodaXTaskRoutingDecision['harnessProfile'],
): string | undefined {
  switch (harnessProfile) {
    case 'H0_DIRECT':
      return 'H0';
    case 'H1_EXECUTE_EVAL':
      return 'H1';
    case 'H2_PLAN_EXECUTE_EVAL':
      return 'H2';
    default:
      return harnessProfile;
  }
}

function formatManagedReviewTargetLabel(
  reviewTarget?: ManagedReviewTarget,
  reviewScale?: KodaXTaskRoutingDecision['reviewScale'],
): string | undefined {
  if (reviewTarget === 'current-worktree') {
    return `${reviewScale ? `${reviewScale} ` : ''}current-diff review`;
  }
  if (reviewTarget === 'compare-range') {
    return `${reviewScale ? `${reviewScale} ` : ''}compare-range review`;
  }
  if (reviewScale) {
    return `${reviewScale} review`;
  }
  return undefined;
}

function createLiveRoutingNote(
  rawDecision: KodaXTaskRoutingDecision,
  finalDecision: KodaXTaskRoutingDecision,
  repoSignals?: KodaXRepoRoutingSignals,
  reason?: string,
): string {
  const detailParts: string[] = [];
  const reviewLabel = formatManagedReviewTargetLabel(finalDecision.reviewTarget, finalDecision.reviewScale);

  if (reviewLabel) {
    detailParts.push(reviewLabel);
  }

  if ((repoSignals?.changedFileCount ?? 0) > 0 || (repoSignals?.changedLineCount ?? 0) > 0) {
    const scopeParts: string[] = [];
    if ((repoSignals?.changedFileCount ?? 0) > 0) {
      scopeParts.push(`${repoSignals?.changedFileCount ?? 0} files`);
    }
    if ((repoSignals?.changedLineCount ?? 0) > 0) {
      scopeParts.push(`${repoSignals?.changedLineCount ?? 0} lines`);
    }
    detailParts.push(scopeParts.join(' / '));
  }

  if (
    rawDecision.harnessProfile !== finalDecision.harnessProfile
    || rawDecision.upgradeCeiling !== finalDecision.upgradeCeiling
  ) {
    detailParts.push('override applied');
  }

  if (reason && !reviewLabel) {
    detailParts.push(reason);
  }

  return detailParts.length > 0
    ? `AMA routing · ${detailParts.join(' · ')}`
    : 'AMA routing';
}

function createRoutingBreadcrumb(
  rawDecision: KodaXTaskRoutingDecision,
  finalDecision: KodaXTaskRoutingDecision,
  reason?: string,
): string {
  const rawSource = rawDecision.routingSource ?? 'unknown';
  const base = `AMA routing: raw=${rawDecision.harnessProfile}(${rawSource}) -> final=${finalDecision.harnessProfile}`;
  if (reason) {
    return `${base} reason=${reason}`;
  }
  if (finalDecision.reviewTarget === 'current-worktree' && finalDecision.reviewScale) {
    return `${base} reason=${finalDecision.reviewScale} current-diff review`;
  }
  if (finalDecision.reviewTarget === 'current-worktree') {
    return `${base} reason=current-diff review (scale unavailable)`;
  }
  if (finalDecision.reviewTarget === 'compare-range' && finalDecision.reviewScale) {
    return `${base} reason=${finalDecision.reviewScale} compare-range review`;
  }
  if (finalDecision.reviewTarget === 'compare-range') {
    return `${base} reason=compare-range review (scale unavailable)`;
  }
  return base;
}

function applyCurrentDiffReviewRoutingFloor(
  plan: ReasoningPlan,
  prompt: string,
  repoSignals?: KodaXRepoRoutingSignals,
): {
  plan: ReasoningPlan;
  rawDecision: KodaXTaskRoutingDecision;
  reviewTarget: ManagedReviewTarget;
  routingOverrideReason?: string;
} {
  const reviewTarget = inferReviewTarget(prompt);
  const rawDecision = cloneRoutingDecisionWithReviewTarget(plan.decision, reviewTarget);
  const reviewScale = rawDecision.reviewScale ?? deriveFallbackReviewScale(prompt, repoSignals);
  const diffDrivenReview = reviewTarget !== 'general' && (
    rawDecision.primaryTask === 'review'
    || isDiffDrivenReviewPrompt(prompt)
  );

  if (!diffDrivenReview || !reviewScale) {
    const finalDecision = reviewScale
      ? { ...rawDecision, reviewScale }
      : rawDecision;
    if (finalDecision === plan.decision) {
      return {
        plan,
        rawDecision,
        reviewTarget,
      };
    }
    return {
      plan: {
        ...plan,
        decision: finalDecision,
        amaControllerDecision: buildAmaControllerDecision(finalDecision),
        promptOverlay: buildPromptOverlay(
          finalDecision,
          plan.providerPolicy?.routingNotes,
          plan.providerPolicy,
          buildAmaControllerDecision(finalDecision),
        ),
      },
      rawDecision,
      reviewTarget,
    };
  }

  const finalDecision: KodaXTaskRoutingDecision = {
    ...rawDecision,
    primaryTask: 'review',
    reviewScale,
    routingNotes: [
      ...(rawDecision.routingNotes ?? []),
      `Diff-driven review surface was classified as ${reviewScale}; use it to shape evidence acquisition, not to force a heavier harness.`,
    ],
    reason: `${rawDecision.reason} Diff-driven review scope was recorded for evidence strategy without forcing a heavier harness.`,
  };

  return {
    plan: {
      ...plan,
      decision: finalDecision,
      amaControllerDecision: buildAmaControllerDecision(finalDecision),
      promptOverlay: buildPromptOverlay(
        finalDecision,
        plan.providerPolicy?.routingNotes,
        plan.providerPolicy,
        buildAmaControllerDecision(finalDecision),
      ),
    },
    rawDecision,
    reviewTarget,
  };
}

function inferFallbackDecision(
  prompt: string,
  repoSignals?: KodaXRepoRoutingSignals,
): KodaXTaskRoutingDecision {
  const base = buildFallbackRoutingDecision(prompt, undefined, {
    repoSignals,
  });
  const normalized = ` ${prompt.toLowerCase()} `;
  const reviewScale = deriveFallbackReviewScale(prompt, repoSignals);
  const appendIntent = /\b(append|continue|extend|follow[- ]up|iterate)\b/.test(normalized);
  const overwriteIntent = /\b(overwrite|rewrite|replace|migrate|refactor)\b/.test(normalized);
  return {
    ...base,
    workIntent: overwriteIntent ? 'overwrite' : appendIntent ? 'append' : base.workIntent,
    reviewScale: reviewScale ?? base.reviewScale,
    reason: `${base.reason} Task-engine fallback preserved the core lightweight routing policy and only refined evidence hints.`,
    routingNotes: [
      ...(base.routingNotes ?? []),
      'Task-engine fallback avoided repo-size topology escalation and only adjusted evidence hints.',
    ],
  };
}

async function createManagedReasoningPlan(
  options: KodaXOptions,
  prompt: string,
): Promise<ManagedPlanningResult> {
  const intentGate = inferIntentGate(prompt);
  const shouldLoadRepoSignals = intentGate.shouldUseRepoSignals && Boolean(
    options.context?.executionCwd || options.context?.gitRoot,
  );
  const autoRepoMode = resolveKodaXAutoRepoMode(options.context?.repoIntelligenceMode);
  const repoRoutingSignals = options.context?.repoRoutingSignals
    ?? (
      shouldLoadRepoSignals && autoRepoMode !== 'off'
        ? await getRepoRoutingSignals({
          executionCwd: options.context?.executionCwd,
          gitRoot: options.context?.gitRoot ?? undefined,
        }, {
          mode: autoRepoMode,
        }).catch(() => null)
        : null
    );
  emitManagedRepoIntelligenceTrace(
    options.events,
    options,
    'routing',
    repoRoutingSignals,
    repoRoutingSignals?.activeModuleId
      ? `active_module=${repoRoutingSignals.activeModuleId}`
      : undefined,
  );
  try {
    const provider = resolveProvider(options.provider);
    const plan = await createReasoningPlan(options, prompt, provider, {
      repoSignals: repoRoutingSignals ?? undefined,
    });
    const floored = applyCurrentDiffReviewRoutingFloor(
      plan,
      prompt,
      repoRoutingSignals ?? undefined,
    );
    return {
      plan: floored.plan,
      repoRoutingSignals: repoRoutingSignals ?? undefined,
      rawDecision: floored.rawDecision,
      reviewTarget: floored.reviewTarget,
      routingOverrideReason: floored.routingOverrideReason,
    };
  } catch (error) {
    const decision = inferFallbackDecision(prompt, repoRoutingSignals ?? undefined);
    const mode = resolveReasoningMode(options);
    const depth = mode === 'auto'
      ? decision.recommendedThinkingDepth
      : mode === 'off'
        ? 'off'
        : reasoningModeToDepth(mode);

    const rawPlan: ReasoningPlan = {
      mode,
      depth,
      decision: {
        ...decision,
        recommendedThinkingDepth: depth,
        routingSource: 'retried-fallback',
        routingAttempts: Math.max(decision.routingAttempts ?? 1, MANAGED_TASK_ROUTER_MAX_RETRIES),
        routingNotes: [
          ...(decision.routingNotes ?? []),
          `Managed task engine used heuristic fallback routing because provider-backed routing was unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ],
      },
      amaControllerDecision: buildAmaControllerDecision({
        ...decision,
        recommendedThinkingDepth: depth,
        routingSource: 'retried-fallback',
        routingAttempts: Math.max(decision.routingAttempts ?? 1, MANAGED_TASK_ROUTER_MAX_RETRIES),
        routingNotes: [
          ...(decision.routingNotes ?? []),
          `Managed task engine used heuristic fallback routing because provider-backed routing was unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ],
      }),
      promptOverlay: buildPromptOverlay({
        ...decision,
        recommendedThinkingDepth: depth,
        routingSource: 'retried-fallback',
        routingAttempts: Math.max(decision.routingAttempts ?? 1, MANAGED_TASK_ROUTER_MAX_RETRIES),
        routingNotes: [
          ...(decision.routingNotes ?? []),
          'Managed task engine is running with heuristic fallback routing.',
        ],
      }),
    };
    const floored = applyCurrentDiffReviewRoutingFloor(
      rawPlan,
      prompt,
      repoRoutingSignals ?? undefined,
    );

    return {
      plan: floored.plan,
      repoRoutingSignals: repoRoutingSignals ?? undefined,
      rawDecision: floored.rawDecision,
      reviewTarget: floored.reviewTarget,
      routingOverrideReason: floored.routingOverrideReason,
    };
  }
}

function buildManagedWorkerAgent(role: KodaXTaskRole, workerId?: string): string {
  switch (role) {
    case 'scout':
      return 'ScoutAgent';
    case 'planner':
      return 'PlanningAgent';
    case 'generator':
      return 'ExecutionAgent';
    case 'evaluator':
      return 'EvaluationAgent';
    case 'direct':
    default:
      return 'DirectAgent';
  }
}

function buildManagedWorkerToolPolicy(
  role: KodaXTaskRole,
  verification: KodaXTaskVerificationContract | undefined,
  harnessProfile?: KodaXTaskRoutingDecision['harnessProfile'],
  mutationSurface?: KodaXTaskRoutingDecision['mutationSurface'],
  repoIntelligenceMode?: KodaXRepoIntelligenceMode,
): KodaXTaskToolPolicy | undefined {
  const strictRepoIntelligenceOff = resolveKodaXAutoRepoMode(repoIntelligenceMode) === 'off';
  const finalizeToolPolicy = (
    policy: KodaXTaskToolPolicy | undefined,
  ): KodaXTaskToolPolicy | undefined => {
    if (!policy || !strictRepoIntelligenceOff || !policy.allowedTools) {
      return policy;
    }

    return {
      ...policy,
      allowedTools: filterRepoIntelligenceWorkingToolNames(policy.allowedTools),
      summary: [
        policy.summary,
        'Repo-intelligence working tools are disabled in off mode; rely on general-purpose read/glob/grep evidence instead.',
      ].join(' '),
    };
  };

  switch (role) {
    case 'scout':
      return finalizeToolPolicy({
        summary: 'Scout is a pre-harness guide. It may inspect scope facts and a small amount of overview evidence, but must not deep-page raw diffs, verify claims file-by-file, mutate files, or execute implementation steps.',
        blockedTools: [...WRITE_ONLY_TOOLS],
        allowedTools: [...SCOUT_ALLOWED_TOOLS],
        allowedShellPatterns: INSPECTION_SHELL_PATTERNS,
      });
    case 'planner':
      return finalizeToolPolicy({
        summary: 'Planner may inspect scope facts and overview evidence to produce a sprint contract, but must not linearly page raw diffs, perform deep claim verification, mutate files, or execute implementation steps.',
        blockedTools: [...WRITE_ONLY_TOOLS],
        allowedTools: [...PLANNER_ALLOWED_TOOLS],
        allowedShellPatterns: INSPECTION_SHELL_PATTERNS,
      });
    case 'generator':
      if (harnessProfile === 'H1_EXECUTE_EVAL' && mutationSurface === 'read-only') {
        return finalizeToolPolicy({
          summary: 'H1 read-only Generator must stay non-mutating. It may inspect scoped evidence and run only limited inspection or explicitly required verification commands, but it must not edit files, rewrite artifacts, or perform mutating shell actions.',
          blockedTools: [...WRITE_ONLY_TOOLS],
          allowedTools: [...H1_READONLY_GENERATOR_ALLOWED_TOOLS],
          allowedShellPatterns: Array.from(new Set([
            ...INSPECTION_SHELL_PATTERNS,
            ...buildRuntimeVerificationShellPatterns(verification),
          ])),
        });
      }
      if (harnessProfile === 'H1_EXECUTE_EVAL' && mutationSurface === 'docs-only') {
        return finalizeToolPolicy({
          summary: 'H1 docs-only Generator may edit documentation artifacts, but only when the target paths are clearly documentation files. It must not modify source code, configuration, build outputs, or system state.',
          allowedWritePathPatterns: [...DOCS_ONLY_WRITE_PATH_PATTERNS],
          allowedShellPatterns: Array.from(new Set([
            ...INSPECTION_SHELL_PATTERNS,
            ...buildRuntimeVerificationShellPatterns(verification),
          ])),
        });
      }
      return undefined;
    case 'evaluator':
      if (harnessProfile === 'H1_EXECUTE_EVAL') {
        return finalizeToolPolicy({
          summary: 'H1 Evaluator is a lightweight checker. It may only do targeted spot-checks against the Generator handoff and must not broad-scan the repo, deep-page large diffs, or run broad test sweeps unless the verification contract explicitly requires them.',
          blockedTools: [...WRITE_ONLY_TOOLS],
          allowedTools: [...H1_EVALUATOR_ALLOWED_TOOLS],
          allowedShellPatterns: Array.from(new Set([
            ...INSPECTION_SHELL_PATTERNS,
            ...buildRuntimeVerificationShellPatterns(verification),
          ])),
        });
      }
      return finalizeToolPolicy({
        summary: 'Verification agents may inspect the repo and run verification commands, including browser, startup, API, and runtime checks declared by the verification contract, but must not edit project files or mutate control-plane artifacts.',
        blockedTools: [...WRITE_ONLY_TOOLS],
        allowedShellPatterns: [
          ...VERIFICATION_SHELL_PATTERNS,
          ...buildRuntimeVerificationShellPatterns(verification),
        ],
      });
    default:
      return undefined;
  }
}

function formatCapabilityHint(hint: KodaXTaskCapabilityHint): string {
  return `${hint.kind}:${hint.name}${hint.details ? ` - ${hint.details}` : ''}`;
}

function formatVerificationContract(
  verification: KodaXTaskVerificationContract | undefined,
): string | undefined {
  if (!verification) {
    return undefined;
  }

  const lines = [
    'Verification contract:',
    verification.summary ? `Summary: ${verification.summary}` : undefined,
    verification.rubricFamily ? `Rubric family: ${verification.rubricFamily}` : undefined,
    verification.instructions?.length
      ? ['Instructions:', ...verification.instructions.map((item) => `- ${item}`)].join('\n')
      : undefined,
    verification.requiredEvidence?.length
      ? ['Required evidence:', ...verification.requiredEvidence.map((item) => `- ${item}`)].join('\n')
      : undefined,
    verification.requiredChecks?.length
      ? ['Required checks:', ...verification.requiredChecks.map((item) => `- ${item}`)].join('\n')
      : undefined,
    verification.capabilityHints?.length
      ? ['Capability hints:', ...verification.capabilityHints.map((item) => `- ${formatCapabilityHint(item)}`)].join('\n')
      : undefined,
    verification.criteria?.length
      ? [
        'Verification criteria:',
        ...verification.criteria.map((criterion) => `- ${criterion.id}: ${criterion.label} (threshold=${criterion.threshold}, weight=${criterion.weight})`),
      ].join('\n')
      : undefined,
    verification.runtime
      ? [
        'Runtime under test:',
        verification.runtime.cwd ? `- cwd: ${verification.runtime.cwd}` : undefined,
        verification.runtime.startupCommand ? `- startupCommand: ${verification.runtime.startupCommand}` : undefined,
        verification.runtime.readySignal ? `- readySignal: ${verification.runtime.readySignal}` : undefined,
        verification.runtime.baseUrl ? `- baseUrl: ${verification.runtime.baseUrl}` : undefined,
        verification.runtime.uiFlows?.length ? `- uiFlows: ${verification.runtime.uiFlows.join(' | ')}` : undefined,
        verification.runtime.apiChecks?.length ? `- apiChecks: ${verification.runtime.apiChecks.join(' | ')}` : undefined,
        verification.runtime.dbChecks?.length ? `- dbChecks: ${verification.runtime.dbChecks.join(' | ')}` : undefined,
        verification.runtime.fixtures?.length ? `- fixtures: ${verification.runtime.fixtures.join(' | ')}` : undefined,
      ].filter((line): line is string => Boolean(line)).join('\n')
      : undefined,
    buildRuntimeExecutionGuide(verification)
      ? `Runtime execution guide:\n${buildRuntimeExecutionGuide(verification)?.trimEnd()}`
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 1 ? lines.join('\n') : undefined;
}

function formatTaskContract(task: KodaXManagedTask['contract']): string | undefined {
  const lines = [
    'Task contract:',
    task.contractSummary ? `Summary: ${task.contractSummary}` : undefined,
    task.successCriteria.length > 0
      ? ['Success criteria:', ...task.successCriteria.map((item) => `- ${item}`)].join('\n')
      : undefined,
    task.requiredEvidence.length > 0
      ? ['Required evidence:', ...task.requiredEvidence.map((item) => `- ${item}`)].join('\n')
      : undefined,
    task.constraints.length > 0
      ? ['Constraints:', ...task.constraints.map((item) => `- ${item}`)].join('\n')
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 1 ? lines.join('\n') : undefined;
}

function formatTaskMetadata(metadata: Record<string, KodaXJsonValue> | undefined): string | undefined {
  if (!metadata || Object.keys(metadata).length === 0) {
    return undefined;
  }

  return [
    'Task metadata:',
    JSON.stringify(metadata, null, 2),
  ].join('\n');
}

function formatToolPolicy(policy: KodaXTaskToolPolicy | undefined): string | undefined {
  if (!policy) {
    return undefined;
  }

  const lines = [
    'Tool policy:',
    `Summary: ${policy.summary}`,
    policy.allowedTools?.length
      ? `Allowed tools: ${policy.allowedTools.join(', ')}`
      : undefined,
    policy.blockedTools?.length
      ? `Blocked tools: ${policy.blockedTools.join(', ')}`
      : undefined,
    policy.allowedShellPatterns?.length
      ? ['Allowed shell patterns:', ...policy.allowedShellPatterns.map((pattern) => `- ${pattern}`)].join('\n')
      : undefined,
    policy.allowedWritePathPatterns?.length
      ? ['Allowed write path patterns:', ...policy.allowedWritePathPatterns.map((pattern) => `- ${pattern}`)].join('\n')
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 1 ? lines.join('\n') : undefined;
}

function formatManagedPromptOverlay(
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  terminalWorkerId: string,
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode,
): string {
  return [
    `[Managed Task] task=${task.contract.taskId}; role=${worker.role}; worker=${worker.id}; terminal=${worker.id === terminalWorkerId ? 'yes' : 'no'}; agent=${worker.agent ?? buildManagedWorkerAgent(worker.role)}; qa=${qualityAssuranceMode}; currentHarness=${task.contract.harnessProfile}; upgradeCeiling=${task.runtime?.upgradeCeiling ?? 'none'}.`,
    worker.memoryStrategy
      ? `[Managed Task Memory] strategy=${worker.memoryStrategy}.`
      : undefined,
    `Managed task artifacts: contract=${path.join(task.evidence.workspaceDir, 'contract.json')}; rounds=${path.join(task.evidence.workspaceDir, 'round-history.json')}; runtimeGuide=${path.join(task.evidence.workspaceDir, 'runtime-execution.md')}.`,
    worker.role !== 'scout'
      ? formatManagedScoutDecision(task.runtime)
      : undefined,
    formatManagedEvidenceRuntime(task.runtime),
    formatBudgetAdvisory(worker.budgetSnapshot),
    formatTaskContract(task.contract),
    formatTaskMetadata(task.contract.metadata),
    formatVerificationContract(task.contract.verification),
    formatToolPolicy(worker.toolPolicy),
  ]
    .filter((section): section is string => Boolean(section && section.trim()))
    .join('\n\n');
}

function formatManagedScoutDecision(
  runtime: KodaXManagedTask['runtime'],
): string | undefined {
  const scoutDecision = runtime?.scoutDecision;
  if (!scoutDecision) {
    return undefined;
  }

  const lines = [
    'Scout handoff:',
    `Summary: ${scoutDecision.summary}`,
    `Confirmed harness: ${scoutDecision.recommendedHarness}`,
    scoutDecision.evidenceAcquisitionMode
      ? `Evidence acquisition mode: ${scoutDecision.evidenceAcquisitionMode}`
      : undefined,
    formatOptionalListSection('Scope facts:', scoutDecision.scope),
    formatOptionalListSection('Required evidence:', scoutDecision.requiredEvidence),
    formatOptionalListSection('Priority files or areas:', scoutDecision.reviewFilesOrAreas),
  ].filter((line): line is string => Boolean(line));

  return lines.length > 1 ? lines.join('\n') : undefined;
}

function matchesShellPattern(command: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  return patterns.some((pattern) => {
    let compiled = SHELL_PATTERN_CACHE.get(pattern);
    if (!compiled) {
      compiled = new RegExp(pattern, 'i');
      SHELL_PATTERN_CACHE.set(pattern, compiled);
    }
    return compiled.test(command);
  });
}

function matchesWritePathPattern(filePath: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  const normalizedPath = filePath.replace(/\\/g, '/');
  return patterns.some((pattern) => {
    let compiled = WRITE_PATH_PATTERN_CACHE.get(pattern);
    if (!compiled) {
      compiled = new RegExp(pattern, 'i');
      WRITE_PATH_PATTERN_CACHE.set(pattern, compiled);
    }
    return compiled.test(normalizedPath);
  });
}

function isPathLikeToolInputKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === 'path'
    || normalized === 'paths'
    || normalized.endsWith('path')
    || normalized.endsWith('paths')
    || normalized.endsWith('_path')
    || normalized.endsWith('_paths');
}

function collectToolInputPaths(
  value: unknown,
  keyHint?: string,
  seen?: Set<object>,
): string[] {
  if (typeof value === 'string') {
    return keyHint && isPathLikeToolInputKey(keyHint) ? [value] : [];
  }

  if (Array.isArray(value)) {
    const paths: string[] = [];
    for (const item of value) {
      paths.push(...collectToolInputPaths(item, keyHint, seen));
    }
    return paths;
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const nextSeen = seen ?? new Set<object>();
  if (nextSeen.has(value)) {
    return [];
  }
  nextSeen.add(value);

  const paths: string[] = [];
  for (const [childKey, childValue] of Object.entries(value)) {
    paths.push(...collectToolInputPaths(childValue, childKey, nextSeen));
  }
  return paths;
}

function createToolPolicyHook(
  worker: ManagedTaskWorkerSpec,
): KodaXEvents['beforeToolExecute'] | undefined {
  const toolPolicy = worker.toolPolicy;
  if (!toolPolicy) {
    return undefined;
  }

  return async (tool, input) => {
    const normalizedTool = tool.toLowerCase();
    if (toolPolicy.blockedTools?.some((blocked) => blocked.toLowerCase() === normalizedTool)) {
      return `[Managed Task ${worker.title}] Tool "${tool}" is blocked for this role. ${toolPolicy.summary}`;
    }

    if (WRITE_ONLY_TOOLS.has(normalizedTool) && toolPolicy.allowedWritePathPatterns?.length) {
      const targetPaths = Array.from(new Set(collectToolInputPaths(input)));
      if (targetPaths.length === 0) {
        return `[Managed Task ${worker.title}] Tool "${tool}" is blocked because the target path could not be verified against the docs-only boundary. ${toolPolicy.summary}`;
      }
      const disallowedPath = targetPaths.find((targetPath) => !matchesWritePathPattern(targetPath, toolPolicy.allowedWritePathPatterns));
      if (disallowedPath) {
        return `[Managed Task ${worker.title}] Tool "${tool}" is blocked because "${disallowedPath}" is outside the allowed docs-only write boundary. ${toolPolicy.summary}`;
      }
    }

    if (normalizedTool === 'bash' && typeof input.command === 'string') {
      const command = input.command.trim();
      if (matchesShellPattern(command, SHELL_WRITE_PATTERNS)) {
        return `[Managed Task ${worker.title}] Shell command blocked because this role is verification-only or planning-only. ${toolPolicy.summary}`;
      }
      if (matchesShellPattern(command, toolPolicy.allowedShellPatterns)) {
        return true;
      }

      if (toolPolicy.allowedShellPatterns?.length) {
        return `[Managed Task ${worker.title}] Shell command is outside the allowed verification/planning boundary. ${toolPolicy.summary}`;
      }
    }

    if (
      toolPolicy.allowedTools?.length
      && !toolPolicy.allowedTools.some((allowed) => allowed.toLowerCase() === normalizedTool)
      && normalizedTool !== 'bash'
    ) {
      return `[Managed Task ${worker.title}] Tool "${tool}" is outside the allowed capability boundary. ${toolPolicy.summary}`;
    }

    return true;
  };
}

function createRolePrompt(
  role: KodaXTaskRole,
  prompt: string,
  decision: KodaXTaskRoutingDecision,
  verification: KodaXTaskVerificationContract | undefined,
  toolPolicy: KodaXTaskToolPolicy | undefined,
  agent: string,
  metadata: Record<string, KodaXJsonValue> | undefined,
  rolePromptContext: ManagedRolePromptContext | undefined,
  workerId?: string,
  isTerminalAuthority = false,
): string {
  const originalTask = rolePromptContext?.originalTask || prompt;
  const decisionSummary = [
    `Primary task: ${decision.primaryTask}`,
    `Mutation surface: ${decision.mutationSurface ?? 'unknown'}`,
    `Assurance intent: ${decision.assuranceIntent ?? 'default'}`,
    `Work intent: ${decision.workIntent}`,
    `Complexity: ${decision.complexity}`,
    `Risk: ${decision.riskLevel}`,
    `Harness: ${decision.harnessProfile}`,
    `Topology ceiling: ${decision.topologyCeiling ?? decision.upgradeCeiling ?? 'none'}`,
    `Brainstorm required: ${decision.requiresBrainstorm ? 'yes' : 'no'}`,
  ].join('\n');

  const sharedClosingRule = [
    'Preserve any exact machine-readable closing contract requested by the original task.',
    'Do not claim completion authority unless your role explicitly owns final judgment.',
    'When proposing shell commands or command examples, match the current host OS and shell. Do not assume Unix-only tools such as head on Windows.',
  ].join('\n');
  const originalTaskSection = `Original user request:\n${originalTask}`;
  const roundInstructionSection = prompt !== originalTask
    ? `Current round instructions:\n${prompt}`
    : undefined;

  const contractSection = formatTaskContract({
    taskId: 'preview',
    surface: 'cli',
    objective: originalTask,
    createdAt: '',
    updatedAt: '',
    status: 'running',
    primaryTask: decision.primaryTask,
    workIntent: decision.workIntent,
    complexity: decision.complexity,
    riskLevel: decision.riskLevel,
    harnessProfile: decision.harnessProfile,
    recommendedMode: decision.recommendedMode,
    requiresBrainstorm: decision.requiresBrainstorm,
    reason: decision.reason,
    contractSummary: undefined,
    successCriteria: [],
    requiredEvidence: verification?.requiredEvidence ?? [],
    constraints: [],
    metadata,
    verification,
  });
  const metadataSection = formatTaskMetadata(metadata);
  const verificationSection = formatVerificationContract(verification);
  const toolPolicySection = formatToolPolicy(toolPolicy);
  const agentSection = `Assigned native agent identity: ${agent}`;
  const skillInvocation = rolePromptContext?.skillInvocation;
  const skillMap = rolePromptContext?.skillMap;
  const previousRoleSummary = role === 'generator'
    ? undefined
    : rolePromptContext?.previousRoleSummaries?.[role];
  const scoutSkillSection = skillInvocation
    ? [
      formatSkillInvocationSummary(skillInvocation),
      'You own the first intelligent skill decomposition pass. Read the full expanded skill below, then map it into summary/obligations/ambiguities for the downstream harness.',
      formatFullSkillSection(skillInvocation),
    ].filter((section): section is string => Boolean(section)).join('\n\n')
    : undefined;
  const plannerSkillSection = skillMap
    ? [
      formatSkillMapSection(skillMap, rolePromptContext?.skillMapArtifactPath),
      'Use the skill map as the planning view of the skill. Do not rely on the raw skill workflow unless the map explicitly says it is low-confidence and missing critical obligations.',
    ].join('\n\n')
    : undefined;
  const generatorSkillSection = skillInvocation
    ? [
      skillMap ? formatSkillMapSection(skillMap, rolePromptContext?.skillMapArtifactPath) : undefined,
      formatSkillInvocationSummary(skillInvocation, rolePromptContext?.skillExecutionArtifactPath),
      decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
        ? 'You own execution. Treat the raw skill as the authoritative execution reference and the skill map as the coordination surface shared with Planner/Evaluator.'
        : 'You own execution. Treat the raw skill as the authoritative execution reference and the skill map as the lightweight coordination surface shared with Scout/Evaluator.',
      formatFullSkillSection(skillInvocation),
    ].filter((section): section is string => Boolean(section)).join('\n\n')
    : undefined;
  const evaluatorSkillSection = skillMap
    ? [
      formatSkillMapSection(skillMap, rolePromptContext?.skillMapArtifactPath),
      skillMap.rawSkillFallbackAllowed && rolePromptContext?.skillExecutionArtifactPath
        ? `Only if the skill map is incomplete or the Generator's claims conflict with it, reopen the raw skill artifact at ${rolePromptContext.skillExecutionArtifactPath}.`
        : undefined,
    ].filter((section): section is string => Boolean(section)).join('\n\n')
    : undefined;
  const previousRoleSummarySection = previousRoleSummary
    ? formatRoleRoundSummarySection(previousRoleSummary)
    : undefined;
  const reviewLikeTask = isReviewEvidenceTask(decision);
  const reviewPresentationRule = decision.primaryTask === 'review'
    ? 'When the task is review or audit, speak directly to the user about the final review findings. Do not frame the answer as grading or critiquing the Generator.'
    : undefined;
  const evaluatorPublicAnswerRule = decision.primaryTask === 'review'
    ? [
      'Your public answer must read like the final review report itself.',
      'Do not say that you verified, evaluated, graded, or judged the Generator, its handoff, or its findings.',
      'Do not mention the Planner, Generator, contract, or verdict process in the user-facing answer.',
      'Keep evaluator-only reasoning inside the final verdict block and supporting artifacts.',
    ].join('\n')
    : [
      'Speak directly to the user in the public answer.',
      'Do not describe yourself as reviewing or judging another role.',
      'Keep evaluator-only reasoning inside the final verdict block and supporting artifacts.',
    ].join('\n');
  const repoWorkingToolsEnabled = toolPolicy?.allowedTools
    ? toolPolicy.allowedTools.some((toolName) => isRepoIntelligenceWorkingToolName(toolName))
    : true;
  const diffPagingToolsEnabled = toolPolicy?.allowedTools
    ? toolPolicy.allowedTools.includes('changed_diff') || toolPolicy.allowedTools.includes('changed_diff_bundle')
    : true;
  const parallelBatchGuidance = [
    'When multiple read-only tool calls are independent, emit them in the same response so parallel mode can run them together.',
    'Only serialize tool calls when a later call depends on an earlier result.',
    'Keep parallel batches focused: prefer a few narrow grep/read/diff calls over many tiny sequential probes.',
  ].join('\n');
  const scoutReviewEvidenceGuidance = reviewLikeTask
    ? [
      repoWorkingToolsEnabled
        ? 'For large or history-based reviews, stay at the scope-facts level first: changed_scope -> repo_overview (only when needed) -> a small amount of changed_diff_bundle for high-priority files.'
        : 'For large or history-based reviews in off mode, stay at cheap facts first with glob/grep/read and avoid rebuilding a repo-intelligence-style scope pass.',
      diffPagingToolsEnabled
        ? 'Do not linearly page changed_diff slices or verify individual claims. You are only deciding whether the task should stay direct or move into a heavier harness.'
        : 'Do not linearly page raw file content or verify individual claims. You are only deciding whether the task should stay direct or move into a heavier harness.',
      'When one file dominates the diff, summarize the risk and first-inspection areas instead of paging through the whole file.',
    ].join('\n')
    : undefined;
  const plannerReviewEvidenceGuidance = reviewLikeTask
    ? [
      repoWorkingToolsEnabled
        ? 'Plan from scope facts plus overview evidence only: changed_scope -> repo_overview (only when needed) -> changed_diff_bundle for high-priority files.'
        : 'In off mode, plan from general-purpose evidence only: use glob/grep/read to anchor the contract without assuming repo-intelligence scope tooling is available.',
      diffPagingToolsEnabled
        ? 'Do not linearly page changed_diff slices for large files. If a bundle flags a critical entrypoint or type, use at most a small pinpoint read to anchor the contract.'
        : 'Do not linearly page raw file content for large files. Use at most a small pinpoint read to anchor the contract.',
      'If overview evidence is still incomplete, record the missing proof in required_evidence or constraints instead of omitting the contract.',
    ].join('\n')
    : undefined;
  const generatorReviewEvidenceGuidance = reviewLikeTask
    ? (
        decision.harnessProfile === 'H1_EXECUTE_EVAL'
          ? [
            'Consume the Scout handoff before collecting more evidence.',
            diffPagingToolsEnabled
              ? 'Own the focused deep-evidence pass: use changed_diff/read only on the handoff\'s priority files, suspicious areas, and unresolved claims.'
              : 'Own the focused deep-evidence pass with read/grep only on the handoff\'s priority files, suspicious areas, and unresolved claims.',
            'Do not restart whole-repo evidence gathering unless the Scout handoff explicitly leaves critical scope unresolved.',
            diffPagingToolsEnabled
              ? 'When one file dominates the diff, prefer fewer larger changed_diff slices (roughly limit=360-480) over repeated 100-150 line paging.'
              : 'When one file dominates the evidence, prefer fewer larger read slices over repeated tiny paging.',
          ]
          : [
            'Consume the Scout handoff and Planner contract before collecting more evidence.',
            diffPagingToolsEnabled
              ? 'Own the deep evidence pass: use changed_diff/read to inspect the contract\'s flagged files, suspicious areas, and unresolved claims.'
              : 'Own the deep evidence pass: use read/grep to inspect the contract\'s flagged files, suspicious areas, and unresolved claims.',
            'Do not restart whole-repo evidence gathering unless the contract explicitly leaves critical scope unresolved.',
            diffPagingToolsEnabled
              ? 'When one file dominates the diff, prefer fewer larger changed_diff slices (roughly limit=360-480) over repeated 100-150 line paging.'
              : 'When one file dominates the evidence, prefer fewer larger read slices over repeated tiny paging.',
          ]
      ).join('\n')
    : undefined;
  const h1GeneratorExecutionGuidance = decision.harnessProfile === 'H1_EXECUTE_EVAL'
    ? [
      'This is lightweight H1 checked-direct execution, not mini-H2.',
      'Start from the Scout handoff. Reuse its cheap-facts summary, scope notes, and evidence-acquisition hints instead of rebuilding them from scratch.',
      'Gather only the minimum deep evidence needed to answer well or to support one short revise pass.',
      'Do not create a planner-style execution plan, contract, or broad repo survey.',
      'Converge quickly on the user-facing answer and a crisp evidence handoff for the lightweight evaluator.',
    ].join('\n')
    : undefined;
  const h1MutationGuardance = decision.harnessProfile === 'H1_EXECUTE_EVAL'
    ? (
        decision.mutationSurface === 'read-only'
          ? 'This H1 run is read-only. Do not mutate files, code, or system state. If a tool or shell command would write or cause side effects, switch to a read-only inspection or verification alternative.'
          : decision.mutationSurface === 'docs-only'
            ? 'This H1 run is docs-only. Restrict any edits to documentation artifacts. Do not mutate code or system state.'
            : undefined
      )
    : undefined;
  const evaluatorReviewEvidenceGuidance = reviewLikeTask
    ? (
        decision.harnessProfile === 'H1_EXECUTE_EVAL'
          ? [
            'Start from the Scout handoff and Generator handoff.',
            diffPagingToolsEnabled
              ? 'Use targeted spot-checks on the highest-risk claims with changed_diff/read. Do not repeat the Generator\'s full deep-evidence pass unless the handoff is contradictory or structurally incomplete.'
              : 'Use targeted spot-checks on the highest-risk claims with read/grep. Do not repeat the Generator\'s full deep-evidence pass unless the handoff is contradictory or structurally incomplete.',
            diffPagingToolsEnabled
              ? 'When a tool reports truncated output, narrow the follow-up by path or offset, or switch from changed_diff to changed_diff_bundle instead of repeating the same broad request.'
              : 'When a tool reports truncated output, narrow the follow-up by path or offset instead of repeating the same broad request.',
          ]
          : [
            'Start from the Planner contract and Generator handoff.',
            diffPagingToolsEnabled
              ? 'Use targeted spot-checks on the highest-risk claims with changed_diff/read. Do not repeat the full deep-evidence pass unless the handoff is contradictory or structurally incomplete.'
              : 'Use targeted spot-checks on the highest-risk claims with read/grep. Do not repeat the full deep-evidence pass unless the handoff is contradictory or structurally incomplete.',
            diffPagingToolsEnabled
              ? 'When a tool reports truncated output, narrow the follow-up by path or offset, or switch from changed_diff to changed_diff_bundle instead of repeating the same broad request.'
              : 'When a tool reports truncated output, narrow the follow-up by path or offset instead of repeating the same broad request.',
          ]
      ).join('\n')
    : undefined;
  const handoffBlockInstructions = [
    `Append a final fenced block named \`\`\`${MANAGED_TASK_HANDOFF_BLOCK}\` with this exact shape:`,
    'status: ready|incomplete|blocked',
    'summary: <one-line handoff summary>',
    'evidence:',
    '- <evidence item>',
    'followup:',
    '- <required next step or "none">',
    '- <optional second next step>',
    'Keep the role output above the block.',
  ].join('\n');

  switch (role) {
    case 'scout':
      return [
        'You are the Scout role for a managed KodaX task.',
        decisionSummary,
        originalTaskSection,
        roundInstructionSection,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        parallelBatchGuidance,
        scoutSkillSection,
        previousRoleSummarySection,
        'Decide whether this task should stay direct or escalate to H1/H2. Prefer a direct answer whenever the task can be completed safely without heavier coordination.',
        'You are a pre-harness guide only. Prefer scope facts first: changed scope, module spread, diff size, verification requirements, and any explicit task constraints already present.',
        'If you confirm H0_DIRECT and already have enough evidence, finish the task yourself and give the final user-facing answer.',
        'If you confirm H1 or H2, stop after the cheap-facts pass. Do not keep exploring just to make the handoff more complete.',
        decision.mutationSurface === 'read-only' || decision.mutationSurface === 'docs-only'
          ? 'This task is capped below H2. Do not recommend H2 for read-only or docs-only work.'
          : undefined,
        scoutReviewEvidenceGuidance,
        [
          `Append a final fenced block named \`\`\`${MANAGED_TASK_SCOUT_BLOCK}\` with this exact shape:`,
          'summary: <one-line scout summary>',
          'confirmed_harness: <required H0_DIRECT|H1_EXECUTE_EVAL|H2_PLAN_EXECUTE_EVAL>',
          'evidence_acquisition_mode: <optional overview|diff-bundle|diff-slice|file-read>',
          'scope:',
          '- <scope item>',
          'required_evidence:',
          '- <evidence item>',
          'review_files_or_areas:',
          '- <path or area to inspect first>',
          'skill_summary: <optional one-line meaning of the skill in this request>',
          'projection_confidence: <optional high|medium|low>',
          'execution_obligations:',
          '- <optional execution obligation>',
          'verification_obligations:',
          '- <optional verification obligation>',
          'ambiguities:',
          '- <optional ambiguity or missing skill detail>',
          'Keep any user-facing answer or scout analysis above the block.',
        ].join('\n'),
        sharedClosingRule,
      ].filter((section): section is string => Boolean(section)).join('\n\n');
    case 'planner':
      return [
        'You are the Planner role for a managed KodaX task.',
        decisionSummary,
        originalTaskSection,
        roundInstructionSection,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        parallelBatchGuidance,
        plannerSkillSection,
        previousRoleSummarySection,
        plannerReviewEvidenceGuidance,
        'Produce a concise execution plan, the critical risks, and the evidence checklist.',
        `Your output is invalid unless it ends with a final \`\`\`${MANAGED_TASK_CONTRACT_BLOCK}\`\`\` fenced block.`,
        'Even if evidence is still incomplete, produce the best current contract and record the missing proof in required_evidence or constraints rather than omitting the block.',
        'Do not linearly page large raw diffs or perform file-by-file claim verification. Stop at overview evidence and hand deep inspection to the Generator.',
        'Do not perform the work yet and do not self-certify completion.',
        [
          `Append a final fenced block named \`\`\`${MANAGED_TASK_CONTRACT_BLOCK}\` with this exact shape:`,
          'summary: <one-line contract summary>',
          'success_criteria:',
          '- <criterion>',
          'required_evidence:',
          '- <evidence item>',
          'constraints:',
          '- <constraint or leave empty>',
        ].join('\n'),
        sharedClosingRule,
      ].filter((section): section is string => Boolean(section)).join('\n\n');
    case 'generator':
      return [
        'You are the Generator role for a managed KodaX task.',
        decisionSummary,
        originalTaskSection,
        roundInstructionSection,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        parallelBatchGuidance,
        generatorSkillSection,
        reviewPresentationRule,
        generatorReviewEvidenceGuidance,
        h1GeneratorExecutionGuidance,
        h1MutationGuardance,
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Execute the task or produce the requested deliverable.',
        isTerminalAuthority
          ? 'You are the terminal delivery role for this run. Return the final user-facing answer and summarize concrete evidence inline.'
          : 'Leave final judgment to the evaluator and include a crisp evidence handoff.',
        isTerminalAuthority ? undefined : handoffBlockInstructions,
        sharedClosingRule,
      ].filter(Boolean).join('\n\n');
    case 'evaluator':
      return [
        'You are the Evaluator role for a managed KodaX task.',
        decisionSummary,
        originalTaskSection,
        roundInstructionSection,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        parallelBatchGuidance,
        evaluatorSkillSection,
        previousRoleSummarySection,
        reviewPresentationRule,
        evaluatorReviewEvidenceGuidance,
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Judge whether the dependency handoff satisfies the original task and whether the evidence is strong enough.',
        decision.harnessProfile === 'H1_EXECUTE_EVAL'
          ? [
            'You are the lightweight H1 evaluator, not a second full executor.',
            'Only check whether the answer is on target, whether it misses obvious requested work, whether key claims have evidence, and whether the answer sounds obviously overconfident.',
            'Do not broad-scan the repo, do not linearly page large diffs, and do not rerun the Generator\'s whole analysis.',
            'Only run a limited spot-check when the task explicitly requires verification or the Generator claimed a concrete test/check that needs confirmation.',
            'Do not request a stronger harness. H1 must stay lightweight; if the answer is still incomplete after one short revise pass, return the best supported answer with explicit limits instead of escalating to H2.',
            'When status=revise, keep the user-facing text short and specific: list the missing items, evidence gaps, or overconfident claims that the Generator must fix next.',
            'Do not write a full polished final report when status=revise. Reserve the full final-report style for accept, or for blocked when you must return the best supported answer with explicit limits.',
          ].join('\n')
          : 'You own the final verification pass and must personally execute any required checks or browser validation before accepting the task.',
        'Evaluate the task against the verification criteria and thresholds. If any hard threshold is not met, do not accept the task.',
        evaluatorPublicAnswerRule,
        decision.topologyCeiling && decision.topologyCeiling !== 'H2_PLAN_EXECUTE_EVAL'
          ? `Do not request a stronger harness than ${decision.topologyCeiling}. If the task is still incomplete at that ceiling, return the best supported user-facing answer with explicit limits instead of escalating further.`
          : undefined,
        'Return the final user-facing answer. If the task is not ready, explain the blocker or missing evidence clearly.',
        'If the original task requires an exact closing block, include it in your final answer when you conclude.',
        [
          `Append a final fenced block named \`\`\`${MANAGED_TASK_VERDICT_BLOCK}\` with this exact shape:`,
          `status: accept|revise|blocked`,
          'reason: <one-line reason>',
          'user_answer: <optional final user-facing answer; multi-line content may continue on following lines>',
          decision.harnessProfile === 'H1_EXECUTE_EVAL'
            ? undefined
            : 'next_harness: <optional stronger harness when revise requires it>',
          'followup:',
          '- <required next step>',
          '- <optional second next step>',
          'Prefer putting the final user-facing answer in user_answer:. If omitted, keep the user-facing answer above the block. Use status=revise when more execution should happen before acceptance.',
        ].join('\n'),
      ].filter((section): section is string => Boolean(section)).join('\n\n');
    case 'direct':
    default:
      return prompt;
  }
}

function buildManagedTaskWorkers(
  prompt: string,
  decision: KodaXTaskRoutingDecision,
  metadata: Record<string, KodaXJsonValue> | undefined,
  verification: KodaXTaskVerificationContract | undefined,
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode,
  rolePromptContext: ManagedRolePromptContext | undefined,
  repoIntelligenceMode?: KodaXRepoIntelligenceMode,
  phase: 'initial' | 'refinement' = 'initial',
): { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] } {
  const evaluatorRequired = qualityAssuranceMode === 'required';
  const runPlanner = decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
    ? phase === 'initial'
    : false;
  const createWorker = (
    id: string,
    title: string,
    role: KodaXTaskRole,
    isTerminalAuthority: boolean,
    dependsOn?: string[],
    execution?: ManagedTaskWorkerSpec['execution'],
  ): ManagedTaskWorkerSpec => {
    const agent = buildManagedWorkerAgent(role, id);
    const toolPolicy = buildManagedWorkerToolPolicy(
      role,
      verification,
      decision.harnessProfile,
      decision.mutationSurface,
      repoIntelligenceMode,
    );
    const worker: ManagedTaskWorkerSpec = {
      id,
      title,
      role,
      terminalAuthority: isTerminalAuthority,
      dependsOn,
      execution,
      agent,
      toolPolicy,
      metadata: {
        role,
        agent,
      },
      prompt: createRolePrompt(
        role,
        prompt,
        decision,
        verification,
        toolPolicy,
        agent,
        metadata,
        rolePromptContext,
        id,
        isTerminalAuthority,
      ),
    };
    worker.beforeToolExecute = createToolPolicyHook(worker);
    return worker;
  };

  if (decision.harnessProfile === 'H1_EXECUTE_EVAL') {
    return {
      terminalWorkerId: 'evaluator',
      workers: [
        createWorker('generator', 'Generator', 'generator', false),
        createWorker('evaluator', 'Evaluator', 'evaluator', true, ['generator']),
      ],
    };
  }

  if (decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL') {
    if (!evaluatorRequired) {
      return {
        terminalWorkerId: 'generator',
        workers: [
          ...(runPlanner ? [createWorker('planner', 'Planner', 'planner', false)] : []),
          createWorker('generator', 'Generator', 'generator', true, runPlanner ? ['planner'] : undefined),
        ],
      };
    }

    return {
      terminalWorkerId: 'evaluator',
      workers: [
        ...(runPlanner ? [createWorker('planner', 'Planner', 'planner', false)] : []),
        createWorker('generator', 'Generator', 'generator', false, runPlanner ? ['planner'] : undefined),
        createWorker(
          'evaluator',
          'Evaluator',
          'evaluator',
          true,
          runPlanner ? ['planner', 'generator'] : ['generator'],
        ),
      ],
    };
  }

  return {
    terminalWorkerId: 'evaluator',
    workers: [
      createWorker('planner', 'Planner', 'planner', false),
      createWorker('generator', 'Generator', 'generator', false, ['planner']),
      createWorker('evaluator', 'Evaluator', 'evaluator', true, ['planner', 'generator']),
    ],
  };
}

function createParentReductionContract(
  controllerDecision: KodaXAmaControllerDecision,
): KodaXParentReductionContract {
  return {
    owner: 'parent',
    strategy: controllerDecision.profile === 'managed'
      ? 'evaluator-assisted'
      : controllerDecision.fanout.admissible
        ? 'evaluator-assisted'
        : 'direct-parent',
    collapseChildTranscripts: true,
    summary: controllerDecision.profile === 'managed'
      ? 'Parent authority remains singular while managed verifier/reducer roles converge the child outputs.'
      : controllerDecision.fanout.admissible
        ? 'Parent authority remains singular while tactical child outputs are reduced through an evaluator-assisted pass.'
        : 'Parent keeps direct ownership of the final answer without child reduction.',
    requiredArtifacts: controllerDecision.fanout.admissible
      ? ['child-result-ledger', 'dependency-handoff']
      : [],
  };
}

function applyAmaRuntimeState(
  runtime: KodaXManagedTaskRuntimeState | undefined,
  controllerDecision: KodaXAmaControllerDecision,
): KodaXManagedTaskRuntimeState {
  return {
    ...runtime,
    amaProfile: controllerDecision.profile,
    amaTactics: controllerDecision.tactics,
    amaFanout: controllerDecision.fanout,
    amaControllerReason: controllerDecision.reason,
    parentReductionContract: runtime?.parentReductionContract ?? createParentReductionContract(controllerDecision),
    childContextBundles: runtime?.childContextBundles ?? [],
    childAgentResults: runtime?.childAgentResults ?? [],
  };
}

function createTaskShape(
  options: KodaXOptions,
  prompt: string,
  originalTask: string,
  plan: ReasoningPlan,
  rolePromptContext?: ManagedRolePromptContext,
): ManagedTaskShape {
  const taskId = `task-${randomUUID()}`;
  const surface = getManagedTaskSurface(options);
  const workspaceDir = path.join(getManagedTaskWorkspaceRoot(options, surface), taskId);
  const workerRolePromptContext = withManagedSkillArtifactPromptPaths(rolePromptContext, workspaceDir);
  const createdAt = new Date().toISOString();
  const qualityAssuranceMode = resolveManagedTaskQualityAssuranceMode(options, plan);
  const amaControllerDecision = plan.amaControllerDecision;
  const normalizedVerification = options.context?.taskVerification
    ? {
        ...options.context.taskVerification,
        rubricFamily: inferVerificationRubricFamily(options.context.taskVerification, plan.decision.primaryTask),
        criteria: resolveVerificationCriteria(options.context.taskVerification, plan.decision.primaryTask),
        runtime: deriveRuntimeVerificationContract(options.context.taskVerification, options),
      }
    : undefined;

  if (plan.decision.harnessProfile === 'H0_DIRECT') {
    const task: KodaXManagedTask = {
      contract: {
        taskId,
        surface,
        objective: originalTask,
        createdAt,
        updatedAt: createdAt,
        status: 'running',
        primaryTask: plan.decision.primaryTask,
        workIntent: plan.decision.workIntent,
        complexity: plan.decision.complexity,
        riskLevel: plan.decision.riskLevel,
        harnessProfile: plan.decision.harnessProfile,
        recommendedMode: plan.decision.recommendedMode,
        requiresBrainstorm: plan.decision.requiresBrainstorm,
        reason: plan.decision.reason,
        contractSummary: undefined,
        successCriteria: [],
        requiredEvidence: options.context?.taskVerification?.requiredEvidence ?? [],
        constraints: [],
        metadata: options.context?.taskMetadata,
        verification: normalizedVerification,
      },
      roleAssignments: [
        {
          id: 'direct',
          role: 'direct',
          title: 'Direct Agent',
          dependsOn: [],
          status: 'running',
        },
      ],
      workItems: [
        {
          id: 'direct',
          assignmentId: 'direct',
          description: 'Handle the task directly in a single-agent fallback run.',
          execution: 'serial',
        },
      ],
      evidence: {
        workspaceDir,
        artifacts: [],
        entries: [],
        routingNotes: plan.decision.routingNotes ?? [],
      },
      verdict: {
        status: 'running',
        decidedByAssignmentId: 'direct',
        summary: 'Task is running in direct fallback mode.',
      },
      runtime: {
        ...applyAmaRuntimeState(undefined, amaControllerDecision),
        routingAttempts: plan.decision.routingAttempts,
        routingSource: plan.decision.routingSource,
        currentHarness: plan.decision.harnessProfile,
        upgradeCeiling: plan.decision.upgradeCeiling,
        harnessTransitions: [],
        skillMap: workerRolePromptContext?.skillMap,
      },
    };

    return {
      task,
      terminalWorkerId: 'direct',
      workers: [],
      workspaceDir,
      routingPromptOverlay: plan.promptOverlay,
      qualityAssuranceMode,
      providerPolicy: plan.providerPolicy,
      amaControllerDecision,
    };
  }

  const workerSet = buildManagedTaskWorkers(
    prompt,
    plan.decision,
    options.context?.taskMetadata,
    normalizedVerification,
    qualityAssuranceMode,
    workerRolePromptContext,
    options.context?.repoIntelligenceMode,
  );
  const task: KodaXManagedTask = {
    contract: {
      taskId,
      surface,
      objective: originalTask,
      createdAt,
      updatedAt: createdAt,
      status: 'running',
      primaryTask: plan.decision.primaryTask,
      workIntent: plan.decision.workIntent,
      complexity: plan.decision.complexity,
      riskLevel: plan.decision.riskLevel,
      harnessProfile: plan.decision.harnessProfile,
      recommendedMode: plan.decision.recommendedMode,
      requiresBrainstorm: plan.decision.requiresBrainstorm,
      reason: plan.decision.reason,
      contractSummary: undefined,
      successCriteria: [],
      requiredEvidence: options.context?.taskVerification?.requiredEvidence ?? [],
      constraints: [],
      metadata: options.context?.taskMetadata,
      verification: normalizedVerification,
    },
    roleAssignments: workerSet.workers.map((worker) => ({
      id: worker.id,
      role: worker.role,
      title: worker.title,
      dependsOn: worker.dependsOn ?? [],
      status: 'planned',
      agent: worker.agent,
      toolPolicy: worker.toolPolicy,
    })),
    workItems: workerSet.workers.map((worker) => ({
      id: worker.id,
      assignmentId: worker.id,
      description: worker.title,
      execution: worker.execution ?? 'serial',
    })),
    evidence: {
      workspaceDir,
      artifacts: [],
      entries: [],
      routingNotes: plan.decision.routingNotes ?? [],
    },
    verdict: {
      status: 'running',
      decidedByAssignmentId: workerSet.terminalWorkerId,
      summary: 'Task is running under the managed task engine.',
    },
    runtime: {
      ...applyAmaRuntimeState(undefined, amaControllerDecision),
      routingAttempts: plan.decision.routingAttempts,
      routingSource: plan.decision.routingSource,
      currentHarness: plan.decision.harnessProfile,
      upgradeCeiling: plan.decision.upgradeCeiling,
      harnessTransitions: [],
      skillMap: workerRolePromptContext?.skillMap,
    },
  };

  return {
    task,
    terminalWorkerId: workerSet.terminalWorkerId,
    workers: workerSet.workers,
    workspaceDir,
    routingPromptOverlay: plan.promptOverlay,
    qualityAssuranceMode,
    providerPolicy: plan.providerPolicy,
    amaControllerDecision,
  };
}

function createScoutCompleteTaskShape(
  options: KodaXOptions,
  prompt: string,
  originalTask: string,
  plan: ReasoningPlan,
  rolePromptContext?: ManagedRolePromptContext,
): ManagedTaskShape {
  const baseShape = createTaskShape(
    options,
    prompt,
    originalTask,
    {
      ...plan,
      decision: {
        ...plan.decision,
        harnessProfile: 'H0_DIRECT',
      },
    },
    rolePromptContext,
  );
  const scoutToolPolicy = buildManagedWorkerToolPolicy(
    'scout',
    baseShape.task.contract.verification,
    'H0_DIRECT',
    undefined,
    options.context?.repoIntelligenceMode,
  );
  const scoutAgent = buildManagedWorkerAgent('scout', 'scout');

  return {
    ...baseShape,
    terminalWorkerId: 'scout',
    workers: [
      {
        id: 'scout',
        role: 'scout',
        title: 'Scout',
        dependsOn: [],
        agent: scoutAgent,
        toolPolicy: scoutToolPolicy,
        memoryStrategy: 'reset-handoff',
        terminalAuthority: true,
        prompt: createRolePrompt(
          'scout',
          prompt,
          plan.decision,
          baseShape.task.contract.verification,
          scoutToolPolicy,
          scoutAgent,
          {
            role: 'scout',
            agent: scoutAgent,
          },
          rolePromptContext,
        ),
      },
    ],
    task: {
      ...baseShape.task,
      roleAssignments: [
        {
          id: 'scout',
          role: 'scout',
          title: 'Scout',
          dependsOn: [],
          status: 'running',
          agent: scoutAgent,
          toolPolicy: scoutToolPolicy,
        },
      ],
      workItems: [
        {
          id: 'scout',
          assignmentId: 'scout',
          description: 'Scout completes the task directly after preflight classification.',
          execution: 'serial',
        },
      ],
      verdict: {
        ...baseShape.task.verdict,
        decidedByAssignmentId: 'scout',
        summary: 'Scout is completing the task directly after preflight.',
      },
      runtime: {
        ...baseShape.task.runtime,
        currentHarness: 'H0_DIRECT',
      },
    },
  };
}

function shouldRunTacticalReviewFanout(
  agentMode: KodaXAgentMode,
  surface: KodaXTaskSurface,
  plan: ReasoningPlan,
  decision: KodaXTaskRoutingDecision,
  scoutDirective: ManagedTaskScoutDirective,
): boolean {
  return agentMode === 'ama'
    && surface !== 'project'
    && decision.primaryTask === 'review'
    && decision.executionPattern === 'checked-direct'
    && decision.harnessProfile === 'H0_DIRECT'
    && scoutDirective.confirmedHarness === 'H0_DIRECT'
    && plan.amaControllerDecision.profile === 'tactical'
    && plan.amaControllerDecision.fanout.admissible
    && plan.amaControllerDecision.fanout.class === 'finding-validation';
}

function shouldRunTacticalInvestigationFanout(
  agentMode: KodaXAgentMode,
  surface: KodaXTaskSurface,
  plan: ReasoningPlan,
  decision: KodaXTaskRoutingDecision,
  scoutDirective: ManagedTaskScoutDirective,
): boolean {
  return agentMode === 'ama'
    && surface !== 'project'
    && (decision.primaryTask === 'bugfix' || decision.recommendedMode === 'investigation')
    && decision.mutationSurface === 'read-only'
    && decision.harnessProfile === 'H0_DIRECT'
    && scoutDirective.confirmedHarness === 'H0_DIRECT'
    && plan.amaControllerDecision.profile === 'tactical'
    && plan.amaControllerDecision.fanout.admissible
    && plan.amaControllerDecision.fanout.class === 'evidence-scan';
}

function createTacticalReviewBaseShape(
  options: KodaXOptions,
  originalTask: string,
  plan: ReasoningPlan,
  rolePromptContext?: ManagedRolePromptContext,
): ManagedTaskShape {
  const baseShape = createTaskShape(
    options,
    originalTask,
    originalTask,
    {
      ...plan,
      decision: {
        ...plan.decision,
        harnessProfile: 'H0_DIRECT',
      },
    },
    rolePromptContext,
  );
  const scanToolPolicy = buildManagedWorkerToolPolicy(
    'generator',
    baseShape.task.contract.verification,
    'H0_DIRECT',
    'read-only',
    options.context?.repoIntelligenceMode,
  );
  const scanAgent = buildManagedWorkerAgent('generator', 'review-scan');

  return {
    ...baseShape,
    terminalWorkerId: 'review-reducer',
    workers: [],
    task: {
      ...baseShape.task,
      roleAssignments: [
        {
          id: 'review-scan',
          role: 'generator',
          title: 'Review Scanner',
          dependsOn: [],
          status: 'running',
          agent: scanAgent,
          toolPolicy: scanToolPolicy,
        },
      ],
      workItems: [
        {
          id: 'review-scan',
          assignmentId: 'review-scan',
          description: 'Scan the review surface and emit candidate findings for child validation.',
          execution: 'serial',
        },
      ],
      verdict: {
        ...baseShape.task.verdict,
        decidedByAssignmentId: 'review-reducer',
        summary: 'AMA Tactical review is preparing hidden finding-validation shards.',
      },
    },
  };
}

function createTacticalInvestigationBaseShape(
  options: KodaXOptions,
  originalTask: string,
  plan: ReasoningPlan,
  rolePromptContext?: ManagedRolePromptContext,
): ManagedTaskShape {
  const baseShape = createTaskShape(
    options,
    originalTask,
    originalTask,
    {
      ...plan,
      decision: {
        ...plan.decision,
        harnessProfile: 'H0_DIRECT',
      },
    },
    rolePromptContext,
  );
  const scanToolPolicy = buildManagedWorkerToolPolicy(
    'generator',
    baseShape.task.contract.verification,
    'H0_DIRECT',
    'read-only',
    options.context?.repoIntelligenceMode,
  );
  const scanAgent = buildManagedWorkerAgent('generator', 'investigation-scan');

  return {
    ...baseShape,
    terminalWorkerId: 'investigation-reducer',
    workers: [],
    task: {
      ...baseShape.task,
      roleAssignments: [
        {
          id: 'investigation-scan',
          role: 'generator',
          title: 'Investigation Scanner',
          dependsOn: [],
          status: 'running',
          agent: scanAgent,
          toolPolicy: scanToolPolicy,
        },
      ],
      workItems: [
        {
          id: 'investigation-scan',
          assignmentId: 'investigation-scan',
          description: 'Scan the investigation surface and emit bounded evidence shards for child validation.',
          execution: 'serial',
        },
      ],
      verdict: {
        ...baseShape.task.verdict,
        decidedByAssignmentId: 'investigation-reducer',
        summary: 'AMA Tactical investigation is preparing hidden evidence-scan shards.',
      },
    },
  };
}

function buildTacticalReviewScannerPrompt(
  originalTask: string,
  plan: ReasoningPlan,
  scoutDirective: ManagedTaskScoutDirective,
): string {
  return [
    'You are the Tactical Review Scanner for a KodaX AMA task.',
    `[AMA profile] ${plan.amaControllerDecision.profile}`,
    `[Task] ${originalTask}`,
    `[Routing] primary=${plan.decision.primaryTask}; mode=${plan.decision.recommendedMode}; harness=${plan.decision.harnessProfile}; reviewScale=${plan.decision.reviewScale ?? 'unknown'}.`,
    scoutDirective.summary ? `[Scout summary] ${scoutDirective.summary}` : undefined,
    scoutDirective.reviewFilesOrAreas?.length
      ? `Focus areas: ${scoutDirective.reviewFilesOrAreas.join(', ')}`
      : undefined,
    'Identify at most the highest-signal candidate findings that are worth independent validation.',
    'Do not write the final review yet.',
    [
      `Append a final JSON fenced block named \`\`\`${TACTICAL_REVIEW_FINDINGS_BLOCK}\`\`\` with this exact shape:`,
      '{"summary":"<one-line scanner summary>","findings":[{"id":"finding-1","title":"<short title>","claim":"<specific claim to validate>","priority":"high|medium|low","files":["<path>"],"evidence":["<short evidence note>"]}]}',
    ].join('\n'),
    'If you do not find any strong candidates, still return the best visible review summary before the fenced block and use an empty findings array.',
  ].filter((section): section is string => Boolean(section)).join('\n\n');
}

function buildTacticalInvestigationScannerPrompt(
  originalTask: string,
  plan: ReasoningPlan,
  scoutDirective: ManagedTaskScoutDirective,
): string {
  return [
    'You are the Tactical Investigation Scanner for a KodaX AMA task.',
    `[AMA profile] ${plan.amaControllerDecision.profile}`,
    `[Task] ${originalTask}`,
    `[Routing] primary=${plan.decision.primaryTask}; mode=${plan.decision.recommendedMode}; harness=${plan.decision.harnessProfile}; mutationSurface=${plan.decision.mutationSurface ?? 'unknown'}.`,
    scoutDirective.summary ? `[Scout summary] ${scoutDirective.summary}` : undefined,
    scoutDirective.scope.length > 0 ? `Scout scope: ${scoutDirective.scope.join(' | ')}` : undefined,
    scoutDirective.requiredEvidence.length > 0
      ? `Required evidence: ${scoutDirective.requiredEvidence.join(' | ')}`
      : undefined,
    'Identify at most the highest-signal bounded evidence questions that should be validated independently before the parent commits to a diagnosis.',
    'Do not write the final diagnosis yet and do not broaden the scope into a full repo sweep.',
    [
      `Append a final JSON fenced block named \`\`\`${TACTICAL_INVESTIGATION_SHARDS_BLOCK}\`\`\` with this exact shape:`,
      '{"summary":"<one-line investigation scanner summary>","shards":[{"id":"shard-1","question":"<single evidence question to validate>","scope":"<focused scope summary>","priority":"high|medium|low","files":["<path>"],"evidence":["<why this shard matters>"]}]}',
    ].join('\n'),
    'If you do not find any bounded evidence shards, still return the best visible investigation update before the fenced block and use an empty shards array.',
  ].filter((section): section is string => Boolean(section)).join('\n\n');
}

function buildTacticalReviewValidatorPrompt(
  originalTask: string,
  finding: TacticalReviewFinding,
  scoutDirective: ManagedTaskScoutDirective,
): string {
  return [
    'You are a Tactical Review Validator child for one candidate finding.',
    `[Task] ${originalTask}`,
    `[Finding ID] ${finding.id}`,
    `[Finding Title] ${finding.title}`,
    `[Claim] ${finding.claim}`,
    finding.files.length > 0 ? `Relevant files: ${finding.files.join(', ')}` : undefined,
    finding.evidence.length > 0 ? `Scanner evidence: ${finding.evidence.join(' | ')}` : undefined,
    scoutDirective.summary ? `[Scout summary] ${scoutDirective.summary}` : undefined,
    'Validate only this finding. Do not broad-scan the repo and do not restate the whole review.',
    'Decide whether the finding is valid, a false positive, or still missing evidence.',
    [
      `Append a final fenced block named \`\`\`${MANAGED_TASK_HANDOFF_BLOCK}\`\`\` with this exact shape:`,
      'status: <ready|incomplete|blocked>',
      'summary: <one-line validator summary>',
      'evidence:',
      '- <evidence item>',
      'followup:',
      '- <follow-up or "none">',
    ].join('\n'),
    [
      `Then append a JSON fenced block named \`\`\`${TACTICAL_CHILD_RESULT_BLOCK}\`\`\` with this exact shape:`,
      `{"childId":"${finding.id}","fanoutClass":"finding-validation","status":"completed","disposition":"valid|false-positive|needs-more-evidence","summary":"<one-line verdict>","evidenceRefs":["<artifact or file reference>"],"contradictions":["<contradiction or empty>"],"artifactPaths":[]}`,
    ].join('\n'),
  ].filter((section): section is string => Boolean(section)).join('\n\n');
}

function buildTacticalInvestigationValidatorPrompt(
  originalTask: string,
  shard: TacticalInvestigationShard,
  scoutDirective: ManagedTaskScoutDirective,
): string {
  return [
    'You are a Tactical Investigation Validator child for one bounded evidence shard.',
    `[Task] ${originalTask}`,
    `[Shard ID] ${shard.id}`,
    `[Question] ${shard.question}`,
    `[Scope] ${shard.scope}`,
    `[Priority] ${shard.priority}`,
    shard.files.length > 0 ? `Relevant files: ${shard.files.join(', ')}` : undefined,
    shard.evidence.length > 0 ? `Scanner evidence: ${shard.evidence.join(' | ')}` : undefined,
    scoutDirective.summary ? `[Scout summary] ${scoutDirective.summary}` : undefined,
    'Validate only this evidence question. Do not broad-scan the repo and do not restate the entire investigation.',
    'Decide whether the shard supports the current diagnosis, weakens it, or still needs more evidence.',
    [
      `Append a final fenced block named \`\`\`${MANAGED_TASK_HANDOFF_BLOCK}\`\`\` with this exact shape:`,
      'status: <ready|incomplete|blocked>',
      'summary: <one-line validator summary>',
      'evidence:',
      '- <evidence item>',
      'followup:',
      '- <follow-up or "none">',
    ].join('\n'),
    [
      `Then append a JSON fenced block named \`\`\`${TACTICAL_CHILD_RESULT_BLOCK}\`\`\` with this exact shape:`,
      `{"childId":"${shard.id}","fanoutClass":"evidence-scan","status":"completed","disposition":"valid|false-positive|needs-more-evidence","summary":"<one-line verdict>","evidenceRefs":["<artifact or file reference>"],"contradictions":["<contradiction or empty>"],"artifactPaths":[]}`,
    ].join('\n'),
  ].filter((section): section is string => Boolean(section)).join('\n\n');
}

function buildTacticalChildArtifactPaths(taskDir: string): {
  childResultPath: string;
  handoffPath: string;
} {
  return {
    childResultPath: path.join(taskDir, TACTICAL_CHILD_RESULT_ARTIFACT_JSON),
    handoffPath: path.join(taskDir, TACTICAL_CHILD_HANDOFF_JSON),
  };
}

async function writeTacticalChildHandoffArtifact(
  filePath: string,
  directive: ManagedTaskHandoffDirective,
): Promise<void> {
  await writeFile(
    filePath,
    `${JSON.stringify({
      status: directive.status,
      summary: directive.summary ?? null,
      evidence: directive.evidence,
      followup: directive.followup,
      userFacingText: directive.userFacingText,
    }, null, 2)}\n`,
    'utf8',
  );
}

function canonicalizeTacticalReviewFindings(
  findings: TacticalReviewFinding[],
): {
  findings: TacticalReviewFinding[];
  duplicateIds: string[];
} {
  const canonicalFindings: TacticalReviewFinding[] = [];
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const finding of findings) {
    if (seen.has(finding.id)) {
      duplicateIds.add(finding.id);
      continue;
    }
    seen.add(finding.id);
    canonicalFindings.push(finding);
  }

  return {
    findings: canonicalFindings,
    duplicateIds: Array.from(duplicateIds),
  };
}

function canonicalizeTacticalInvestigationShards(
  shards: TacticalInvestigationShard[],
): {
  shards: TacticalInvestigationShard[];
  duplicateIds: string[];
} {
  const canonicalShards: TacticalInvestigationShard[] = [];
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const shard of shards) {
    if (seen.has(shard.id)) {
      duplicateIds.add(shard.id);
      continue;
    }
    seen.add(shard.id);
    canonicalShards.push(shard);
  }

  return {
    shards: canonicalShards,
    duplicateIds: Array.from(duplicateIds),
  };
}

function resolveTacticalWorkerBundleId(worker: ManagedTaskWorkerSpec): string {
  const metadata = worker.metadata ?? {};
  const candidate = metadata.findingId ?? metadata.bundleId ?? worker.id;
  return typeof candidate === 'string' && candidate.trim() ? candidate : worker.id;
}

function resolveTacticalWorkerFanoutClass(
  worker: ManagedTaskWorkerSpec,
): KodaXAmaFanoutClass {
  return worker.metadata?.fanoutClass === 'finding-validation'
    || worker.metadata?.fanoutClass === 'evidence-scan'
    || worker.metadata?.fanoutClass === 'module-triage'
    || worker.metadata?.fanoutClass === 'hypothesis-check'
      ? worker.metadata.fanoutClass
      : 'finding-validation';
}

function buildTacticalChildResultLedger(
  fanoutSchedulerPlan: KodaXFanoutSchedulerPlan,
  childContextBundles: KodaXChildContextBundle[],
  childResults: KodaXChildAgentResult[],
  parentReductionContract: KodaXParentReductionContract,
): TacticalChildResultLedger {
  return {
    generatedAt: new Date().toISOString(),
    fanoutClass: fanoutSchedulerPlan.fanoutClass,
    reductionStrategy: parentReductionContract.strategy,
    branches: fanoutSchedulerPlan.branches,
    bundles: childContextBundles,
    childResults,
  };
}

function renderTacticalChildResultLedgerMarkdown(
  ledger: TacticalChildResultLedger,
): string {
  return [
    '# Tactical Child Result Ledger',
    '',
    `- Fan-out class: ${ledger.fanoutClass}`,
    `- Reduction strategy: ${ledger.reductionStrategy}`,
    '',
    '## Branches',
    ...ledger.branches.map((branch) => (
      [
        `- ${branch.bundleId}: ${branch.status}`,
        branch.workerId ? `  - worker: ${branch.workerId}` : undefined,
        branch.childId ? `  - child: ${branch.childId}` : undefined,
        branch.reason ? `  - reason: ${branch.reason}` : undefined,
      ].filter((line): line is string => Boolean(line)).join('\n')
    )),
    '',
    '## Child Results',
    ...(ledger.childResults.length > 0
      ? ledger.childResults.map((result) => (
          [
            `- ${result.childId}: ${result.disposition}`,
            `  - status: ${result.status}`,
            `  - summary: ${result.summary}`,
            result.evidenceRefs.length > 0 ? `  - evidence: ${result.evidenceRefs.join(', ')}` : undefined,
            result.contradictions.length > 0 ? `  - contradictions: ${result.contradictions.join(' | ')}` : undefined,
          ].filter((line): line is string => Boolean(line)).join('\n')
        ))
      : ['- No child results recorded yet.']),
  ].join('\n');
}

async function writeTacticalChildResultLedger(
  workspaceDir: string,
  fanoutSchedulerPlan: KodaXFanoutSchedulerPlan,
  childContextBundles: KodaXChildContextBundle[],
  childResults: KodaXChildAgentResult[],
  parentReductionContract: KodaXParentReductionContract,
  options?: {
    includeMarkdown?: boolean;
  },
): Promise<KodaXTaskEvidenceArtifact[]> {
  const ledger = buildTacticalChildResultLedger(
    fanoutSchedulerPlan,
    childContextBundles,
    childResults,
    parentReductionContract,
  );
  const jsonPath = path.join(workspaceDir, TACTICAL_CHILD_LEDGER_JSON);
  await writeFile(jsonPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  const artifacts: KodaXTaskEvidenceArtifact[] = [
    {
      kind: 'json',
      path: jsonPath,
      description: 'Authoritative child result ledger for AMA tactical fan-out.',
    },
  ];
  if (options?.includeMarkdown !== false) {
    const markdownPath = path.join(workspaceDir, TACTICAL_CHILD_LEDGER_MARKDOWN);
    await writeFile(markdownPath, `${renderTacticalChildResultLedgerMarkdown(ledger).trimEnd()}\n`, 'utf8');
    artifacts.push({
      kind: 'markdown',
      path: markdownPath,
      description: 'Human-readable child result ledger summary.',
    });
  }
  return artifacts;
}

function buildTacticalReviewReducerPrompt(
  originalTask: string,
  findings: TacticalReviewFinding[],
  childResultLedgerPath: string,
): string {
  return [
    'You are the Tactical Review Reducer for a KodaX AMA task.',
    `[Task] ${originalTask}`,
    `Candidate findings under validation: ${findings.map((finding) => finding.id).join(', ')}`,
    `Authoritative child-result ledger: ${childResultLedgerPath}`,
    'Read the child-result ledger first. Use dependency handoff only to locate supporting artifacts.',
    'Do not treat raw child output excerpts as authoritative. Only keep findings that survived validation in the ledger with concrete evidence.',
    'Do not describe yourself as verifying or judging other roles. Return the final user-facing review directly.',
    [
      `Append a final fenced block named \`\`\`${MANAGED_TASK_VERDICT_BLOCK}\`\`\` with this exact shape:`,
      'status: <accept|revise|blocked>',
      'reason: <one-line reason>',
      'user_answer:',
      '<full final user-facing review>',
      'followup:',
      '- <optional follow-up or "none">',
    ].join('\n'),
  ].join('\n\n');
}

function buildTacticalInvestigationReducerPrompt(
  originalTask: string,
  shards: TacticalInvestigationShard[],
  childResultLedgerPath: string,
): string {
  return [
    'You are the Tactical Investigation Reducer for a KodaX AMA task.',
    `[Task] ${originalTask}`,
    `Evidence shards under validation: ${shards.map((shard) => shard.id).join(', ')}`,
    `Authoritative child-result ledger: ${childResultLedgerPath}`,
    'Read the child-result ledger first. Use dependency handoff only to locate supporting artifacts.',
    'Do not trust raw child transcript excerpts as authoritative. Only use ledger-backed child results and concrete evidence references.',
    'Return a direct user-facing investigation update or diagnosis, not a meta-evaluation of other roles.',
    [
      `Append a final fenced block named \`\`\`${MANAGED_TASK_VERDICT_BLOCK}\`\`\` with this exact shape:`,
      'status: <accept|revise|blocked>',
      'reason: <one-line reason>',
      'user_answer:',
      '<full direct user-facing diagnosis or investigation update>',
      'followup:',
      '- <optional follow-up or "none">',
    ].join('\n'),
  ].join('\n\n');
}

async function runTacticalReviewScanner(
  options: KodaXOptions,
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  routingPromptOverlay: string | undefined,
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode,
  sessionStorage: KodaXSessionStorage | undefined,
  controller: ManagedTaskBudgetController,
): Promise<{ result: KodaXResult; directive?: TacticalReviewFindingsDirective; artifactPath?: string }> {
  const preparedOptions = buildWorkerRunOptions(
    options,
    task,
    worker,
    'review-reducer',
    routingPromptOverlay,
    qualityAssuranceMode,
    sessionStorage,
    'reset-handoff',
    createBudgetSnapshot(controller, task.contract.harnessProfile, 1, 'generator', worker.id),
    controller,
  );
  const result = await runDirectKodaX(preparedOptions, worker.prompt);
  const text = extractMessageText(result) || result.lastText;
  const directive = parseTacticalReviewFindingsDirective(text);
  let artifactPath: string | undefined;
  if (directive) {
    artifactPath = path.join(task.evidence.workspaceDir, 'review-findings.json');
    await writeFile(
      artifactPath,
      `${JSON.stringify(directive, null, 2)}\n`,
      'utf8',
    );
  }
  return { result, directive, artifactPath };
}

async function runTacticalInvestigationScanner(
  options: KodaXOptions,
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  routingPromptOverlay: string | undefined,
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode,
  sessionStorage: KodaXSessionStorage | undefined,
  controller: ManagedTaskBudgetController,
): Promise<{ result: KodaXResult; directive?: TacticalInvestigationShardsDirective; artifactPath?: string }> {
  const preparedOptions = buildWorkerRunOptions(
    options,
    task,
    worker,
    'investigation-reducer',
    routingPromptOverlay,
    qualityAssuranceMode,
    sessionStorage,
    'reset-handoff',
    createBudgetSnapshot(controller, task.contract.harnessProfile, 1, 'generator', worker.id),
    controller,
  );
  const result = await runDirectKodaX(preparedOptions, worker.prompt);
  const text = extractMessageText(result) || result.lastText;
  const directive = parseTacticalInvestigationShardsDirective(text);
  let artifactPath: string | undefined;
  if (directive) {
    artifactPath = path.join(task.evidence.workspaceDir, 'investigation-shards.json');
    await writeFile(
      artifactPath,
      `${JSON.stringify(directive, null, 2)}\n`,
      'utf8',
    );
  }
  return { result, directive, artifactPath };
}

async function runTacticalReviewFlow(
  managedOptions: KodaXOptions,
  originalTask: string,
  plan: ReasoningPlan,
  scoutExecution: { result: KodaXResult; directive: ManagedTaskScoutDirective },
  rawRoutingDecision: KodaXTaskRoutingDecision,
  finalRoutingDecision: KodaXTaskRoutingDecision,
  routingOverrideReason: string | undefined,
  skillMap: KodaXSkillMap | undefined,
  agentMode: KodaXAgentMode,
  scoutBudgetController: ManagedTaskBudgetController,
): Promise<KodaXResult> {
  const shape = createTacticalReviewBaseShape(
    managedOptions,
    originalTask,
    plan,
    {
      originalTask,
      skillInvocation: managedOptions.context?.skillInvocation,
      skillMap: skillMap ?? undefined,
    },
  );
  const budgetController = createManagedBudgetController(managedOptions, plan, agentMode);
  budgetController.spentBudget = Math.max(budgetController.spentBudget, scoutBudgetController.spentBudget);
  const sessionStorage = new ManagedWorkerSessionStorage();
  await mkdir(shape.workspaceDir, { recursive: true });
  const skillArtifacts = await writeManagedSkillArtifacts(
    shape.workspaceDir,
    managedOptions.context?.skillInvocation,
    skillMap ?? undefined,
  );
  shape.task = {
    ...shape.task,
    runtime: {
      ...applyManagedBudgetRuntimeState(shape.task.runtime, budgetController),
      budget: createBudgetSnapshot(budgetController, shape.task.contract.harnessProfile, 1, 'generator', 'review-scan'),
      rawRoutingDecision,
      finalRoutingDecision,
      routingOverrideReason,
      qualityAssuranceMode: shape.qualityAssuranceMode,
      scoutDecision: {
        summary: scoutExecution.directive.summary ?? 'Scout completed.',
        recommendedHarness: finalRoutingDecision.harnessProfile,
        readyForUpgrade: false,
        scope: scoutExecution.directive.scope,
        requiredEvidence: scoutExecution.directive.requiredEvidence,
        reviewFilesOrAreas: scoutExecution.directive.reviewFilesOrAreas,
        evidenceAcquisitionMode: scoutExecution.directive.evidenceAcquisitionMode,
        skillSummary: scoutExecution.directive.skillMap?.skillSummary,
        executionObligations: scoutExecution.directive.skillMap?.executionObligations,
        verificationObligations: scoutExecution.directive.skillMap?.verificationObligations,
        ambiguities: scoutExecution.directive.skillMap?.ambiguities,
        projectionConfidence: scoutExecution.directive.skillMap?.projectionConfidence,
      },
      skillMap: skillMap ?? undefined,
      evidenceAcquisitionMode: scoutExecution.directive.evidenceAcquisitionMode ?? 'overview',
      reviewFilesOrAreas: scoutExecution.directive.reviewFilesOrAreas,
    },
    evidence: {
      ...shape.task.evidence,
      artifacts: mergeEvidenceArtifacts(shape.task.evidence.artifacts, skillArtifacts),
      entries: [
        ...shape.task.evidence.entries,
        {
          assignmentId: 'scout',
          title: 'Scout',
          role: 'scout',
          round: 0,
          status: scoutExecution.result.success ? 'completed' : 'failed',
          summary: scoutExecution.directive.summary,
          output: scoutExecution.directive.userFacingText || extractMessageText(scoutExecution.result),
          sessionId: scoutExecution.result.sessionId,
          signal: scoutExecution.result.signal,
          signalReason: scoutExecution.result.signalReason,
        },
      ],
    },
  };

  const scannerToolPolicy = buildManagedWorkerToolPolicy(
    'generator',
    shape.task.contract.verification,
    'H0_DIRECT',
    'read-only',
    managedOptions.context?.repoIntelligenceMode,
  );
  const scannerWorker: ManagedTaskWorkerSpec = {
    id: 'review-scan',
    role: 'generator',
    title: 'Review Scanner',
    agent: buildManagedWorkerAgent('generator', 'review-scan'),
    toolPolicy: scannerToolPolicy,
    terminalAuthority: false,
    prompt: buildTacticalReviewScannerPrompt(
      originalTask,
      plan,
      scoutExecution.directive,
    ),
    metadata: {
      role: 'generator',
      agent: buildManagedWorkerAgent('generator', 'review-scan'),
      tacticalChild: false,
    },
  };
  scannerWorker.beforeToolExecute = createToolPolicyHook(scannerWorker);

  const scannerExecution = await runTacticalReviewScanner(
    managedOptions,
    shape.task,
    scannerWorker,
    shape.routingPromptOverlay,
    shape.qualityAssuranceMode,
    sessionStorage,
    budgetController,
  );
  const scannerDirective = scannerExecution.directive;
  const scannerOutput = sanitizeManagedUserFacingText(
    extractMessageText(scannerExecution.result) || scannerExecution.result.lastText,
  );

  shape.task = {
    ...shape.task,
    evidence: {
      ...shape.task.evidence,
      artifacts: mergeEvidenceArtifacts(
        shape.task.evidence.artifacts,
        scannerExecution.artifactPath
          ? [{
              kind: 'json',
              path: scannerExecution.artifactPath,
              description: 'Tactical review candidate findings.',
            }]
          : [],
      ),
      entries: [
        ...shape.task.evidence.entries,
        {
          assignmentId: 'review-scan',
          title: 'Review Scanner',
          role: 'generator',
          round: 1,
          status: scannerExecution.result.success ? 'completed' : 'failed',
          summary: scannerDirective?.summary ?? truncateText(scannerOutput || 'Review scanner completed.'),
          output: scannerOutput,
          sessionId: scannerExecution.result.sessionId,
          signal: scannerExecution.result.signal,
          signalReason: scannerExecution.result.signalReason,
        },
      ],
    },
  };

  const scannerFindings = scannerDirective?.findings ?? [];
  if (scannerFindings.length === 0) {
    const completionStatus: KodaXTaskStatus = scannerExecution.result.success ? 'completed' : 'failed';
    const completedTask: KodaXManagedTask = {
      ...shape.task,
      contract: {
        ...shape.task.contract,
        status: completionStatus,
        updatedAt: new Date().toISOString(),
      },
      verdict: {
        ...shape.task.verdict,
        status: completionStatus,
        summary: scannerDirective?.summary ?? (scannerOutput || 'Review scanner finished without promotable findings.'),
      },
      runtime: {
        ...shape.task.runtime,
        scorecard: createVerificationScorecard(shape.task, undefined),
      },
    };
    await writeManagedTaskArtifacts(
      shape.workspaceDir,
      completedTask,
      {
        success: scannerExecution.result.success,
        lastText: scannerOutput || scannerExecution.result.lastText,
        sessionId: scannerExecution.result.sessionId,
        signal: scannerExecution.result.signal,
        signalReason: scannerExecution.result.signalReason,
      },
      undefined,
    );
    return mergeManagedTaskIntoResult(
      {
        ...scannerExecution.result,
        lastText: scannerOutput || scannerExecution.result.lastText,
        routingDecision: finalRoutingDecision,
      },
      completedTask,
    );
  }

  const {
    findings,
    duplicateIds: duplicateFindingIds,
  } = canonicalizeTacticalReviewFindings(scannerFindings);
  const duplicateFindingNote = duplicateFindingIds.length > 0
    ? `Canonicalized repeated scanner finding IDs: ${duplicateFindingIds.join(', ')}.`
    : undefined;
  if (duplicateFindingNote) {
    shape.task = {
      ...shape.task,
      evidence: {
        ...shape.task.evidence,
        entries: shape.task.evidence.entries.map((entry) => (
          entry.assignmentId === 'review-scan'
            ? {
              ...entry,
              summary: `${entry.summary ?? 'Review scanner completed.'} ${duplicateFindingNote}`.trim(),
              output: [entry.output, duplicateFindingNote].filter(Boolean).join('\n\n'),
            }
            : entry
        )),
      },
    };
  }

  const childContextBundles: KodaXChildContextBundle[] = findings.map((finding) => ({
    id: finding.id,
    fanoutClass: 'finding-validation',
    objective: finding.claim,
    scopeSummary: finding.title,
    evidenceRefs: finding.evidence,
    constraints: [
      'Validate only this candidate finding.',
      'Do not broad-scan the repo.',
    ],
    readOnly: true,
  }));
  const parentReductionContract = shape.task.runtime?.parentReductionContract
    ?? createParentReductionContract(plan.amaControllerDecision);
  const schedulerInput = createFanoutSchedulerInput(
    plan.amaControllerDecision,
    childContextBundles,
    parentReductionContract,
  );
  let fanoutSchedulerPlan: KodaXFanoutSchedulerPlan = schedulerInput
    ? buildFanoutSchedulerPlan(schedulerInput)
    : {
      enabled: false,
      profile: plan.amaControllerDecision.profile,
      fanoutClass: 'finding-validation',
      branches: childContextBundles.map((bundle) => ({
        bundleId: bundle.id,
        status: 'deferred' as const,
        reason: 'AMA controller did not admit fan-out for this run.',
      })),
      scheduledBundleIds: [],
      deferredBundleIds: childContextBundles.map((bundle) => bundle.id),
      maxParallel: 1,
      mergeStrategy: parentReductionContract.strategy,
      cancellationPolicy: 'none',
      reason: 'AMA controller did not admit fan-out for this run.',
      };
  let childLedgerArtifacts: KodaXTaskEvidenceArtifact[] = [];
  const findingsById = new Map(findings.map((finding) => [finding.id, finding] as const));
  const scheduledFindings = fanoutSchedulerPlan.scheduledBundleIds
    .map((bundleId) => findingsById.get(bundleId))
    .filter((finding): finding is TacticalReviewFinding => Boolean(finding));
  shape.task = {
    ...shape.task,
    runtime: {
      ...shape.task.runtime,
      childContextBundles,
      parentReductionContract,
      fanoutSchedulerPlan,
    },
  };

  const validatorToolPolicy = buildManagedWorkerToolPolicy(
    'generator',
    shape.task.contract.verification,
    'H0_DIRECT',
    'read-only',
    managedOptions.context?.repoIntelligenceMode,
  );
  const reducerToolPolicy = buildManagedWorkerToolPolicy(
    'evaluator',
    shape.task.contract.verification,
    'H0_DIRECT',
    'read-only',
    managedOptions.context?.repoIntelligenceMode,
  );
  const validators: ManagedTaskWorkerSpec[] = scheduledFindings.map((finding, index) => {
    const worker: ManagedTaskWorkerSpec = {
      id: `validator-${String(index + 1).padStart(2, '0')}`,
      role: 'generator',
      title: `Finding Validator ${index + 1}: ${truncateText(finding.title, 60)}`,
      execution: 'parallel',
      agent: buildManagedWorkerAgent('generator', finding.id),
      toolPolicy: validatorToolPolicy,
      terminalAuthority: false,
      metadata: {
        role: 'generator',
        fanoutClass: 'finding-validation',
        findingId: finding.id,
      },
      prompt: buildTacticalReviewValidatorPrompt(
        originalTask,
        finding,
        scoutExecution.directive,
      ),
    };
    worker.beforeToolExecute = createToolPolicyHook(worker);
    fanoutSchedulerPlan = applyFanoutBranchTransition(fanoutSchedulerPlan, {
      type: 'assign',
      bundleId: finding.id,
      workerId: worker.id,
    });
    return worker;
  });
  const reducer: ManagedTaskWorkerSpec = {
    id: 'review-reducer',
    role: 'evaluator',
    title: 'Review Reducer',
    dependsOn: validators.map((worker) => worker.id),
    agent: buildManagedWorkerAgent('evaluator', 'review-reducer'),
    toolPolicy: reducerToolPolicy,
    terminalAuthority: true,
    metadata: {
      role: 'evaluator',
      reductionStrategy: 'evaluator-assisted',
    },
    prompt: buildTacticalReviewReducerPrompt(
      originalTask,
      scheduledFindings,
      path.join(shape.workspaceDir, TACTICAL_CHILD_LEDGER_JSON),
    ),
  };
  reducer.beforeToolExecute = createToolPolicyHook(reducer);

  shape.workers = [...validators, reducer];
  shape.terminalWorkerId = reducer.id;
  const roleAssignments: KodaXManagedTask['roleAssignments'] = [
    ...shape.task.roleAssignments.map((assignment) => (
      assignment.id === 'review-scan'
        ? {
          ...assignment,
          status: 'completed' as const,
          summary: [
            scannerDirective?.summary ?? truncateText(scannerOutput || 'Review scanner completed.'),
            duplicateFindingNote,
          ].filter(Boolean).join(' '),
        }
        : assignment
    )),
    ...shape.workers.map((worker) => ({
      id: worker.id,
      role: worker.role,
      title: worker.title,
      dependsOn: worker.dependsOn ?? [],
      status: 'planned' as const,
      agent: worker.agent,
      toolPolicy: worker.toolPolicy,
    })),
  ];
  shape.task = {
    ...shape.task,
    runtime: {
      ...shape.task.runtime,
      fanoutSchedulerPlan,
    },
    roleAssignments,
    workItems: [
      ...shape.task.workItems,
      ...shape.workers.map((worker) => ({
        id: worker.id,
        assignmentId: worker.id,
        description: worker.title,
        execution: worker.execution ?? 'serial',
      })),
    ],
    verdict: {
      ...shape.task.verdict,
      decidedByAssignmentId: reducer.id,
      summary: 'AMA Tactical review is validating candidate findings in parallel.',
    },
  };

  const workerResults = new Map<string, KodaXResult>();
  const childResults: KodaXChildAgentResult[] = [];
  const childArtifacts: KodaXTaskEvidenceArtifact[] = [];
  let directive: ManagedTaskVerdictDirective | undefined;
  const tacticalRunner = createKodaXTaskRunner<ManagedTaskWorkerSpec>({
    baseOptions: managedOptions,
    runAgent: runDirectKodaX,
    createOptions: (worker, _context, defaultOptions) => buildWorkerRunOptions(
      defaultOptions,
      shape.task,
      worker,
      shape.terminalWorkerId,
      shape.routingPromptOverlay,
      shape.qualityAssuranceMode,
      sessionStorage,
      resolveManagedMemoryStrategy(managedOptions, plan, worker.role, 1),
      createBudgetSnapshot(budgetController, shape.task.contract.harnessProfile, 1, worker.role, worker.id),
      budgetController,
    ),
    runTask: async (worker, _context, preparedOptions, promptText, executeDefault) => {
      if (worker.role === 'evaluator') {
        childLedgerArtifacts = await writeTacticalChildResultLedger(
          shape.workspaceDir,
          fanoutSchedulerPlan,
          childContextBundles,
          childResults,
          parentReductionContract,
          { includeMarkdown: false },
        );
      }
      const execution = await runManagedWorkerTask(
        worker,
        preparedOptions,
        promptText,
        executeDefault,
        budgetController,
      );
      return execution.result;
    },
    onResult: async (worker, context, result) => {
      const sanitized = worker.role === 'evaluator'
        ? sanitizeManagedWorkerResult(result, { enforceVerdictBlock: true })
        : sanitizeHandoffResult(result, worker.title);
      workerResults.set(worker.id, sanitized.result);
      if (worker.role === 'evaluator') {
        directive = sanitized.directive as ManagedTaskVerdictDirective | undefined;
      } else {
        const artifactPaths = buildTacticalChildArtifactPaths(context.taskDir);
        const handoffDirective = sanitized.directive as ManagedTaskHandoffDirective | undefined;
        if (handoffDirective) {
          await writeTacticalChildHandoffArtifact(artifactPaths.handoffPath, handoffDirective);
          childArtifacts.push({
            kind: 'json',
            path: artifactPaths.handoffPath,
            description: `Dependency handoff for ${String(worker.metadata?.findingId ?? worker.id)}`,
          });
        }
        const parsedChildResult = parseChildAgentResult(extractMessageText(result) || result.lastText);
        const normalizedChildResult = normalizeTacticalChildResult(
          worker,
          handoffDirective,
          sanitized.result,
          parsedChildResult,
          artifactPaths,
        );
        await writeFile(
          artifactPaths.childResultPath,
          `${JSON.stringify(normalizedChildResult, null, 2)}\n`,
          'utf8',
        );
        upsertChildAgentResult(childResults, normalizedChildResult);
        fanoutSchedulerPlan = applyFanoutBranchTransition(fanoutSchedulerPlan, {
          type: 'complete',
          bundleId: String(worker.metadata?.findingId ?? worker.id),
          childId: normalizedChildResult.childId,
        });
        childArtifacts.push({
          kind: 'json',
          path: artifactPaths.childResultPath,
          description: `Child-agent result for ${normalizedChildResult.childId}`,
        });
      }
      return sanitized.result;
    },
  });

  const roundWorkspaceDir = path.join(shape.workspaceDir, 'rounds', 'round-01');
  const orchestrationResult = await runOrchestration<ManagedTaskWorkerSpec, string>({
    workspaceDir: roundWorkspaceDir,
    runId: `${shape.task.contract.taskId}-tactical-review`,
    maxParallel: fanoutSchedulerPlan.maxParallel,
    tasks: shape.workers,
    runner: tacticalRunner,
    events: createTacticalFanoutStatusEvents(
      managedOptions.events,
      agentMode,
      shape.task.contract.harnessProfile,
      () => fanoutSchedulerPlan,
    ),
  });

  let managedTask = applyOrchestrationResultToTask(
    shape.task,
    shape.terminalWorkerId,
    orchestrationResult,
    workerResults,
    1,
    roundWorkspaceDir,
  );
  childLedgerArtifacts = await writeTacticalChildResultLedger(
    shape.workspaceDir,
    fanoutSchedulerPlan,
    childContextBundles,
    childResults,
    parentReductionContract,
  );
  managedTask = {
    ...managedTask,
    evidence: {
      ...managedTask.evidence,
      artifacts: mergeEvidenceArtifacts(
        managedTask.evidence.artifacts,
        childArtifacts,
        childLedgerArtifacts,
      ),
    },
    runtime: {
      ...managedTask.runtime,
      childContextBundles,
      childAgentResults: childResults,
      fanoutSchedulerPlan,
      scorecard: createVerificationScorecard(managedTask, directive),
    },
  };
  directive = applyTacticalParentReduction(
    directive,
    fanoutSchedulerPlan,
    childContextBundles,
    childResults,
  );
  managedTask = applyManagedTaskDirective(managedTask, directive);
  const terminalResult = workerResults.get(shape.terminalWorkerId);
  const preferredPublicText = directive?.userAnswer?.trim() || directive?.userFacingText;
  if (terminalResult && directive && preferredPublicText) {
    workerResults.set(shape.terminalWorkerId, {
      ...terminalResult,
      success: directive.status === 'accept',
      lastText: preferredPublicText,
      signal: directive.status === 'accept' ? terminalResult.signal : 'BLOCKED',
      signalReason: directive.status === 'accept'
        ? terminalResult.signalReason
        : directive.reason ?? terminalResult.signalReason,
      messages: replaceLastAssistantMessage(terminalResult.messages, preferredPublicText),
    });
  }

  const result = buildFallbackManagedResult(
    managedTask,
    workerResults,
    shape.terminalWorkerId,
  );
  await writeManagedTaskArtifacts(
    shape.workspaceDir,
    managedTask,
    {
      success: result.success,
      lastText: result.lastText,
      sessionId: result.sessionId,
      signal: result.signal,
      signalReason: result.signalReason,
    },
    directive,
  );
  managedOptions.events?.onManagedTaskStatus?.({
    agentMode,
    harnessProfile: managedTask.contract.harnessProfile,
    activeWorkerId: shape.terminalWorkerId,
    activeWorkerTitle: reducer.title,
    phase: 'completed',
    note: managedTask.verdict.summary,
  });
  return {
    ...result,
    routingDecision: finalRoutingDecision,
  };
}

async function runTacticalInvestigationFlow(
  managedOptions: KodaXOptions,
  originalTask: string,
  plan: ReasoningPlan,
  scoutExecution: { result: KodaXResult; directive: ManagedTaskScoutDirective },
  rawRoutingDecision: KodaXTaskRoutingDecision,
  finalRoutingDecision: KodaXTaskRoutingDecision,
  routingOverrideReason: string | undefined,
  skillMap: KodaXSkillMap | undefined,
  agentMode: KodaXAgentMode,
  scoutBudgetController: ManagedTaskBudgetController,
): Promise<KodaXResult> {
  const shape = createTacticalInvestigationBaseShape(
    managedOptions,
    originalTask,
    plan,
    {
      originalTask,
      skillInvocation: managedOptions.context?.skillInvocation,
      skillMap: skillMap ?? undefined,
    },
  );
  const budgetController = createManagedBudgetController(managedOptions, plan, agentMode);
  budgetController.spentBudget = Math.max(budgetController.spentBudget, scoutBudgetController.spentBudget);
  const sessionStorage = new ManagedWorkerSessionStorage();
  await mkdir(shape.workspaceDir, { recursive: true });
  const skillArtifacts = await writeManagedSkillArtifacts(
    shape.workspaceDir,
    managedOptions.context?.skillInvocation,
    skillMap ?? undefined,
  );
  shape.task = {
    ...shape.task,
    runtime: {
      ...applyManagedBudgetRuntimeState(shape.task.runtime, budgetController),
      budget: createBudgetSnapshot(budgetController, shape.task.contract.harnessProfile, 1, 'generator', 'investigation-scan'),
      rawRoutingDecision,
      finalRoutingDecision,
      routingOverrideReason,
      qualityAssuranceMode: shape.qualityAssuranceMode,
      scoutDecision: {
        summary: scoutExecution.directive.summary ?? 'Scout completed.',
        recommendedHarness: finalRoutingDecision.harnessProfile,
        readyForUpgrade: false,
        scope: scoutExecution.directive.scope,
        requiredEvidence: scoutExecution.directive.requiredEvidence,
        reviewFilesOrAreas: scoutExecution.directive.reviewFilesOrAreas,
        evidenceAcquisitionMode: scoutExecution.directive.evidenceAcquisitionMode,
        skillSummary: scoutExecution.directive.skillMap?.skillSummary,
        executionObligations: scoutExecution.directive.skillMap?.executionObligations,
        verificationObligations: scoutExecution.directive.skillMap?.verificationObligations,
        ambiguities: scoutExecution.directive.skillMap?.ambiguities,
        projectionConfidence: scoutExecution.directive.skillMap?.projectionConfidence,
      },
      skillMap: skillMap ?? undefined,
      evidenceAcquisitionMode: scoutExecution.directive.evidenceAcquisitionMode ?? 'overview',
      reviewFilesOrAreas: scoutExecution.directive.reviewFilesOrAreas,
    },
    evidence: {
      ...shape.task.evidence,
      artifacts: mergeEvidenceArtifacts(shape.task.evidence.artifacts, skillArtifacts),
      entries: [
        ...shape.task.evidence.entries,
        {
          assignmentId: 'scout',
          title: 'Scout',
          role: 'scout',
          round: 0,
          status: scoutExecution.result.success ? 'completed' : 'failed',
          summary: scoutExecution.directive.summary,
          output: scoutExecution.directive.userFacingText || extractMessageText(scoutExecution.result),
          sessionId: scoutExecution.result.sessionId,
          signal: scoutExecution.result.signal,
          signalReason: scoutExecution.result.signalReason,
        },
      ],
    },
  };

  const scannerToolPolicy = buildManagedWorkerToolPolicy(
    'generator',
    shape.task.contract.verification,
    'H0_DIRECT',
    'read-only',
    managedOptions.context?.repoIntelligenceMode,
  );
  const scannerWorker: ManagedTaskWorkerSpec = {
    id: 'investigation-scan',
    role: 'generator',
    title: 'Investigation Scanner',
    agent: buildManagedWorkerAgent('generator', 'investigation-scan'),
    toolPolicy: scannerToolPolicy,
    terminalAuthority: false,
    prompt: buildTacticalInvestigationScannerPrompt(
      originalTask,
      plan,
      scoutExecution.directive,
    ),
    metadata: {
      role: 'generator',
      agent: buildManagedWorkerAgent('generator', 'investigation-scan'),
      tacticalChild: false,
    },
  };
  scannerWorker.beforeToolExecute = createToolPolicyHook(scannerWorker);

  const scannerExecution = await runTacticalInvestigationScanner(
    managedOptions,
    shape.task,
    scannerWorker,
    shape.routingPromptOverlay,
    shape.qualityAssuranceMode,
    sessionStorage,
    budgetController,
  );
  const scannerDirective = scannerExecution.directive;
  const scannerOutput = sanitizeManagedUserFacingText(
    extractMessageText(scannerExecution.result) || scannerExecution.result.lastText,
  );

  shape.task = {
    ...shape.task,
    evidence: {
      ...shape.task.evidence,
      artifacts: mergeEvidenceArtifacts(
        shape.task.evidence.artifacts,
        scannerExecution.artifactPath
          ? [{
              kind: 'json',
              path: scannerExecution.artifactPath,
              description: 'Tactical investigation evidence shards.',
            }]
          : [],
      ),
      entries: [
        ...shape.task.evidence.entries,
        {
          assignmentId: 'investigation-scan',
          title: 'Investigation Scanner',
          role: 'generator',
          round: 1,
          status: scannerExecution.result.success ? 'completed' : 'failed',
          summary: scannerDirective?.summary ?? truncateText(scannerOutput || 'Investigation scanner completed.'),
          output: scannerOutput,
          sessionId: scannerExecution.result.sessionId,
          signal: scannerExecution.result.signal,
          signalReason: scannerExecution.result.signalReason,
        },
      ],
    },
  };

  const scannerShards = scannerDirective?.shards ?? [];
  if (scannerShards.length === 0) {
    const completionStatus: KodaXTaskStatus = scannerExecution.result.success ? 'completed' : 'failed';
    const completedTask: KodaXManagedTask = {
      ...shape.task,
      contract: {
        ...shape.task.contract,
        status: completionStatus,
        updatedAt: new Date().toISOString(),
      },
      verdict: {
        ...shape.task.verdict,
        status: completionStatus,
        summary: scannerDirective?.summary ?? (scannerOutput || 'Investigation scanner finished without promotable evidence shards.'),
      },
      runtime: {
        ...shape.task.runtime,
        scorecard: createVerificationScorecard(shape.task, undefined),
      },
    };
    await writeManagedTaskArtifacts(
      shape.workspaceDir,
      completedTask,
      {
        success: scannerExecution.result.success,
        lastText: scannerOutput || scannerExecution.result.lastText,
        sessionId: scannerExecution.result.sessionId,
        signal: scannerExecution.result.signal,
        signalReason: scannerExecution.result.signalReason,
      },
      undefined,
    );
    return mergeManagedTaskIntoResult(
      {
        ...scannerExecution.result,
        lastText: scannerOutput || scannerExecution.result.lastText,
        routingDecision: finalRoutingDecision,
      },
      completedTask,
    );
  }

  const {
    shards,
    duplicateIds: duplicateShardIds,
  } = canonicalizeTacticalInvestigationShards(scannerShards);
  const duplicateShardNote = duplicateShardIds.length > 0
    ? `Canonicalized repeated investigation shard IDs: ${duplicateShardIds.join(', ')}.`
    : undefined;
  if (duplicateShardNote) {
    shape.task = {
      ...shape.task,
      evidence: {
        ...shape.task.evidence,
        entries: shape.task.evidence.entries.map((entry) => (
          entry.assignmentId === 'investigation-scan'
            ? {
                ...entry,
                summary: `${entry.summary ?? 'Investigation scanner completed.'} ${duplicateShardNote}`.trim(),
                output: [entry.output, duplicateShardNote].filter(Boolean).join('\n\n'),
              }
            : entry
        )),
      },
    };
  }

  const childContextBundles: KodaXChildContextBundle[] = shards.map((shard) => ({
    id: shard.id,
    fanoutClass: 'evidence-scan',
    objective: shard.question,
    scopeSummary: shard.scope,
    evidenceRefs: shard.evidence,
    constraints: [
      'Validate only this evidence question.',
      'Do not broad-scan the repo.',
    ],
    readOnly: true,
  }));
  const parentReductionContract = shape.task.runtime?.parentReductionContract
    ?? createParentReductionContract(plan.amaControllerDecision);
  const schedulerInput = createFanoutSchedulerInput(
    plan.amaControllerDecision,
    childContextBundles,
    parentReductionContract,
  );
  let fanoutSchedulerPlan: KodaXFanoutSchedulerPlan = schedulerInput
    ? buildFanoutSchedulerPlan(schedulerInput)
    : {
        enabled: false,
        profile: plan.amaControllerDecision.profile,
        fanoutClass: 'evidence-scan',
        branches: childContextBundles.map((bundle) => ({
          bundleId: bundle.id,
          status: 'deferred' as const,
          reason: 'AMA controller did not admit fan-out for this run.',
        })),
        scheduledBundleIds: [],
        deferredBundleIds: childContextBundles.map((bundle) => bundle.id),
        maxParallel: 1,
        mergeStrategy: parentReductionContract.strategy,
        cancellationPolicy: 'none',
        reason: 'AMA controller did not admit fan-out for this run.',
      };
  let childLedgerArtifacts: KodaXTaskEvidenceArtifact[] = [];
  const shardsById = new Map(shards.map((shard) => [shard.id, shard] as const));
  const scheduledShards = fanoutSchedulerPlan.scheduledBundleIds
    .map((bundleId) => shardsById.get(bundleId))
    .filter((shard): shard is TacticalInvestigationShard => Boolean(shard));
  shape.task = {
    ...shape.task,
    runtime: {
      ...shape.task.runtime,
      childContextBundles,
      parentReductionContract,
      fanoutSchedulerPlan,
    },
  };

  const validatorToolPolicy = buildManagedWorkerToolPolicy(
    'generator',
    shape.task.contract.verification,
    'H0_DIRECT',
    'read-only',
    managedOptions.context?.repoIntelligenceMode,
  );
  const reducerToolPolicy = buildManagedWorkerToolPolicy(
    'evaluator',
    shape.task.contract.verification,
    'H0_DIRECT',
    'read-only',
    managedOptions.context?.repoIntelligenceMode,
  );
  const validators: ManagedTaskWorkerSpec[] = scheduledShards.map((shard, index) => {
    const worker: ManagedTaskWorkerSpec = {
      id: `evidence-validator-${String(index + 1).padStart(2, '0')}`,
      role: 'generator',
      title: `Evidence Validator ${index + 1}: ${truncateText(shard.scope, 60)}`,
      execution: 'parallel',
      agent: buildManagedWorkerAgent('generator', shard.id),
      toolPolicy: validatorToolPolicy,
      terminalAuthority: false,
      metadata: {
        role: 'generator',
        fanoutClass: 'evidence-scan',
        bundleId: shard.id,
      },
      prompt: buildTacticalInvestigationValidatorPrompt(
        originalTask,
        shard,
        scoutExecution.directive,
      ),
    };
    worker.beforeToolExecute = createToolPolicyHook(worker);
    fanoutSchedulerPlan = applyFanoutBranchTransition(fanoutSchedulerPlan, {
      type: 'assign',
      bundleId: shard.id,
      workerId: worker.id,
    });
    return worker;
  });
  const reducer: ManagedTaskWorkerSpec = {
    id: 'investigation-reducer',
    role: 'evaluator',
    title: 'Investigation Reducer',
    dependsOn: validators.map((worker) => worker.id),
    agent: buildManagedWorkerAgent('evaluator', 'investigation-reducer'),
    toolPolicy: reducerToolPolicy,
    terminalAuthority: true,
    metadata: {
      role: 'evaluator',
      reductionStrategy: 'evaluator-assisted',
    },
    prompt: buildTacticalInvestigationReducerPrompt(
      originalTask,
      scheduledShards,
      path.join(shape.workspaceDir, TACTICAL_CHILD_LEDGER_JSON),
    ),
  };
  reducer.beforeToolExecute = createToolPolicyHook(reducer);

  shape.workers = [...validators, reducer];
  shape.terminalWorkerId = reducer.id;
  const roleAssignments: KodaXManagedTask['roleAssignments'] = [
    ...shape.task.roleAssignments.map((assignment) => (
      assignment.id === 'investigation-scan'
        ? {
            ...assignment,
            status: 'completed' as const,
            summary: [
              scannerDirective?.summary ?? truncateText(scannerOutput || 'Investigation scanner completed.'),
              duplicateShardNote,
            ].filter(Boolean).join(' '),
          }
        : assignment
    )),
    ...shape.workers.map((worker) => ({
      id: worker.id,
      role: worker.role,
      title: worker.title,
      dependsOn: worker.dependsOn ?? [],
      status: 'planned' as const,
      agent: worker.agent,
      toolPolicy: worker.toolPolicy,
    })),
  ];
  shape.task = {
    ...shape.task,
    runtime: {
      ...shape.task.runtime,
      fanoutSchedulerPlan,
    },
    roleAssignments,
    workItems: [
      ...shape.task.workItems,
      ...shape.workers.map((worker) => ({
        id: worker.id,
        assignmentId: worker.id,
        description: worker.title,
        execution: worker.execution ?? 'serial',
      })),
    ],
    verdict: {
      ...shape.task.verdict,
      decidedByAssignmentId: reducer.id,
      summary: 'AMA Tactical investigation is validating evidence shards in parallel.',
    },
  };

  const workerResults = new Map<string, KodaXResult>();
  const childResults: KodaXChildAgentResult[] = [];
  const childArtifacts: KodaXTaskEvidenceArtifact[] = [];
  let directive: ManagedTaskVerdictDirective | undefined;
  const tacticalRunner = createKodaXTaskRunner<ManagedTaskWorkerSpec>({
    baseOptions: managedOptions,
    runAgent: runDirectKodaX,
    createOptions: (worker, _context, defaultOptions) => buildWorkerRunOptions(
      defaultOptions,
      shape.task,
      worker,
      shape.terminalWorkerId,
      shape.routingPromptOverlay,
      shape.qualityAssuranceMode,
      sessionStorage,
      resolveManagedMemoryStrategy(managedOptions, plan, worker.role, 1),
      createBudgetSnapshot(budgetController, shape.task.contract.harnessProfile, 1, worker.role, worker.id),
      budgetController,
    ),
    runTask: async (worker, _context, preparedOptions, promptText, executeDefault) => {
      if (worker.role === 'evaluator') {
        childLedgerArtifacts = await writeTacticalChildResultLedger(
          shape.workspaceDir,
          fanoutSchedulerPlan,
          childContextBundles,
          childResults,
          parentReductionContract,
          { includeMarkdown: false },
        );
      }
      const execution = await runManagedWorkerTask(
        worker,
        preparedOptions,
        promptText,
        executeDefault,
        budgetController,
      );
      return execution.result;
    },
    onResult: async (worker, context, result) => {
      const sanitized = worker.role === 'evaluator'
        ? sanitizeManagedWorkerResult(result, { enforceVerdictBlock: true })
        : sanitizeHandoffResult(result, worker.title);
      workerResults.set(worker.id, sanitized.result);
      if (worker.role === 'evaluator') {
        directive = sanitized.directive as ManagedTaskVerdictDirective | undefined;
      } else {
        const artifactPaths = buildTacticalChildArtifactPaths(context.taskDir);
        const handoffDirective = sanitized.directive as ManagedTaskHandoffDirective | undefined;
        if (handoffDirective) {
          await writeTacticalChildHandoffArtifact(artifactPaths.handoffPath, handoffDirective);
          childArtifacts.push({
            kind: 'json',
            path: artifactPaths.handoffPath,
            description: `Dependency handoff for ${resolveTacticalWorkerBundleId(worker)}`,
          });
        }
        const parsedChildResult = parseChildAgentResult(extractMessageText(result) || result.lastText);
        const normalizedChildResult = normalizeTacticalChildResult(
          worker,
          handoffDirective,
          sanitized.result,
          parsedChildResult,
          artifactPaths,
        );
        await writeFile(
          artifactPaths.childResultPath,
          `${JSON.stringify(normalizedChildResult, null, 2)}\n`,
          'utf8',
        );
        upsertChildAgentResult(childResults, normalizedChildResult);
        fanoutSchedulerPlan = applyFanoutBranchTransition(fanoutSchedulerPlan, {
          type: 'complete',
          bundleId: resolveTacticalWorkerBundleId(worker),
          childId: normalizedChildResult.childId,
        });
        childArtifacts.push({
          kind: 'json',
          path: artifactPaths.childResultPath,
          description: `Child-agent result for ${normalizedChildResult.childId}`,
        });
      }
      return sanitized.result;
    },
  });

  const roundWorkspaceDir = path.join(shape.workspaceDir, 'rounds', 'round-01');
  const orchestrationResult = await runOrchestration<ManagedTaskWorkerSpec, string>({
    workspaceDir: roundWorkspaceDir,
    runId: `${shape.task.contract.taskId}-tactical-investigation`,
    maxParallel: fanoutSchedulerPlan.maxParallel,
    tasks: shape.workers,
    runner: tacticalRunner,
    events: createTacticalFanoutStatusEvents(
      managedOptions.events,
      agentMode,
      shape.task.contract.harnessProfile,
      () => fanoutSchedulerPlan,
    ),
  });

  let managedTask = applyOrchestrationResultToTask(
    shape.task,
    shape.terminalWorkerId,
    orchestrationResult,
    workerResults,
    1,
    roundWorkspaceDir,
  );
  childLedgerArtifacts = await writeTacticalChildResultLedger(
    shape.workspaceDir,
    fanoutSchedulerPlan,
    childContextBundles,
    childResults,
    parentReductionContract,
  );
  managedTask = {
    ...managedTask,
    evidence: {
      ...managedTask.evidence,
      artifacts: mergeEvidenceArtifacts(
        managedTask.evidence.artifacts,
        childArtifacts,
        childLedgerArtifacts,
      ),
    },
    runtime: {
      ...managedTask.runtime,
      childContextBundles,
      childAgentResults: childResults,
      fanoutSchedulerPlan,
      scorecard: createVerificationScorecard(managedTask, directive),
    },
  };
  directive = applyTacticalInvestigationParentReduction(
    directive,
    fanoutSchedulerPlan,
    shards,
    childResults,
  );
  managedTask = applyManagedTaskDirective(managedTask, directive);
  const terminalResult = workerResults.get(shape.terminalWorkerId);
  const preferredPublicText = directive?.userAnswer?.trim() || directive?.userFacingText;
  if (terminalResult && directive && preferredPublicText) {
    workerResults.set(shape.terminalWorkerId, {
      ...terminalResult,
      success: directive.status === 'accept',
      lastText: preferredPublicText,
      signal: directive.status === 'accept' ? terminalResult.signal : 'BLOCKED',
      signalReason: directive.status === 'accept'
        ? terminalResult.signalReason
        : directive.reason ?? terminalResult.signalReason,
      messages: replaceLastAssistantMessage(terminalResult.messages, preferredPublicText),
    });
  }

  const result = buildFallbackManagedResult(
    managedTask,
    workerResults,
    shape.terminalWorkerId,
  );
  await writeManagedTaskArtifacts(
    shape.workspaceDir,
    managedTask,
    {
      success: result.success,
      lastText: result.lastText,
      sessionId: result.sessionId,
      signal: result.signal,
      signalReason: result.signalReason,
    },
    directive,
  );
  managedOptions.events?.onManagedTaskStatus?.({
    agentMode,
    harnessProfile: managedTask.contract.harnessProfile,
    activeWorkerId: shape.terminalWorkerId,
    activeWorkerTitle: reducer.title,
    phase: 'completed',
    note: managedTask.verdict.summary,
  });
  return {
    ...result,
    routingDecision: finalRoutingDecision,
  };
}

function extractMessageText(result: Partial<KodaXResult> | undefined): string {
  if (!result) {
    return '';
  }

  if (typeof result.lastText === 'string' && result.lastText.trim()) {
    return result.lastText;
  }

  const lastMessage = result.messages?.[result.messages.length - 1];
  if (!lastMessage) {
    return '';
  }

  if (typeof lastMessage.content === 'string') {
    return lastMessage.content;
  }

  return lastMessage.content
    .map((part) => ('text' in part ? part.text : '') || '')
    .join('');
}

function replaceLastAssistantMessage(messages: KodaXResult['messages'], text: string): KodaXResult['messages'] {
  if (messages.length === 0) {
    return [{ role: 'assistant', content: text }];
  }

  const nextMessages = [...messages];
  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (message?.role !== 'assistant') {
      continue;
    }

    nextMessages[index] = {
      ...message,
      content: text,
    };
    return nextMessages;
  }

  nextMessages.push({ role: 'assistant', content: text });
  return nextMessages;
}

const MANAGED_CONTROL_PLANE_MARKERS = [
  '[Managed Task Protocol Retry]',
  'Assigned native agent identity:',
  'Tool policy:',
  'Blocked tools:',
  'Allowed shell patterns:',
  'Dependency handoff artifacts:',
  'Dependency summary preview:',
  'Preferred agent:',
  'Read structured bundle first:',
  'Read human summary next:',
];

function sanitizeManagedUserFacingText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  let cutIndex = -1;
  for (const marker of MANAGED_CONTROL_PLANE_MARKERS) {
    const index = trimmed.indexOf(marker);
    if (index >= 0 && (cutIndex === -1 || index < cutIndex)) {
      cutIndex = index;
    }
  }
  if (cutIndex === 0) {
    return '';
  }
  return (cutIndex > 0 ? trimmed.slice(0, cutIndex) : trimmed).trim();
}

function sanitizeEvaluatorPublicAnswer(text: string): string {
  const sanitized = sanitizeManagedUserFacingText(text).trim();
  if (!sanitized) {
    return '';
  }

  const paragraphs = sanitized.split(/\n\s*\n/);
  const remaining = [...paragraphs];
  let removedInternalFraming = false;

  const internalRolePattern = /\b(generator|planner|evaluator|verdict|contract|handoff|managed task)\b/i;
  const internalMetaPattern = /\b(spot-check|spot check|verification|double-check|double check|sufficient evidence)\b/i;
  const explicitProcessLeadPattern = /^(confirmed:|i now have sufficient evidence\b|let me (?:verify|check|double-check|review)\b|now let me\b|good\.\s*now let me\b|from the code i(?:'ve| have)? already (?:read|checked|reviewed)\b|here is my final evaluation\b)/i;

  while (remaining.length > 0) {
    const paragraph = remaining[0]?.trim() ?? '';
    if (!paragraph) {
      remaining.shift();
      removedInternalFraming = true;
      continue;
    }

    const isDivider = /^-{3,}$/.test(paragraph);
    if (isDivider && removedInternalFraming) {
      remaining.shift();
      continue;
    }

    const isExplicitProcessLead = explicitProcessLeadPattern.test(paragraph);
    const isInternalProcessLead = /^i\b/i.test(paragraph)
      && internalRolePattern.test(paragraph)
      && internalMetaPattern.test(paragraph);

    if (
      isExplicitProcessLead
      || isInternalProcessLead
    ) {
      remaining.shift();
      removedInternalFraming = true;
      continue;
    }

    break;
  }

  const cleaned = remaining.join('\n\n').trim();
  return cleaned || sanitized;
}

function parseManagedTaskScoutDirective(text: string): ManagedTaskScoutDirective | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_SCOUT_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  const body = match[1]?.trim() ?? '';
  const visibleText = sanitizeManagedUserFacingText(text.slice(0, match.index ?? text.length).trim());
  let summary: string | undefined;
  let confirmedHarness: ManagedTaskScoutDirective['confirmedHarness'];
  let evidenceAcquisitionMode: ManagedTaskScoutDirective['evidenceAcquisitionMode'];
  const scope: string[] = [];
  const requiredEvidence: string[] = [];
  const reviewFilesOrAreas: string[] = [];
  let skillSummary: string | undefined;
  let projectionConfidence: KodaXSkillMap['projectionConfidence'] | undefined;
  const executionObligations: string[] = [];
  const verificationObligations: string[] = [];
  const ambiguities: string[] = [];
  let currentList:
    | 'scope'
    | 'evidence'
    | 'review-files'
    | 'execution-obligations'
    | 'verification-obligations'
    | 'ambiguities'
    | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const normalized = line.toLowerCase();
    if (normalized.startsWith('summary:')) {
      summary = line.slice('summary:'.length).trim();
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('confirmed_harness:')) {
      const candidate = line.slice('confirmed_harness:'.length).trim();
      if (candidate === 'H0_DIRECT' || candidate === 'H1_EXECUTE_EVAL' || candidate === 'H2_PLAN_EXECUTE_EVAL') {
        confirmedHarness = candidate;
      }
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('evidence_acquisition_mode:')) {
      const candidate = line.slice('evidence_acquisition_mode:'.length).trim();
      if (candidate === 'overview' || candidate === 'diff-bundle' || candidate === 'diff-slice' || candidate === 'file-read') {
        evidenceAcquisitionMode = candidate;
      }
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('skill_summary:')) {
      skillSummary = line.slice('skill_summary:'.length).trim();
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('projection_confidence:')) {
      const candidate = line.slice('projection_confidence:'.length).trim().toLowerCase();
      if (candidate === 'high' || candidate === 'medium' || candidate === 'low') {
        projectionConfidence = candidate;
      }
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('scope:')) {
      currentList = 'scope';
      continue;
    }
    if (normalized.startsWith('required_evidence:')) {
      currentList = 'evidence';
      continue;
    }
    if (normalized.startsWith('review_files_or_areas:')) {
      currentList = 'review-files';
      continue;
    }
    if (normalized.startsWith('execution_obligations:')) {
      currentList = 'execution-obligations';
      continue;
    }
    if (normalized.startsWith('verification_obligations:')) {
      currentList = 'verification-obligations';
      continue;
    }
    if (normalized.startsWith('ambiguities:')) {
      currentList = 'ambiguities';
      continue;
    }

    const item = line.replace(/^-+\s*/, '').trim();
    if (!item || !currentList) {
      continue;
    }
    if (currentList === 'scope') {
      scope.push(item);
    } else if (currentList === 'evidence') {
      requiredEvidence.push(item);
    } else if (currentList === 'review-files') {
      reviewFilesOrAreas.push(item);
    } else if (currentList === 'execution-obligations') {
      executionObligations.push(item);
    } else if (currentList === 'verification-obligations') {
      verificationObligations.push(item);
    } else if (currentList === 'ambiguities') {
      ambiguities.push(item);
    }
  }

  if (
    !summary
    && scope.length === 0
    && requiredEvidence.length === 0
    && reviewFilesOrAreas.length === 0
    && !confirmedHarness
    && !evidenceAcquisitionMode
    && !skillSummary
    && executionObligations.length === 0
    && verificationObligations.length === 0
    && ambiguities.length === 0
    && !projectionConfidence
    && !visibleText
  ) {
    return undefined;
  }

  return {
    summary,
    scope: scope.filter(Boolean),
    requiredEvidence: requiredEvidence.filter(Boolean),
    reviewFilesOrAreas: reviewFilesOrAreas.filter(Boolean),
    evidenceAcquisitionMode,
    confirmedHarness,
    userFacingText: visibleText,
    skillMap: skillSummary || executionObligations.length > 0 || verificationObligations.length > 0 || ambiguities.length > 0 || projectionConfidence
      ? {
          skillSummary,
          executionObligations: executionObligations.filter(Boolean),
          verificationObligations: verificationObligations.filter(Boolean),
          ambiguities: ambiguities.filter(Boolean),
          projectionConfidence,
        }
      : undefined,
  };
}

function buildSkillMap(
  skillInvocation: KodaXSkillInvocationContext | undefined,
  scoutDirective: ManagedTaskScoutDirective | undefined,
): KodaXSkillMap | undefined {
  if (!skillInvocation) {
    return undefined;
  }

  const scoutSkillMap = scoutDirective?.skillMap;
  const requiredEvidence = Array.from(new Set([
    ...(scoutDirective?.requiredEvidence ?? []),
  ].map((item) => item.trim()).filter(Boolean)));
  const projectionConfidence = scoutSkillMap?.projectionConfidence
    ?? (scoutSkillMap?.skillSummary || scoutSkillMap?.executionObligations.length || scoutSkillMap?.verificationObligations.length
      ? 'medium'
      : 'low');
  const ambiguities = [
    ...(scoutSkillMap?.ambiguities ?? []),
  ].map((item) => item.trim()).filter(Boolean);

  if (projectionConfidence === 'low' && ambiguities.length === 0) {
    ambiguities.push('Scout did not provide a confident skill decomposition. Use the raw skill as the authority when obligations or evidence requirements are unclear.');
  }

  return {
    skillSummary: scoutSkillMap?.skillSummary
      ?? skillInvocation.description
      ?? `Use the ${skillInvocation.name} skill in the context of the current user request.`,
    executionObligations: [...(scoutSkillMap?.executionObligations ?? [])].map((item) => item.trim()).filter(Boolean),
    verificationObligations: [...(scoutSkillMap?.verificationObligations ?? [])].map((item) => item.trim()).filter(Boolean),
    requiredEvidence,
    ambiguities,
    projectionConfidence,
    rawSkillFallbackAllowed: projectionConfidence === 'low',
    allowedTools: skillInvocation.allowedTools,
    preferredAgent: skillInvocation.agent,
    preferredModel: skillInvocation.model,
    invocationContext: skillInvocation.context,
    hookEvents: skillInvocation.hookEvents,
  };
}

function parseManagedTaskHandoffDirective(text: string): ManagedTaskHandoffDirective | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_HANDOFF_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  const body = match[1]?.trim() ?? '';
  const visibleText = sanitizeManagedUserFacingText(text.slice(0, match.index ?? text.length).trim());
  let status: ManagedTaskHandoffDirective['status'] | undefined;
  let summary: string | undefined;
  const evidence: string[] = [];
  const followup: string[] = [];
  let currentList: 'evidence' | 'followup' | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const normalized = line.toLowerCase();
    if (normalized.startsWith('status:')) {
      const candidate = line.slice('status:'.length).trim().toLowerCase();
      if (candidate === 'ready' || candidate === 'incomplete' || candidate === 'blocked') {
        status = candidate;
      }
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('summary:')) {
      summary = line.slice('summary:'.length).trim();
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('evidence:')) {
      currentList = 'evidence';
      continue;
    }
    if (normalized.startsWith('followup:')) {
      currentList = 'followup';
      continue;
    }

    const item = line.replace(/^-+\s*/, '').trim();
    if (!item || !currentList) {
      continue;
    }
    if (currentList === 'evidence') {
      evidence.push(item);
    } else {
      followup.push(item);
    }
  }

  if (!status) {
    return undefined;
  }

  return {
    status,
    summary,
    evidence: evidence.filter(Boolean),
    followup: followup.filter(Boolean),
    userFacingText: visibleText,
  };
}

function parseManagedTaskVerdictDirective(text: string): ManagedTaskVerdictDirective | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_VERDICT_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  const body = match[1]?.trim() ?? '';
  const visibleText = sanitizeManagedUserFacingText(text.slice(0, match.index ?? text.length).trim());
  let status: ManagedTaskVerdictDirective['status'] | undefined;
  let reason: string | undefined;
  let userAnswer: string | undefined;
  let nextHarness: ManagedTaskVerdictDirective['nextHarness'];
  const followups: string[] = [];
  let activeSection: 'followup' | 'user_answer' | undefined;
  let userAnswerLines: string[] = [];

  const flushUserAnswer = () => {
    if (userAnswerLines.length === 0) {
      return;
    }
    userAnswer = userAnswerLines.join('\n').trim() || undefined;
    userAnswerLines = [];
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    const normalized = line.toLowerCase();
    const fieldMatch = normalized.match(/^(status|reason|user_answer|next_harness|followup):\s*(.*)$/);
    if (activeSection === 'user_answer' && fieldMatch && fieldMatch[1] !== 'user_answer') {
      flushUserAnswer();
      activeSection = undefined;
    }
    if (!line) {
      if (activeSection === 'user_answer') {
        userAnswerLines.push('');
      }
      continue;
    }
    if (normalized.startsWith('status:')) {
      const candidate = line.slice('status:'.length).trim().toLowerCase();
      if (candidate === 'accept' || candidate === 'revise' || candidate === 'blocked') {
        status = candidate;
      }
      activeSection = undefined;
      continue;
    }
    if (normalized.startsWith('reason:')) {
      reason = line.slice('reason:'.length).trim();
      activeSection = undefined;
      continue;
    }
    if (normalized.startsWith('user_answer:')) {
      flushUserAnswer();
      activeSection = 'user_answer';
      const firstLine = rawLine.replace(/^\s*user_answer:\s*/i, '');
      userAnswerLines.push(firstLine);
      continue;
    }
    if (normalized.startsWith('next_harness:')) {
      const candidate = line.slice('next_harness:'.length).trim();
      if (candidate === 'H1_EXECUTE_EVAL' || candidate === 'H2_PLAN_EXECUTE_EVAL') {
        nextHarness = candidate;
      }
      activeSection = undefined;
      continue;
    }
    if (normalized.startsWith('followup:')) {
      flushUserAnswer();
      activeSection = 'followup';
      continue;
    }
    if (activeSection === 'user_answer') {
      userAnswerLines.push(rawLine);
      continue;
    }
    if (activeSection === 'followup') {
      followups.push(line.replace(/^-+\s*/, '').trim());
    }
  }

  flushUserAnswer();

  if (!status) {
    return undefined;
  }

  return {
    source: 'evaluator',
    status,
    reason,
    nextHarness,
    followups: followups.filter(Boolean),
    userFacingText: visibleText,
    userAnswer,
  };
}

function parseJsonFencedBlock<T>(text: string, blockName: string): T | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${blockName}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  const body = match[1]?.trim();
  if (!body) {
    return undefined;
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}

function parseTacticalReviewFindingsDirective(
  text: string,
): TacticalReviewFindingsDirective | undefined {
  const directive = parseJsonFencedBlock<{
    summary?: string;
    findings?: Array<{
      id?: string;
      title?: string;
      claim?: string;
      priority?: 'high' | 'medium' | 'low';
      files?: string[];
      evidence?: string[];
    }>;
  }>(text, TACTICAL_REVIEW_FINDINGS_BLOCK);
  if (!directive) {
    return undefined;
  }

  const findings = (directive.findings ?? [])
    .map((finding, index): TacticalReviewFinding | undefined => {
      const title = finding.title?.trim();
      const claim = finding.claim?.trim();
      if (!title || !claim) {
        return undefined;
      }
      return {
        id: finding.id?.trim() || `finding-${index + 1}`,
        title,
        claim,
        priority: finding.priority ?? 'medium',
        files: finding.files?.map((item) => item.trim()).filter(Boolean) ?? [],
        evidence: finding.evidence?.map((item) => item.trim()).filter(Boolean) ?? [],
      };
    })
    .filter((finding): finding is TacticalReviewFinding => Boolean(finding));
  if (findings.length === 0) {
    return undefined;
  }

  const visibleMatch = text.match(new RegExp(String.raw`([\s\S]*?)\r?\n?\`\`\`${TACTICAL_REVIEW_FINDINGS_BLOCK}\s*[\s\S]*\`\`\`\s*$`, 'i'));
  const visibleText = sanitizeManagedUserFacingText((visibleMatch?.[1] ?? '').trim());

  return {
    summary: directive.summary?.trim() || 'Review scanner identified candidate findings for validation.',
    findings,
    userFacingText: visibleText,
  };
}

function parseTacticalInvestigationShardsDirective(
  text: string,
): TacticalInvestigationShardsDirective | undefined {
  const directive = parseJsonFencedBlock<{
    summary?: string;
    shards?: Array<{
      id?: string;
      question?: string;
      scope?: string;
      priority?: 'high' | 'medium' | 'low';
      files?: string[];
      evidence?: string[];
    }>;
  }>(text, TACTICAL_INVESTIGATION_SHARDS_BLOCK);
  if (!directive) {
    return undefined;
  }

  const shards = (directive.shards ?? [])
    .map((shard, index): TacticalInvestigationShard | undefined => {
      const question = shard.question?.trim();
      const scope = shard.scope?.trim();
      if (!question || !scope) {
        return undefined;
      }
      return {
        id: shard.id?.trim() || `shard-${index + 1}`,
        question,
        scope,
        priority: shard.priority ?? 'medium',
        files: shard.files?.map((item) => item.trim()).filter(Boolean) ?? [],
        evidence: shard.evidence?.map((item) => item.trim()).filter(Boolean) ?? [],
      };
    })
    .filter((shard): shard is TacticalInvestigationShard => Boolean(shard));

  const visibleMatch = text.match(new RegExp(String.raw`([\s\S]*?)\r?\n?\`\`\`${TACTICAL_INVESTIGATION_SHARDS_BLOCK}\s*[\s\S]*\`\`\`\s*$`, 'i'));
  const visibleText = sanitizeManagedUserFacingText((visibleMatch?.[1] ?? '').trim());

  return {
    summary: directive.summary?.trim() || 'Investigation scanner identified bounded evidence shards for validation.',
    shards,
    userFacingText: visibleText,
  };
}

function parseChildAgentResult(text: string): KodaXChildAgentResult | undefined {
  const parsed = parseJsonFencedBlock<KodaXChildAgentResult>(text, TACTICAL_CHILD_RESULT_BLOCK);
  if (!parsed) {
    return undefined;
  }
  if (!parsed.childId || !parsed.fanoutClass || !parsed.status || !parsed.disposition || !parsed.summary) {
    return undefined;
  }
  return {
    ...parsed,
    evidenceRefs: parsed.evidenceRefs ?? [],
    contradictions: parsed.contradictions ?? [],
    artifactPaths: parsed.artifactPaths ?? [],
  };
}

function hasRequiredTacticalChildArtifacts(
  artifactPaths: string[],
  requiredArtifacts: string[],
): boolean {
  if (requiredArtifacts.length === 0) {
    return true;
  }
  const normalizedNames = artifactPaths.map((artifactPath) => path.basename(artifactPath).toLowerCase());
  return requiredArtifacts.every((artifactName) => normalizedNames.includes(artifactName.toLowerCase()));
}

function createFailClosedChildAgentResult(
  worker: ManagedTaskWorkerSpec,
  result: KodaXResult,
  options?: {
    summary?: string;
    contradictions?: string[];
    artifactPaths?: string[];
    childId?: string;
    fanoutClass?: KodaXAmaFanoutClass;
    status?: KodaXChildAgentResult['status'];
  },
): KodaXChildAgentResult {
  const childId = options?.childId ?? resolveTacticalWorkerBundleId(worker);
  const fanoutClass = options?.fanoutClass ?? resolveTacticalWorkerFanoutClass(worker);
  const summary = options?.summary ?? (
    result.success
      ? `Structured ${TACTICAL_CHILD_RESULT_BLOCK} output was missing or malformed; treat ${childId} as unresolved.`
      : result.signalReason?.trim()
        || `Validator did not finish cleanly for ${childId}; treat it as unresolved.`
  );

  return {
    childId,
    fanoutClass,
    status: options?.status ?? (
      result.success
        ? 'failed'
        : result.signal === 'BLOCKED'
          ? 'blocked'
          : 'failed'
    ),
    disposition: 'needs-more-evidence',
    summary,
    evidenceRefs: [],
    contradictions: options?.contradictions ?? [
      'Missing or malformed structured child result.',
    ],
    artifactPaths: options?.artifactPaths ?? [],
    sessionId: result.sessionId,
  };
}

function normalizeTacticalChildResult(
  worker: ManagedTaskWorkerSpec,
  handoffDirective: ManagedTaskHandoffDirective | undefined,
  result: KodaXResult,
  parsedChildResult: KodaXChildAgentResult | undefined,
  artifactPaths: {
    childResultPath: string;
    handoffPath: string;
  },
): KodaXChildAgentResult {
  const fallbackChildId = resolveTacticalWorkerBundleId(worker);
  const fallbackFanoutClass = resolveTacticalWorkerFanoutClass(worker);
  const normalizedArtifactPaths = Array.from(new Set([
    ...(parsedChildResult?.artifactPaths ?? []),
    artifactPaths.childResultPath,
    ...(handoffDirective ? [artifactPaths.handoffPath] : []),
  ]));
  const childId = parsedChildResult?.childId || fallbackChildId;
  const fanoutClass = parsedChildResult?.fanoutClass || fallbackFanoutClass;
  const requiredArtifacts = [
    TACTICAL_CHILD_RESULT_ARTIFACT_JSON,
    TACTICAL_CHILD_HANDOFF_JSON,
  ];

  if (!handoffDirective) {
    return createFailClosedChildAgentResult(worker, result, {
      childId,
      fanoutClass,
      status: 'blocked',
      summary: `Validator omitted required ${MANAGED_TASK_HANDOFF_BLOCK}; treat ${childId} as unresolved.`,
      contradictions: ['Missing validator handoff block.'],
      artifactPaths: normalizedArtifactPaths,
    });
  }

  if (handoffDirective.status !== 'ready') {
    return createFailClosedChildAgentResult(worker, result, {
      childId,
      fanoutClass,
      status: handoffDirective.status === 'blocked' ? 'blocked' : 'failed',
      summary: `Validator handoff reported ${handoffDirective.status}; treat ${childId} as unresolved.`,
      contradictions: [`Validator handoff status was ${handoffDirective.status}.`],
      artifactPaths: normalizedArtifactPaths,
    });
  }

  if (!parsedChildResult) {
    return createFailClosedChildAgentResult(worker, result, {
      childId,
      fanoutClass,
      status: 'failed',
      summary: `Structured ${TACTICAL_CHILD_RESULT_BLOCK} output was missing or malformed; treat ${childId} as unresolved.`,
      contradictions: ['Missing or malformed structured child result.'],
      artifactPaths: normalizedArtifactPaths,
    });
  }

  if (parsedChildResult.status !== 'completed') {
    return createFailClosedChildAgentResult(worker, result, {
      childId,
      fanoutClass,
      status: parsedChildResult.status === 'blocked' ? 'blocked' : 'failed',
      summary: `Structured child result for ${childId} reported status=${parsedChildResult.status}; treat it as unresolved.`,
      contradictions: [`Structured child result status was ${parsedChildResult.status}.`],
      artifactPaths: normalizedArtifactPaths,
    });
  }

  if (!hasRequiredTacticalChildArtifacts(normalizedArtifactPaths, requiredArtifacts)) {
    return createFailClosedChildAgentResult(worker, result, {
      childId,
      fanoutClass,
      status: 'failed',
      summary: `Required child artifacts were missing for ${childId}; treat it as unresolved.`,
      contradictions: ['Required child artifacts were missing.'],
      artifactPaths: normalizedArtifactPaths,
    });
  }

  return {
    ...parsedChildResult,
    childId,
    fanoutClass,
    artifactPaths: normalizedArtifactPaths,
    sessionId: parsedChildResult.sessionId ?? result.sessionId,
  };
}

function upsertChildAgentResult(
  childResults: KodaXChildAgentResult[],
  childResult: KodaXChildAgentResult,
): void {
  const existingIndex = childResults.findIndex((candidate) => candidate.childId === childResult.childId);
  if (existingIndex >= 0) {
    childResults.splice(existingIndex, 1, childResult);
    return;
  }
  childResults.push(childResult);
}

function renderFailClosedTacticalReviewAnswer(
  childContextBundles: KodaXChildContextBundle[],
  childResults: KodaXChildAgentResult[],
  unresolvedBranches: KodaXFanoutBranchRecord[],
): string {
  const bundleTitleById = new Map(
    childContextBundles.map((bundle) => [bundle.id, bundle.scopeSummary ?? bundle.objective] as const),
  );
  const validResults = childResults.filter((result) => result.disposition === 'valid');

  return [
    '## Review Status',
    '',
    'The review cannot be finalized yet because not every candidate finding has a trustworthy structured child result.',
    '',
    '## Unresolved Findings',
    ...unresolvedBranches.map((branch) => `- ${bundleTitleById.get(branch.bundleId) ?? branch.bundleId}`),
    '',
    '## Confirmed Findings',
    ...(validResults.length > 0
      ? validResults.map((result) => `- ${result.summary}`)
      : ['- No validator-backed findings are ready to publish yet.']),
    '',
    '## Next Step',
    '',
    '- Re-run validation for the unresolved findings before treating the review as complete.',
  ].join('\n');
}

function renderFailClosedTacticalInvestigationAnswer(
  shards: TacticalInvestigationShard[],
  childResults: KodaXChildAgentResult[],
  unresolvedBranches: KodaXFanoutBranchRecord[],
): string {
  const shardById = new Map(shards.map((shard) => [shard.id, shard] as const));
  const validResults = childResults.filter((result) => result.disposition === 'valid');
  const falsePositiveResults = childResults.filter((result) => result.disposition === 'false-positive');
  const unresolvedLabels = unresolvedBranches.map((branch) => {
    const shard = shardById.get(branch.bundleId);
    return shard ? `${shard.scope} (${shard.priority})` : branch.bundleId;
  });

  if (unresolvedLabels.length === 0 && validResults.length === 0) {
    return [
      '## Investigation Status',
      '',
      'The investigation is still inconclusive because the validated evidence collected so far does not support the current diagnosis.',
      '',
      '## Missing Evidence',
      '- No unresolved evidence shards remain, but the current lead still lacks validator-backed support.',
      '',
      '## Supporting Evidence',
      '- No shard has yet produced validator-backed evidence that confirms the diagnosis.',
      '',
      '## Rejected Or Weakened Leads',
      ...(falsePositiveResults.length > 0
        ? falsePositiveResults.map((result) => `- ${result.summary}`)
        : ['- None yet.']),
      '',
      '## Next Step',
      '',
      '- Reframe the current diagnosis or gather new evidence before treating this investigation as settled.',
    ].join('\n');
  }

  return [
    '## Investigation Status',
    '',
    'The investigation is still inconclusive because one or more evidence shards are unresolved or waiting on trustworthy validation.',
    '',
    '## Missing Evidence',
    ...(unresolvedLabels.length > 0
      ? unresolvedLabels.map((label) => `- ${label}`)
      : ['- Additional corroborating evidence is still needed before accepting the diagnosis.']),
    '',
    '## Supporting Evidence',
    ...(validResults.length > 0
      ? validResults.map((result) => `- ${result.summary}`)
      : ['- No shard has yet produced validator-backed evidence that confirms the diagnosis.']),
    '',
    '## Rejected Or Weakened Leads',
    ...(falsePositiveResults.length > 0
      ? falsePositiveResults.map((result) => `- ${result.summary}`)
      : ['- None yet.']),
    '',
    '## Next Step',
    '',
    '- Gather or re-run the unresolved high-priority evidence shards before treating this investigation as settled.',
  ].join('\n');
}

function applyTacticalParentReduction(
  directive: ManagedTaskVerdictDirective | undefined,
  fanoutSchedulerPlan: KodaXFanoutSchedulerPlan,
  childContextBundles: KodaXChildContextBundle[],
  childResults: KodaXChildAgentResult[],
): ManagedTaskVerdictDirective | undefined {
  const unresolvedBranches = fanoutSchedulerPlan.branches.filter((branch) => {
    if (branch.status === 'deferred' || branch.status === 'cancelled') {
      return true;
    }
    const childResult = childResults.find((candidate) => candidate.childId === (branch.childId ?? branch.bundleId));
    if (!childResult) {
      return branch.status === 'scheduled';
    }
    return childResult.status !== 'completed'
      || childResult.disposition === 'needs-more-evidence';
  });
  if (unresolvedBranches.length === 0) {
    return directive;
  }

  const reason = `Structured child validation remains incomplete for ${unresolvedBranches.map((branch) => branch.bundleId).join(', ')}.`;
  const userAnswer = renderFailClosedTacticalReviewAnswer(
    childContextBundles,
    childResults,
    unresolvedBranches,
  );

  return {
    source: 'evaluator',
    status: 'revise',
    reason,
    followups: [
      'Re-run validation for every unresolved or deferred child finding before finalizing the review.',
    ],
    userFacingText: userAnswer,
    userAnswer,
    artifactPath: directive?.artifactPath,
  };
}

function applyTacticalInvestigationParentReduction(
  directive: ManagedTaskVerdictDirective | undefined,
  fanoutSchedulerPlan: KodaXFanoutSchedulerPlan,
  shards: TacticalInvestigationShard[],
  childResults: KodaXChildAgentResult[],
): ManagedTaskVerdictDirective | undefined {
  const childResultById = new Map(
    childResults.map((result) => [result.childId, result] as const),
  );
  const shardById = new Map(shards.map((shard) => [shard.id, shard] as const));
  const unresolvedBranches = fanoutSchedulerPlan.branches.filter((branch) => {
    if (branch.status === 'deferred' || branch.status === 'cancelled') {
      return true;
    }
    const childResult = childResultById.get(branch.childId ?? branch.bundleId);
    if (!childResult) {
      return branch.status === 'scheduled';
    }
    return childResult.status !== 'completed'
      || childResult.disposition === 'needs-more-evidence';
  });
  const unresolvedHighPriority = unresolvedBranches.filter((branch) => shardById.get(branch.bundleId)?.priority === 'high');
  const hasValidEvidence = childResults.some((result) => result.disposition === 'valid');

  if (unresolvedHighPriority.length === 0 && hasValidEvidence) {
    return directive;
  }

  const unresolvedIds = unresolvedBranches.map((branch) => branch.bundleId);
  const reason = unresolvedHighPriority.length > 0
    ? `High-priority evidence shards remain unresolved: ${unresolvedHighPriority.map((branch) => branch.bundleId).join(', ')}.`
    : hasValidEvidence
      ? `Investigation evidence remains incomplete for ${unresolvedIds.join(', ')}.`
      : 'Validated evidence does not support accepting the current diagnosis yet.';
  const userAnswer = renderFailClosedTacticalInvestigationAnswer(
    shards,
    childResults,
    unresolvedBranches,
  );

  return {
    source: 'evaluator',
    status: 'revise',
    reason,
    followups: [
      'Re-run or expand the unresolved evidence shards before treating the investigation as complete.',
    ],
    userFacingText: userAnswer,
    userAnswer,
    artifactPath: directive?.artifactPath,
  };
}

function parseManagedTaskContractDirective(text: string): ManagedTaskContractDirective | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_CONTRACT_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  const body = match[1]?.trim() ?? '';
  let summary: string | undefined;
  const successCriteria: string[] = [];
  const requiredEvidence: string[] = [];
  const constraints: string[] = [];
  let currentList: 'success' | 'evidence' | 'constraints' | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const normalized = line.toLowerCase();
    if (normalized.startsWith('summary:')) {
      summary = line.slice('summary:'.length).trim();
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('success_criteria:')) {
      currentList = 'success';
      continue;
    }
    if (normalized.startsWith('required_evidence:')) {
      currentList = 'evidence';
      continue;
    }
    if (normalized.startsWith('constraints:')) {
      currentList = 'constraints';
      continue;
    }

    const item = line.replace(/^-+\s*/, '').trim();
    if (!item || !currentList) {
      continue;
    }

    if (currentList === 'success') {
      successCriteria.push(item);
    } else if (currentList === 'evidence') {
      requiredEvidence.push(item);
    } else {
      constraints.push(item);
    }
  }

  if (!summary && successCriteria.length === 0 && requiredEvidence.length === 0 && constraints.length === 0) {
    return undefined;
  }

  return {
    summary,
    successCriteria: successCriteria.filter(Boolean),
    requiredEvidence: requiredEvidence.filter(Boolean),
    constraints: constraints.filter(Boolean),
  };
}

function parseBudgetExtensionRequest(text: string): KodaXBudgetExtensionRequest | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_BUDGET_REQUEST_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  let requestedIters: KodaXBudgetExtensionRequest['requestedIters'] | undefined;
  let reason = '';
  let completionExpectation = '';
  let confidenceToFinish = 0;
  let fallbackIfDenied = '';

  for (const rawLine of (match[1]?.trim() ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const normalized = line.toLowerCase();
    if (normalized.startsWith('requestediters:') || normalized.startsWith('requested_iters:')) {
      const value = Number(line.split(':').slice(1).join(':').trim());
      if (value === 1 || value === 2 || value === 3) {
        requestedIters = value;
      }
      continue;
    }
    if (normalized.startsWith('reason:')) {
      reason = line.slice('reason:'.length).trim();
      continue;
    }
    if (normalized.startsWith('completionexpectation:') || normalized.startsWith('completion_expectation:')) {
      completionExpectation = line.split(':').slice(1).join(':').trim();
      continue;
    }
    if (normalized.startsWith('confidencetofinish:') || normalized.startsWith('confidence_to_finish:')) {
      confidenceToFinish = clampNumber(Number(line.split(':').slice(1).join(':').trim()), 0, 1);
      continue;
    }
    if (normalized.startsWith('fallbackifdenied:') || normalized.startsWith('fallback_if_denied:')) {
      fallbackIfDenied = line.split(':').slice(1).join(':').trim();
    }
  }

  if (!requestedIters || !reason || !completionExpectation || !fallbackIfDenied) {
    return undefined;
  }

  return {
    requestedIters,
    reason,
    completionExpectation,
    confidenceToFinish,
    fallbackIfDenied,
  };
}

function createVerificationScorecard(
  task: KodaXManagedTask,
  directive: ManagedTaskVerdictDirective | undefined,
): KodaXVerificationScorecard | undefined {
  const verification = task.contract.verification;
  if (!verification) {
    return undefined;
  }

  const criteria = resolveVerificationCriteria(verification, task.contract.primaryTask).map((criterion) => {
    const evidence = [
      ...(criterion.requiredEvidence ?? []),
      ...task.evidence.entries
        .filter((entry) => entry.status === 'completed' && entry.summary)
        .map((entry) => entry.summary!)
        .slice(-2),
    ];
    const verdictScore = directive?.status === 'accept'
      ? 100
      : directive?.status === 'revise'
        ? 45
        : task.verdict.status === 'completed'
          ? 90
          : task.verdict.status === 'blocked'
            ? 35
            : 55;
    const score = clampNumber(verdictScore, 0, 100);
    return {
      id: criterion.id,
      label: criterion.label,
      threshold: criterion.threshold,
      score,
      passed: score >= criterion.threshold,
      weight: criterion.weight,
      requiredEvidence: criterion.requiredEvidence,
      evidence,
      reason: directive?.reason,
    };
  });

  const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weight, 0) || 1;
  const overallScore = clampNumber(
    Math.round(
      criteria.reduce((sum, criterion) => sum + criterion.score * criterion.weight, 0) / totalWeight,
    ),
    0,
    100,
  );
  const verdict = criteria.every((criterion) => criterion.passed)
    ? 'accept'
    : directive?.status === 'blocked' || task.verdict.status === 'blocked'
      ? 'blocked'
      : 'revise';

  return {
    rubricFamily: inferVerificationRubricFamily(verification, task.contract.primaryTask),
    overallScore,
    verdict,
    criteria,
    trend: directive?.status === 'accept' ? 'improving' : directive?.status === 'revise' ? 'flat' : 'regressing',
    summary: directive?.reason ?? task.verdict.summary,
  };
}

function sanitizeManagedWorkerResult(
  result: KodaXResult,
  options?: { enforceVerdictBlock?: boolean },
): { result: KodaXResult; directive?: ManagedTaskVerdictDirective } {
  const text = extractMessageText(result) || result.lastText;
  const directive = parseManagedTaskVerdictDirective(text);
  if (!directive) {
    if (options?.enforceVerdictBlock) {
      const reason = `Evaluator response omitted required ${MANAGED_TASK_VERDICT_BLOCK} block.`;
      return {
        directive: {
          source: 'evaluator',
          status: 'blocked',
          reason,
          followups: [
            `Re-run the evaluator and require a final ${MANAGED_TASK_VERDICT_BLOCK} fenced block with accept, revise, or blocked.`,
          ],
          userFacingText: text,
        },
        result,
      };
    }
    return { result };
  }

  const preferredUserText = directive.userAnswer?.trim() || directive.userFacingText || text;
  const sanitizedText = directive.userAnswer?.trim()
    ? preferredUserText
    : sanitizeEvaluatorPublicAnswer(preferredUserText) || preferredUserText;
  return {
    directive,
    result: {
      ...result,
      lastText: sanitizedText,
      messages: replaceLastAssistantMessage(result.messages, sanitizedText),
    },
  };
}

function sanitizeContractResult(
  result: KodaXResult,
): { result: KodaXResult; directive?: ManagedTaskContractDirective } {
  const text = extractMessageText(result) || result.lastText;
  const directive = parseManagedTaskContractDirective(text);
  if (!directive) {
    return { result };
  }

  const sanitizedText = directive.summary || sanitizeManagedUserFacingText(text) || text;
  return {
    directive,
    result: {
      ...result,
      lastText: sanitizedText,
      messages: replaceLastAssistantMessage(result.messages, sanitizedText),
    },
  };
}

function sanitizeScoutResult(
  result: KodaXResult,
): { result: KodaXResult; directive?: ManagedTaskScoutDirective } {
  const text = extractMessageText(result) || result.lastText;
  const directive = parseManagedTaskScoutDirective(text);
  if (!directive) {
    const reason = `Scout response omitted required ${MANAGED_TASK_SCOUT_BLOCK} block.`;
    return {
      directive: undefined,
      result: {
        ...result,
        success: false,
        signal: 'BLOCKED',
        signalReason: reason,
      },
    };
  }

  return {
    directive,
    result: {
      ...result,
      lastText: directive.userFacingText || directive.summary || text,
      messages: replaceLastAssistantMessage(result.messages, directive.userFacingText || directive.summary || text),
    },
  };
}

function sanitizeHandoffResult(
  result: KodaXResult,
  roleTitle: string,
): { result: KodaXResult; directive?: ManagedTaskHandoffDirective } {
  const text = extractMessageText(result) || result.lastText;
  const directive = parseManagedTaskHandoffDirective(text);
  if (!directive) {
    const reason = `${roleTitle} response omitted required ${MANAGED_TASK_HANDOFF_BLOCK} block.`;
    return {
      directive: undefined,
      result: {
        ...result,
        success: false,
        signal: 'BLOCKED',
        signalReason: reason,
      },
    };
  }

  const sanitizedText = directive.userFacingText || directive.summary || text;
  const signal = directive.status === 'blocked' ? 'BLOCKED' : result.signal;
  const signalReason = directive.status === 'blocked'
    ? directive.summary || result.signalReason || `${roleTitle} reported a blocked handoff.`
    : directive.status === 'incomplete'
      ? directive.summary || result.signalReason || `${roleTitle} reported an incomplete handoff.`
      : result.signalReason;
  return {
    directive,
    result: {
      ...result,
      success: directive.status === 'ready',
      lastText: sanitizedText,
      messages: replaceLastAssistantMessage(result.messages, sanitizedText),
      signal,
      signalReason,
    },
  };
}

function buildManagedRoundPrompt(
  prompt: string,
  round: number,
  feedback?: ManagedTaskVerdictDirective,
): string {
  if (!feedback) {
    return prompt;
  }

  const sections = [
    prompt,
    `${feedback.source === 'worker' ? 'Worker' : 'Evaluator'} feedback after round ${round - 1}:`,
    feedback.artifactPath
      ? `Previous round feedback artifact: ${feedback.artifactPath}`
      : undefined,
    feedback.reason ? `Reason: ${feedback.reason}` : undefined,
    feedback.nextHarness ? `Requested next harness: ${feedback.nextHarness}` : undefined,
    feedback.followups.length > 0
      ? ['Required follow-up:', ...feedback.followups.map((item) => `- ${item}`)].join('\n')
      : undefined,
    feedback.userFacingText
      ? `Prior findings preview:\n${truncateText(feedback.userFacingText, 1200)}`
      : undefined,
  ].filter((section): section is string => Boolean(section && section.trim()));

  return sections.join('\n\n');
}

function shouldReplanManagedRound(
  directive: ManagedTaskVerdictDirective | undefined,
): boolean {
  if (!directive || directive.source !== 'worker') {
    return false;
  }

  const combined = [
    directive.reason,
    directive.userFacingText,
    ...directive.followups,
  ]
    .filter((item): item is string => Boolean(item))
    .join('\n')
    .toLowerCase();

  return combined.includes('planner') || combined.includes('contract');
}

async function persistManagedTaskDirectiveArtifact(
  workspaceDir: string,
  directive: ManagedTaskVerdictDirective,
): Promise<ManagedTaskVerdictDirective> {
  const artifactPath = path.join(workspaceDir, 'feedback.json');
  const markdownPath = path.join(workspaceDir, 'feedback.md');
  await writeFile(
    artifactPath,
    `${JSON.stringify({
      source: directive.source,
      status: directive.status,
      reason: directive.reason ?? null,
      nextHarness: directive.nextHarness ?? null,
      followups: directive.followups,
      userFacingText: directive.userFacingText,
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    markdownPath,
    [
      `# ${directive.source === 'worker' ? 'Worker Handoff' : 'Evaluator'} Feedback`,
      '',
      `- Status: ${directive.status}`,
      directive.reason ? `- Reason: ${directive.reason}` : undefined,
      directive.nextHarness ? `- Requested harness: ${directive.nextHarness}` : undefined,
      directive.followups.length > 0
        ? ['- Follow-up:', ...directive.followups.map((item) => `  - ${item}`)].join('\n')
        : undefined,
      directive.userFacingText
        ? ['', '## Visible Feedback', '', directive.userFacingText].join('\n')
        : undefined,
    ].filter((line): line is string => Boolean(line)).join('\n') + '\n',
    'utf8',
  );
  return {
    ...directive,
    artifactPath,
  };
}

function createWorkerEvents(
  baseEvents: KodaXEvents | undefined,
  worker: ManagedTaskWorkerSpec,
  forwardStream: boolean,
  controller?: ManagedTaskBudgetController,
): KodaXEvents | undefined {
  if (!baseEvents && !worker.beforeToolExecute && !controller) {
    return undefined;
  }

  let textPrefixed = false;
  let thinkingPrefixed = false;
  const prefix = `[${worker.title}] `;
  const thinkingPrefix = `[${worker.title} thinking] `;

  return {
    askUser: baseEvents?.askUser,
    beforeToolExecute: async (tool, input) => {
      const workerDecision = await worker.beforeToolExecute?.(tool, input);
      if (workerDecision !== undefined && workerDecision !== true) {
        return workerDecision;
      }
      const baseDecision = await baseEvents?.beforeToolExecute?.(tool, input);
      return baseDecision ?? true;
    },
    onIterationStart: (iter, maxIter) => {
      if (controller) {
        incrementManagedBudgetUsage(controller);
      }
      baseEvents?.onIterationStart?.(iter, maxIter);
    },
    onIterationEnd: (info) => {
      baseEvents?.onIterationEnd?.(info);
    },
    onTextDelta: (text) => {
      if (!text) {
        return;
      }
      const rendered = forwardStream
        ? text
        : textPrefixed ? text : `${prefix}${text}`;
      textPrefixed = !forwardStream;
      baseEvents?.onTextDelta?.(rendered);
    },
    onThinkingDelta: (text) => {
      if (!text) {
        return;
      }
      const rendered = forwardStream
        ? text
        : thinkingPrefixed ? text : `${thinkingPrefix}${text}`;
      thinkingPrefixed = !forwardStream;
      baseEvents?.onThinkingDelta?.(rendered);
    },
    onThinkingEnd: (thinking) => {
      baseEvents?.onThinkingEnd?.(forwardStream ? thinking : `${prefix}${thinking}`);
      thinkingPrefixed = false;
    },
    onToolUseStart: (tool) => {
      baseEvents?.onToolUseStart?.({
        ...tool,
        name: forwardStream ? tool.name : `${worker.title}:${tool.name}`,
      });
    },
    onToolResult: (result) => {
      baseEvents?.onToolResult?.({
        ...result,
        name: forwardStream ? result.name : `${worker.title}:${result.name}`,
      });
    },
    onToolInputDelta: (toolName, partialJson, meta) => {
      baseEvents?.onToolInputDelta?.(
        forwardStream ? toolName : `${worker.title}:${toolName}`,
        partialJson,
        meta,
      );
    },
    onRetry: baseEvents?.onRetry,
    onProviderRateLimit: baseEvents?.onProviderRateLimit,
    onError: baseEvents?.onError,
    onStreamEnd: () => {
      if (textPrefixed) {
        baseEvents?.onTextDelta?.('\n');
      }
      if (thinkingPrefixed) {
        baseEvents?.onThinkingDelta?.('\n');
      }
      textPrefixed = false;
      thinkingPrefixed = false;
    },
  };
}

function buildManagedWorkerSessionId(
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
): string {
  return `managed-task-worker-${task.contract.taskId}-${worker.id}`;
}

function createWorkerSession(
  session: KodaXOptions['session'],
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  storage: KodaXSessionStorage | undefined,
  memoryStrategy: KodaXMemoryStrategy,
  compactInitialMessages?: KodaXSessionData['messages'],
): KodaXOptions['session'] {
  const shouldResume = memoryStrategy === 'continuous';
  const initialMessages = memoryStrategy === 'compact'
    ? compactInitialMessages
    : session?.initialMessages?.length
      ? [...session.initialMessages]
      : undefined;
  if (!session) {
    return {
      id: buildManagedWorkerSessionId(task, worker),
      scope: 'managed-task-worker',
      resume: shouldResume,
      autoResume: shouldResume,
      storage,
      initialMessages,
    };
  }
  return {
    ...session,
    id: buildManagedWorkerSessionId(task, worker),
    scope: 'managed-task-worker',
    resume: shouldResume,
    autoResume: shouldResume,
    storage,
    initialMessages,
  };
}

function mergeEvidenceArtifacts(
  ...artifactSets: Array<readonly KodaXTaskEvidenceArtifact[] | undefined>
): KodaXTaskEvidenceArtifact[] {
  const merged = new Map<string, KodaXTaskEvidenceArtifact>();
  for (const artifactSet of artifactSets) {
    for (const artifact of artifactSet ?? []) {
      merged.set(path.resolve(artifact.path), artifact);
    }
  }
  return Array.from(merged.values());
}

function resolveManagedTaskRepoIntelligenceContext(
  options: KodaXOptions,
): ManagedTaskRepoIntelligenceContext {
  return {
    executionCwd: options.context?.executionCwd?.trim() || undefined,
    gitRoot: options.context?.gitRoot?.trim() || undefined,
    repoIntelligenceMode: options.context?.repoIntelligenceMode,
  };
}

async function captureManagedTaskRepoIntelligence(
  context: ManagedTaskRepoIntelligenceContext,
  workspaceDir: string,
  options?: KodaXOptions,
): Promise<ManagedTaskRepoIntelligenceSnapshot> {
  const executionCwd = context.executionCwd;
  const gitRoot = context.gitRoot;
  if (!executionCwd && !gitRoot) {
    return { artifacts: [] };
  }

  const repoContext = {
    executionCwd: executionCwd ?? gitRoot ?? process.cwd(),
    gitRoot: gitRoot ?? undefined,
  };
  const autoRepoMode = resolveKodaXAutoRepoMode(context.repoIntelligenceMode);
  if (autoRepoMode === 'off') {
    return { artifacts: [] };
  }
  const repoSnapshotDir = path.join(workspaceDir, 'repo-intelligence');
  await mkdir(repoSnapshotDir, { recursive: true });

  const artifacts: KodaXTaskEvidenceArtifact[] = [];
  const summarySections: string[] = [];

  const activeModuleTargetPath = executionCwd ? '.' : undefined;
  let preturnBundle: Awaited<ReturnType<typeof getRepoPreturnBundle>> | null = null;

  try {
    const overview = await getRepoOverview(repoContext, { refresh: false });
    const overviewPath = path.join(repoSnapshotDir, 'repo-overview.json');
    await writeFile(overviewPath, `${JSON.stringify(overview, null, 2)}\n`, 'utf8');
    artifacts.push({
      kind: 'json',
      path: overviewPath,
      description: 'Task-scoped repository overview snapshot',
    });
    summarySections.push('## Repository Overview', renderRepoOverview(overview));
  } catch (error) {
    debugLogRepoIntelligence('Skipping task-scoped repo overview snapshot.', error);
  }

  try {
    const changedScope = await analyzeChangedScope(repoContext, {
      scope: 'all',
      refreshOverview: false,
    });
    const changedScopePath = path.join(repoSnapshotDir, 'changed-scope.json');
    await writeFile(changedScopePath, `${JSON.stringify(changedScope, null, 2)}\n`, 'utf8');
    artifacts.push({
      kind: 'json',
      path: changedScopePath,
      description: 'Task-scoped changed-scope snapshot',
    });
    summarySections.push('## Changed Scope', renderChangedScope(changedScope));
  } catch (error) {
    debugLogRepoIntelligence('Skipping task-scoped changed-scope snapshot.', error);
  }

  if (activeModuleTargetPath) {
    if (autoRepoMode === 'premium-native') {
      preturnBundle = await getRepoPreturnBundle(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: false,
        mode: autoRepoMode,
      }).catch(() => null);
      if (preturnBundle && options) {
        emitManagedRepoIntelligenceTrace(
          options.events,
          options,
          'preturn',
          preturnBundle,
          preturnBundle.summary,
        );
      }
    }

    try {
      const moduleContext = preturnBundle?.moduleContext ?? await getModuleContext(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: false,
        mode: autoRepoMode,
      });
      if (options) {
        const moduleId = (moduleContext as { module?: { moduleId?: string } })?.module?.moduleId
          ?? activeModuleTargetPath;
        emitManagedRepoIntelligenceTrace(
          options.events,
          options,
          'module',
          moduleContext,
          `module=${moduleId}`,
        );
      }
      const moduleContextPath = path.join(repoSnapshotDir, 'active-module.json');
      await writeFile(moduleContextPath, `${JSON.stringify(moduleContext, null, 2)}\n`, 'utf8');
      artifacts.push({
        kind: 'json',
        path: moduleContextPath,
        description: 'Task-scoped active module capsule',
      });
      summarySections.push('## Active Module', renderModuleContext(moduleContext));
    } catch (error) {
      debugLogRepoIntelligence('Skipping task-scoped active-module snapshot.', error);
    }

    try {
      const impactEstimate = preturnBundle?.impactEstimate ?? await getImpactEstimate(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: false,
        mode: autoRepoMode,
      });
      if (options) {
        const impactTarget = (impactEstimate as { target?: { label?: string } })?.target?.label
          ?? activeModuleTargetPath;
        emitManagedRepoIntelligenceTrace(
          options.events,
          options,
          'impact',
          impactEstimate,
          `target=${impactTarget}`,
        );
      }
      const impactEstimatePath = path.join(repoSnapshotDir, 'impact-estimate.json');
      await writeFile(impactEstimatePath, `${JSON.stringify(impactEstimate, null, 2)}\n`, 'utf8');
      artifacts.push({
        kind: 'json',
        path: impactEstimatePath,
        description: 'Task-scoped impact estimate capsule',
      });
      summarySections.push('## Impact Estimate', renderImpactEstimate(impactEstimate));
    } catch (error) {
      debugLogRepoIntelligence('Skipping task-scoped impact snapshot.', error);
    }
  }

  if (summarySections.length > 0) {
    const summaryPath = path.join(repoSnapshotDir, 'summary.md');
    await writeFile(summaryPath, `${summarySections.join('\n\n')}\n`, 'utf8');
    if (options) {
      emitManagedRepoIntelligenceTrace(
        options.events,
        options,
        'task-snapshot',
        preturnBundle?.moduleContext ?? preturnBundle?.impactEstimate ?? null,
        `workspace_dir=${repoSnapshotDir}`,
      );
    }
    artifacts.unshift({
      kind: 'markdown',
      path: summaryPath,
      description: 'Task-scoped repository intelligence summary',
    });
  }

  return { artifacts };
}

function scheduleManagedTaskRepoIntelligenceCapture(
  context: ManagedTaskRepoIntelligenceContext,
  workspaceDir: string,
  options?: KodaXOptions,
): void {
  queueMicrotask(() => {
    void captureManagedTaskRepoIntelligence(context, workspaceDir, options).catch((error) => {
      debugLogRepoIntelligence('Background task-scoped repo intelligence capture failed.', error);
    });
  });
}

async function attachManagedTaskRepoIntelligence(
  options: KodaXOptions,
  task: KodaXManagedTask,
): Promise<KodaXManagedTask> {
  const snapshot = await captureManagedTaskRepoIntelligence(
    resolveManagedTaskRepoIntelligenceContext(options),
    task.evidence.workspaceDir,
    options,
  );
  if (snapshot.artifacts.length === 0) {
    return task;
  }

  return {
    ...task,
    evidence: {
      ...task.evidence,
      artifacts: mergeEvidenceArtifacts(task.evidence.artifacts, snapshot.artifacts),
    },
  };
}

function buildManagedTaskArtifactRecords(workspaceDir: string): KodaXTaskEvidenceArtifact[] {
  return [
    {
      kind: 'json',
      path: path.join(workspaceDir, 'contract.json'),
      description: 'Managed task contract snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'managed-task.json'),
      description: 'Managed task contract and evidence snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'result.json'),
      description: 'Managed task final result snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'round-history.json'),
      description: 'Managed task round history ledger',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'budget.json'),
      description: 'Managed task budget snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'memory-strategy.json'),
      description: 'Managed task memory strategy snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'runtime-contract.json'),
      description: 'Managed task runtime-under-test contract',
    },
    {
      kind: 'markdown',
      path: path.join(workspaceDir, 'runtime-execution.md'),
      description: 'Managed task runtime execution guide',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'scorecard.json'),
      description: 'Managed task verification scorecard',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'continuation.json'),
      description: 'Managed task continuation checkpoint',
    },
  ];
}

async function writeManagedSkillArtifacts(
  workspaceDir: string,
  skillInvocation: KodaXSkillInvocationContext | undefined,
  skillMap: KodaXSkillMap | undefined,
): Promise<KodaXTaskEvidenceArtifact[]> {
  if (!skillInvocation) {
    return [];
  }

  const { rawSkillPath, skillMapJsonPath, skillMapMarkdownPath } = getManagedSkillArtifactPaths(workspaceDir);
  const artifacts: KodaXTaskEvidenceArtifact[] = [];

  await writeFile(
    rawSkillPath,
    `${skillInvocation.expandedContent.trim()}\n`,
    'utf8',
  );
  artifacts.push({
    kind: 'markdown',
    path: rawSkillPath,
    description: 'Expanded skill content used as the authoritative execution reference',
  });

  if (skillMap) {
    await writeFile(
      skillMapJsonPath,
      `${JSON.stringify(skillMap, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      skillMapMarkdownPath,
      [
        `# Skill Map: ${skillInvocation.name}`,
        '',
        `- Summary: ${skillMap.skillSummary}`,
        `- Projection confidence: ${skillMap.projectionConfidence}`,
        skillMap.allowedTools ? `- Allowed tools: ${skillMap.allowedTools}` : undefined,
        skillMap.preferredAgent ? `- Preferred agent: ${skillMap.preferredAgent}` : undefined,
        skillMap.preferredModel ? `- Preferred model: ${skillMap.preferredModel}` : undefined,
        skillMap.invocationContext ? `- Invocation context: ${skillMap.invocationContext}` : undefined,
        skillMap.hookEvents?.length ? `- Hook events: ${skillMap.hookEvents.join(', ')}` : undefined,
        formatOptionalListSection('## Execution obligations', skillMap.executionObligations),
        formatOptionalListSection('## Verification obligations', skillMap.verificationObligations),
        formatOptionalListSection('## Required evidence', skillMap.requiredEvidence),
        formatOptionalListSection('## Ambiguities', skillMap.ambiguities),
      ].filter((line): line is string => Boolean(line)).join('\n') + '\n',
      'utf8',
    );
    artifacts.push(
      {
        kind: 'json',
        path: skillMapJsonPath,
        description: 'Scout-generated skill map used by managed-task roles',
      },
      {
        kind: 'markdown',
        path: skillMapMarkdownPath,
        description: 'Readable skill map summary for managed-task roles',
      },
    );
  }

  return artifacts;
}

function buildManagedTaskRoundHistory(task: KodaXManagedTask): Array<{
  round: number;
  entries: Array<{
    assignmentId: string;
    title?: string;
    role: KodaXTaskRole;
    status: KodaXTaskStatus;
    summary?: string;
    sessionId?: string;
    signal?: KodaXTaskEvidenceEntry['signal'];
    signalReason?: string;
  }>;
}> {
  const rounds = new Map<number, Array<{
    assignmentId: string;
    title?: string;
    role: KodaXTaskRole;
    status: KodaXTaskStatus;
    summary?: string;
    sessionId?: string;
    signal?: KodaXTaskEvidenceEntry['signal'];
    signalReason?: string;
  }>>();

  for (const entry of task.evidence.entries) {
    const round = entry.round ?? 1;
    const roundEntries = rounds.get(round) ?? [];
    roundEntries.push({
      assignmentId: entry.assignmentId,
      title: entry.title,
      role: entry.role,
      status: entry.status,
      summary: entry.summary,
      sessionId: entry.sessionId,
      signal: entry.signal,
      signalReason: entry.signalReason,
    });
    rounds.set(round, roundEntries);
  }

  return Array.from(rounds.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([round, entries]) => ({
      round,
      entries,
    }));
}

function buildWorkerRunOptions(
  defaultOptions: KodaXOptions,
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  terminalWorkerId: string,
  routingPromptOverlay: string | undefined,
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode,
  sessionStorage: KodaXSessionStorage | undefined,
  memoryStrategy: KodaXMemoryStrategy,
  budgetSnapshot: KodaXManagedBudgetSnapshot | undefined,
  controller: ManagedTaskBudgetController,
): KodaXOptions {
  worker.memoryStrategy = memoryStrategy;
  worker.budgetSnapshot = budgetSnapshot;
  const compactInitialMessages = memoryStrategy === 'compact' && sessionStorage instanceof ManagedWorkerSessionStorage
    ? buildCompactInitialMessages(task, worker, sessionStorage, budgetSnapshot?.currentRound ?? 1)
    : undefined;
  const roleEvents = createWorkerEvents(defaultOptions.events, worker, worker.id === terminalWorkerId, controller);
  return {
    ...defaultOptions,
    maxIter: resolveRemainingManagedWorkBudget(controller),
    session: createWorkerSession(defaultOptions.session, task, worker, sessionStorage, memoryStrategy, compactInitialMessages),
    context: {
      ...defaultOptions.context,
      taskSurface: task.contract.surface,
      managedTaskWorkspaceDir: task.evidence.workspaceDir,
      taskMetadata: task.contract.metadata,
      taskVerification: task.contract.verification,
      providerPolicyHints: {
        ...defaultOptions.context?.providerPolicyHints,
        ...buildProviderPolicyHintsForDecision({
          primaryTask: task.contract.primaryTask,
          confidence: 1,
          riskLevel: task.contract.riskLevel,
          recommendedMode: task.contract.recommendedMode,
          recommendedThinkingDepth: 'medium',
          complexity: task.contract.complexity,
          workIntent: task.contract.workIntent,
          requiresBrainstorm: task.contract.requiresBrainstorm,
          harnessProfile: task.contract.harnessProfile,
          reason: task.contract.reason,
          routingNotes: task.evidence.routingNotes,
        }),
      },
      disableAutoTaskReroute: true,
      promptOverlay: [
        routingPromptOverlay,
        defaultOptions.context?.promptOverlay,
        formatManagedPromptOverlay(task, worker, terminalWorkerId, qualityAssuranceMode),
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    events: roleEvents
      ? {
          ...defaultOptions.events,
          ...roleEvents,
        }
      : defaultOptions.events,
  };
}

async function runManagedScoutStage(
  options: KodaXOptions,
  prompt: string,
  plan: ReasoningPlan,
  controller: ManagedTaskBudgetController,
): Promise<{ result: KodaXResult; directive: ManagedTaskScoutDirective }> {
  const toolPolicy = buildManagedWorkerToolPolicy(
    'scout',
    options.context?.taskVerification,
    plan.decision.harnessProfile,
    undefined,
    options.context?.repoIntelligenceMode,
  );
  const agent = buildManagedWorkerAgent('scout', 'scout');
  const originalTask = resolveManagedOriginalTask(options.context, prompt);
  const basePrompt = createRolePrompt(
    'scout',
    prompt,
    plan.decision,
    options.context?.taskVerification,
    toolPolicy,
    agent,
    options.context?.taskMetadata,
    {
      originalTask,
      skillInvocation: options.context?.skillInvocation,
    },
    'scout',
  );
  const scoutWorker: ManagedTaskWorkerSpec = {
    id: 'scout',
    title: 'Scout',
    role: 'scout',
    terminalAuthority: false,
    execution: 'serial',
    agent,
    prompt: basePrompt,
    toolPolicy,
  };
  scoutWorker.beforeToolExecute = createToolPolicyHook(scoutWorker);
  const scoutEvents = createWorkerEvents(options.events, scoutWorker, true, controller);
  const scoutOptions: KodaXOptions = {
    ...options,
    maxIter: resolveRemainingManagedWorkBudget(controller),
    events: scoutEvents
      ? {
          ...options.events,
          ...scoutEvents,
        }
      : options.events,
    context: {
      ...options.context,
      promptOverlay: [
        options.context?.promptOverlay,
        plan.promptOverlay,
        '[Scout Phase] Prefer direct completion when the task can be safely answered without a heavier harness.',
      ].filter(Boolean).join('\n\n'),
    },
  };

  let currentPrompt = basePrompt;
  let lastResult: KodaXResult | undefined;
  for (let attempt = 1; attempt <= MANAGED_TASK_ROUTER_MAX_RETRIES; attempt += 1) {
    const result = await runDirectKodaX(scoutOptions, currentPrompt);
    lastResult = result;
    const sanitized = sanitizeScoutResult(result);
    if (sanitized.directive) {
      return { result: sanitized.result, directive: sanitized.directive };
    }
    if (attempt < MANAGED_TASK_ROUTER_MAX_RETRIES) {
      currentPrompt = buildProtocolRetryPrompt(
        basePrompt,
        {
          id: 'scout',
          title: 'Scout',
          role: 'scout',
          terminalAuthority: false,
          execution: 'serial',
          agent,
          prompt: basePrompt,
          toolPolicy,
        },
        `missing ${MANAGED_TASK_SCOUT_BLOCK}`,
        buildProtocolRetryRoleSummary(
          scoutWorker,
          sanitized.result,
          attempt,
          `missing ${MANAGED_TASK_SCOUT_BLOCK}`,
        ),
      );
    }
  }

  return {
    result: lastResult!,
    directive: {
      summary: truncateText(extractMessageText(lastResult) || plan.decision.reason || 'Scout completed without a structured summary.'),
      scope: [],
      requiredEvidence: [],
      reviewFilesOrAreas: [],
      evidenceAcquisitionMode: 'overview',
      confirmedHarness: plan.decision.harnessProfile,
      userFacingText: sanitizeManagedUserFacingText(extractMessageText(lastResult) || ''),
    },
  };
}

function applyDirectResultToTask(task: KodaXManagedTask, result: KodaXResult): KodaXManagedTask {
  const status: KodaXTaskStatus = result.success ? 'completed' : (result.signal === 'BLOCKED' ? 'blocked' : 'failed');
  const summary = truncateText(extractMessageText(result) || result.signalReason || 'Task finished without a textual summary.');
  const nextTask: KodaXManagedTask = {
    ...task,
    contract: {
      ...task.contract,
      status,
      updatedAt: new Date().toISOString(),
    },
    roleAssignments: task.roleAssignments.map((assignment) => ({
      ...assignment,
      status,
      summary,
      sessionId: result.sessionId,
    })),
    evidence: {
      ...task.evidence,
      artifacts: mergeEvidenceArtifacts(
        task.evidence.artifacts,
        buildManagedTaskArtifactRecords(task.evidence.workspaceDir),
      ),
      entries: [
        {
          assignmentId: 'direct',
          title: 'Direct Agent',
          role: 'direct',
          round: 1,
          status,
          summary,
          output: extractMessageText(result),
          sessionId: result.sessionId,
          signal: result.signal,
          signalReason: result.signalReason,
        },
      ],
    },
    verdict: {
      status,
      decidedByAssignmentId: 'direct',
      summary,
      signal: result.signal,
      signalReason: result.signalReason,
      disposition: status === 'completed' ? 'complete' : 'blocked',
      continuationSuggested: status !== 'completed',
    },
  };
  return {
    ...nextTask,
    runtime: {
      ...nextTask.runtime,
      scorecard: createVerificationScorecard(nextTask, undefined),
    },
  };
}

function applyScoutTerminalResultToTask(
  task: KodaXManagedTask,
  result: KodaXResult,
  directive: ManagedTaskScoutDirective,
): KodaXManagedTask {
  const status: KodaXTaskStatus = result.success ? 'completed' : (result.signal === 'BLOCKED' ? 'blocked' : 'failed');
  const output = directive.userFacingText || extractMessageText(result) || result.lastText || '';
  const summary = truncateText(
    directive.summary
    || output
    || result.signalReason
    || 'Scout completed without a textual summary.',
  );

  return {
    ...task,
    contract: {
      ...task.contract,
      status,
      updatedAt: new Date().toISOString(),
    },
    roleAssignments: task.roleAssignments.map((assignment) => ({
      ...assignment,
      status,
      summary,
      sessionId: result.sessionId,
    })),
    evidence: {
      ...task.evidence,
      artifacts: mergeEvidenceArtifacts(
        task.evidence.artifacts,
        buildManagedTaskArtifactRecords(task.evidence.workspaceDir),
      ),
      entries: [
        ...task.evidence.entries,
        {
          assignmentId: 'scout',
          title: 'Scout',
          role: 'scout',
          round: 1,
          status,
          summary,
          output: output || undefined,
          sessionId: result.sessionId,
          signal: result.signal,
          signalReason: result.signalReason,
        },
      ],
    },
    verdict: {
      status,
      decidedByAssignmentId: 'scout',
      summary,
      signal: result.signal,
      signalReason: result.signalReason,
      disposition: status === 'completed'
        ? 'complete'
        : status === 'blocked'
          ? 'blocked'
          : 'needs_continuation',
      continuationSuggested: status !== 'completed',
    },
  };
}

function applyOrchestrationResultToTask(
  task: KodaXManagedTask,
  terminalWorkerId: string,
  orchestrationResult: OrchestrationRunResult<ManagedTaskWorkerSpec, string>,
  workerResults: Map<string, KodaXResult>,
  round: number,
  roundWorkspaceDir: string,
): KodaXManagedTask {
  const newEntries: KodaXTaskEvidenceEntry[] = [];

  for (const completed of orchestrationResult.tasks) {
    const result = workerResults.get(completed.id);
    newEntries.push({
      assignmentId: completed.id,
      title: completed.title,
      role: task.roleAssignments.find((item) => item.id === completed.id)?.role ?? 'direct',
      round,
      status: completed.status === 'completed'
        ? 'completed'
        : completed.status === 'blocked'
          ? 'blocked'
          : 'failed',
      summary: completed.result.summary ?? completed.result.error,
      output: typeof completed.result.output === 'string'
        ? completed.result.output
        : extractMessageText(result),
      sessionId: typeof completed.result.metadata?.sessionId === 'string'
        ? completed.result.metadata.sessionId
        : result?.sessionId,
      signal: typeof completed.result.metadata?.signal === 'string'
        ? completed.result.metadata.signal as KodaXResult['signal']
        : result?.signal,
      signalReason: typeof completed.result.metadata?.signalReason === 'string'
        ? completed.result.metadata.signalReason
        : result?.signalReason,
    });
  }

  const allEntries = [...task.evidence.entries, ...newEntries];
  const latestEntryById = new Map<string, KodaXTaskEvidenceEntry>();
  for (const entry of allEntries) {
    const previous = latestEntryById.get(entry.assignmentId);
    if (!previous || (entry.round ?? 0) >= (previous.round ?? 0)) {
      latestEntryById.set(entry.assignmentId, entry);
    }
  }

  const terminalResult = workerResults.get(terminalWorkerId);
  const terminalCompleted = orchestrationResult.taskResults[terminalWorkerId];
  const fallbackCompleted = [...orchestrationResult.tasks].reverse().find((item) => item.status !== 'blocked');
  const fallbackResult = fallbackCompleted ? workerResults.get(fallbackCompleted.id) : undefined;
  const terminalSignal = typeof terminalCompleted?.result.metadata?.signal === 'string'
    ? terminalCompleted.result.metadata.signal
    : terminalResult?.signal;
  const fallbackSignal = typeof fallbackCompleted?.result.metadata?.signal === 'string'
    ? fallbackCompleted.result.metadata.signal
    : fallbackResult?.signal;
  const hasBlockedSignal = orchestrationResult.tasks.some(
    (item) => item.result.metadata?.signal === 'BLOCKED'
  );
  let status: KodaXTaskStatus;
  if (terminalCompleted?.status === 'completed') {
    status = terminalSignal === 'BLOCKED' ? 'blocked' : 'completed';
  } else if (terminalCompleted?.status === 'blocked') {
    status = 'blocked';
  } else if (terminalSignal === 'BLOCKED' || fallbackSignal === 'BLOCKED' || hasBlockedSignal) {
    status = 'blocked';
  } else if (orchestrationResult.summary.failed > 0) {
    status = 'failed';
  } else if (orchestrationResult.summary.blocked > 0) {
    status = 'blocked';
  } else {
    status = 'completed';
  }

  const summary = truncateText(
    extractMessageText(terminalResult)
    || terminalCompleted?.result.summary
    || extractMessageText(fallbackResult)
    || fallbackCompleted?.result.summary
    || 'Managed task finished without a textual summary.',
  );

  const artifacts: KodaXTaskEvidenceArtifact[] = [
    ...buildManagedTaskArtifactRecords(task.evidence.workspaceDir),
    {
      kind: 'json',
      path: path.join(roundWorkspaceDir, 'run.json'),
      description: `Managed task orchestration manifest for round ${round}`,
    },
    {
      kind: 'json',
      path: path.join(roundWorkspaceDir, 'summary.json'),
      description: `Managed task orchestration summary for round ${round}`,
    },
    {
      kind: 'text',
      path: path.join(roundWorkspaceDir, 'trace.ndjson'),
      description: `Managed task orchestration trace for round ${round}`,
    },
  ];

  return {
    ...task,
    contract: {
      ...task.contract,
      status,
      updatedAt: new Date().toISOString(),
    },
    roleAssignments: task.roleAssignments.map((assignment) => {
      const evidence = latestEntryById.get(assignment.id);
      return evidence
        ? {
            ...assignment,
            status: evidence.status,
            summary: evidence.summary,
            sessionId: evidence.sessionId,
          }
        : assignment;
    }),
    evidence: {
      ...task.evidence,
      runId: orchestrationResult.runId,
      artifacts: mergeEvidenceArtifacts(task.evidence.artifacts, artifacts),
      entries: allEntries,
    },
    verdict: {
      status,
      decidedByAssignmentId: terminalWorkerId,
      summary,
      signal: (terminalSignal as KodaXResult['signal'] | undefined)
        ?? (fallbackSignal as KodaXResult['signal'] | undefined),
      signalReason: typeof terminalCompleted?.result.metadata?.signalReason === 'string'
        ? terminalCompleted.result.metadata.signalReason
        : terminalResult?.signalReason ?? (
          typeof fallbackCompleted?.result.metadata?.signalReason === 'string'
            ? fallbackCompleted.result.metadata.signalReason
            : fallbackResult?.signalReason
        ),
      disposition: status === 'completed' ? 'complete' : 'blocked',
      continuationSuggested: status !== 'completed',
    },
  };
}

function mergeManagedTaskIntoResult(result: KodaXResult, task: KodaXManagedTask): KodaXResult {
  return {
    ...result,
    managedTask: task,
  };
}

async function writeManagedTaskSnapshotArtifacts(
  workspaceDir: string,
  task: KodaXManagedTask,
): Promise<void> {
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, 'contract.json'),
    `${JSON.stringify(task.contract, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'managed-task.json'),
    `${JSON.stringify(task, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'round-history.json'),
    `${JSON.stringify(buildManagedTaskRoundHistory(task), null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'budget.json'),
    `${JSON.stringify(task.runtime?.budget ?? null, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'memory-strategy.json'),
    `${JSON.stringify({
      strategies: task.runtime?.memoryStrategies ?? {},
      notes: task.runtime?.memoryNotes ?? {},
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'runtime-contract.json'),
    `${JSON.stringify(task.contract.verification?.runtime ?? null, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'runtime-execution.md'),
    buildRuntimeExecutionGuide(task.contract.verification) ?? 'No explicit runtime-under-test contract.\n',
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'scorecard.json'),
    `${JSON.stringify(task.runtime?.scorecard ?? null, null, 2)}\n`,
    'utf8',
  );
}

async function writeManagedTaskArtifacts(
  workspaceDir: string,
  task: KodaXManagedTask,
  result: Pick<KodaXResult, 'success' | 'lastText' | 'sessionId' | 'signal' | 'signalReason'>,
  directive?: ManagedTaskVerdictDirective,
): Promise<void> {
  await writeManagedTaskSnapshotArtifacts(workspaceDir, task);
  const continuationSuggested = Boolean(
    directive?.status === 'revise'
    || task.verdict.disposition === 'needs_continuation'
    || (task.verdict.status === 'blocked' && task.verdict.signal === 'BLOCKED')
  );
  const nextRound = (buildManagedTaskRoundHistory(task).at(-1)?.round ?? 0) + 1;
  const latestFeedbackArtifact = directive?.artifactPath
    ?? task.evidence.artifacts
      .filter((artifact) => artifact.path.endsWith(`${path.sep}feedback.json`) || artifact.path.endsWith('/feedback.json'))
      .at(-1)?.path;
  await writeFile(
    path.join(workspaceDir, 'continuation.json'),
    `${JSON.stringify({
      continuationSuggested,
      taskId: task.contract.taskId,
      status: task.contract.status,
      nextRound,
      signal: task.verdict.signal ?? null,
      signalReason: task.verdict.signalReason ?? null,
      disposition: task.verdict.disposition ?? null,
      latestFeedbackArtifact: latestFeedbackArtifact ?? null,
      roundHistoryPath: path.join(workspaceDir, 'round-history.json'),
      contractPath: path.join(workspaceDir, 'contract.json'),
      managedTaskPath: path.join(workspaceDir, 'managed-task.json'),
      scorecardPath: path.join(workspaceDir, 'scorecard.json'),
      runtimeContractPath: path.join(workspaceDir, 'runtime-contract.json'),
      runtimeExecutionGuidePath: path.join(workspaceDir, 'runtime-execution.md'),
      budgetPath: path.join(workspaceDir, 'budget.json'),
      harnessTransitions: task.runtime?.harnessTransitions ?? [],
      suggestedPrompt: continuationSuggested && directive
        ? buildManagedRoundPrompt(task.contract.objective, nextRound, directive)
        : null,
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
}

function applyDegradedContinueNote(task: KodaXManagedTask, text: string): string {
  if (!task.runtime?.degradedContinue) {
    return text;
  }
  const note = 'Note: a stronger AMA harness was requested during this run, but execution continued under the current harness as a best-effort pass. Coverage and confidence may be reduced.';
  if (!text.trim()) {
    return note;
  }
  return text.includes(note) ? text : `${text.trim()}\n\n${note}`;
}

function buildFallbackManagedResult(
  task: KodaXManagedTask,
  workerResults: Map<string, KodaXResult>,
  terminalWorkerId: string,
): KodaXResult {
  const terminalResult = workerResults.get(terminalWorkerId);
  if (terminalResult) {
    const finalText = applyDegradedContinueNote(
      task,
      extractMessageText(terminalResult) || terminalResult.lastText || task.verdict.summary,
    );
    return mergeManagedTaskIntoResult(
      {
        ...terminalResult,
        success: task.verdict.status === 'completed',
        lastText: finalText,
        signal: task.verdict.signal ?? (task.verdict.status === 'blocked' ? 'BLOCKED' : terminalResult.signal),
        signalReason: task.verdict.signalReason ?? terminalResult.signalReason,
        messages: replaceLastAssistantMessage(terminalResult.messages, finalText),
      },
      task,
    );
  }

  const fallbackResult = [...workerResults.values()].pop();
  if (fallbackResult) {
    const finalText = applyDegradedContinueNote(
      task,
      task.verdict.summary || extractMessageText(fallbackResult) || fallbackResult.lastText,
    );
    return mergeManagedTaskIntoResult(
      {
        ...fallbackResult,
        success: task.verdict.status === 'completed',
        lastText: finalText,
        signal: task.verdict.signal ?? (task.verdict.status === 'blocked' ? 'BLOCKED' : fallbackResult.signal),
        signalReason: task.verdict.signalReason ?? fallbackResult.signalReason,
        messages: replaceLastAssistantMessage(fallbackResult.messages, finalText),
      },
      task,
    );
  }

  return {
    success: task.verdict.status === 'completed',
    lastText: applyDegradedContinueNote(task, task.verdict.summary),
    signal: task.verdict.signal ?? (task.verdict.status === 'blocked' ? 'BLOCKED' : undefined),
    signalReason: task.verdict.signalReason,
    messages: [
      {
        role: 'assistant',
        content: applyDegradedContinueNote(task, task.verdict.summary),
      },
    ],
    sessionId: task.contract.taskId,
    routingDecision: {
      primaryTask: task.contract.primaryTask,
      confidence: 1,
      riskLevel: task.contract.riskLevel,
      recommendedMode: task.contract.recommendedMode,
      recommendedThinkingDepth: 'medium',
      complexity: task.contract.complexity,
      workIntent: task.contract.workIntent,
      requiresBrainstorm: task.contract.requiresBrainstorm,
      harnessProfile: task.contract.harnessProfile,
      upgradeCeiling: task.runtime?.upgradeCeiling,
      reviewScale: task.runtime?.scorecard?.rubricFamily === 'code-review' ? 'small' : undefined,
      soloBoundaryConfidence: undefined,
      needsIndependentQA: undefined,
      routingSource: task.runtime?.routingSource,
      routingAttempts: task.runtime?.routingAttempts,
      reason: task.contract.reason,
      routingNotes: task.evidence.routingNotes,
    },
    managedTask: task,
  };
}

function canProviderSatisfyHarness(
  harness: KodaXTaskRoutingDecision['harnessProfile'],
  providerPolicy: ReasoningPlan['providerPolicy'] | undefined,
): boolean {
  if (!providerPolicy) {
    return true;
  }

  const snapshot = providerPolicy.snapshot;
  if (harness === 'H2_PLAN_EXECUTE_EVAL') {
    return !(
      snapshot.contextFidelity === 'lossy'
      || snapshot.sessionSupport === 'stateless'
      || snapshot.toolCallingFidelity === 'none'
      || snapshot.evidenceSupport === 'none'
    );
  }

  return true;
}

function consumeHarnessUpgradeBudget(
  controller: ManagedTaskBudgetController,
  fromHarness: KodaXTaskRoutingDecision['harnessProfile'],
  toHarness: KodaXTaskRoutingDecision['harnessProfile'],
): { granted: boolean; cost: number; reason?: string } {
  const cost = getHarnessUpgradeCost(fromHarness, toHarness);
  if (cost <= 0) {
    return { granted: false, cost: 0, reason: 'Requested harness is not stronger than the current harness.' };
  }
  const availableReserve = controller.upgradeReserveRemaining > 0
    ? controller.upgradeReserveRemaining
    : controller.reserveRemaining;
  if (availableReserve < cost) {
    return {
      granted: false,
      cost,
      reason: `Upgrade to ${toHarness} needs ${cost} reserve units, but only ${availableReserve} remain.`,
    };
  }

  if (controller.upgradeReserveRemaining > 0) {
    controller.upgradeReserveRemaining = Math.max(0, controller.upgradeReserveRemaining - cost);
  }
  controller.reserveRemaining = Math.max(0, controller.reserveRemaining - cost);
  controller.currentHarness = toHarness;
  return { granted: true, cost };
}

function withHarnessTransition(
  task: KodaXManagedTask,
  transition: KodaXManagedTaskHarnessTransition,
): KodaXManagedTask {
  return {
    ...task,
    runtime: {
      ...task.runtime,
      currentHarness: transition.approved ? transition.to : task.runtime?.currentHarness ?? task.contract.harnessProfile,
      harnessTransitions: [...(task.runtime?.harnessTransitions ?? []), transition],
    },
  };
}

function buildProtocolRetryPrompt(
  prompt: string,
  worker: ManagedTaskWorkerSpec,
  reason: string,
  previousRoleSummary?: KodaXRoleRoundSummary,
): string {
  const roleSpecificReminder = worker.role === 'planner'
    ? `Do not stop until you append a valid \`\`\`${MANAGED_TASK_CONTRACT_BLOCK}\`\`\` block; a Planner response without that block cannot be consumed.`
    : undefined;
  return [
    prompt,
    [
      '[Managed Task Protocol Retry]',
      `Previous ${worker.title} output could not be safely consumed: ${reason}`,
      'Re-run the same role, keep the user-facing content, and append the required structured closing block exactly once at the end.',
      roleSpecificReminder,
    ].join('\n'),
    previousRoleSummary ? formatRoleRoundSummarySection(previousRoleSummary) : undefined,
  ].join('\n\n');
}

function markMissingManagedBlockResult(
  result: KodaXResult,
  worker: ManagedTaskWorkerSpec,
  reason: string,
): KodaXResult {
  return {
    ...result,
    success: false,
    signal: 'BLOCKED',
    signalReason: `${worker.title} output could not be consumed: ${reason}.`,
  };
}

function shouldGrantBudgetExtension(
  controller: ManagedTaskBudgetController,
  worker: ManagedTaskWorkerSpec,
  request: KodaXBudgetExtensionRequest | undefined,
): { granted: number; reason?: string } {
  if (!request) {
    return { granted: 0 };
  }
  if (!worker.budgetSnapshot?.allowExtensionRequest) {
    return { granted: 0, reason: 'Budget extension requests are only allowed near the execution boundary.' };
  }
  const usableReserve = controller.upgradeReserveRemaining > 0
    ? Math.max(0, controller.reserveRemaining - controller.upgradeReserveRemaining)
    : controller.reserveRemaining;
  if (usableReserve <= 0) {
    return { granted: 0, reason: 'No reserve budget remains for extension.' };
  }
  if (request.confidenceToFinish < 0.55) {
    return { granted: 0, reason: 'Extension request confidence was too low to auto-approve.' };
  }
  const granted = Math.min(request.requestedIters, 3, usableReserve);
  if (granted <= 0) {
    return { granted: 0, reason: 'Requested extension exceeds remaining reserve.' };
  }
  return { granted };
}

function resolveHarnessUpgrade(
  task: KodaXManagedTask,
  directive: ManagedTaskVerdictDirective | undefined,
  agentMode: KodaXAgentMode,
  controller: ManagedTaskBudgetController,
  providerPolicy: ReasoningPlan['providerPolicy'] | undefined,
  round: number,
): {
  updatedDirective?: ManagedTaskVerdictDirective;
  transition?: KodaXManagedTaskHarnessTransition;
  haltRun: boolean;
  degradedContinue?: boolean;
} {
  if (!directive?.nextHarness) {
    return { updatedDirective: directive, haltRun: false };
  }

  const requestedHarness = directive.nextHarness;
  const currentHarness = task.contract.harnessProfile;
  const transitionSource = 'evaluator';
  const baseTransition: KodaXManagedTaskHarnessTransition = {
    from: currentHarness,
    to: requestedHarness,
    round,
    source: transitionSource,
    reason: directive.reason,
    approved: false,
  };

  const ignoreInvalidUpgrade = (denialReason: string): {
    updatedDirective: ManagedTaskVerdictDirective;
    transition: KodaXManagedTaskHarnessTransition;
    haltRun: false;
  } => ({
    updatedDirective: {
      ...directive,
      nextHarness: undefined,
      followups: [...directive.followups, denialReason],
    },
    transition: {
      ...baseTransition,
      denialReason,
    },
    haltRun: false,
  });

  const continueOnDeniedUpgrade = (denialReason: string): {
    updatedDirective: ManagedTaskVerdictDirective;
    transition: KodaXManagedTaskHarnessTransition;
    haltRun: false;
    degradedContinue: true;
  } => ({
    updatedDirective: {
      ...directive,
      nextHarness: undefined,
      followups: [...directive.followups, denialReason],
    },
    transition: {
      ...baseTransition,
      denialReason,
    },
    haltRun: false,
    degradedContinue: true,
  });

  if (directive.status !== 'revise') {
    return ignoreInvalidUpgrade('next_harness is only valid when status=revise.');
  }
  if (agentMode !== 'ama') {
    return continueOnDeniedUpgrade('Harness upgrade was requested, but this run is pinned to SA mode; continuing with the current harness.');
  }
  if (currentHarness === 'H0_DIRECT') {
    return ignoreInvalidUpgrade('Harness upgrades are not supported for H0 direct execution.');
  }
  if (currentHarness === 'H1_EXECUTE_EVAL') {
    return continueOnDeniedUpgrade(
      'H1 checked-direct runs must stay lightweight. Return the best supported answer with explicit limits instead of escalating to H2.',
    );
  }
  if (!isHarnessUpgrade(currentHarness, requestedHarness)) {
    return ignoreInvalidUpgrade(`Requested harness ${requestedHarness} is not stronger than the current harness ${currentHarness}.`);
  }
  if (
    controller.upgradeCeiling
    && getHarnessRank(requestedHarness) > getHarnessRank(controller.upgradeCeiling)
  ) {
    return continueOnDeniedUpgrade(
      `Requested harness ${requestedHarness} exceeds the allowed upgrade ceiling ${controller.upgradeCeiling}.`,
    );
  }
  if (!canProviderSatisfyHarness(requestedHarness, providerPolicy)) {
    return continueOnDeniedUpgrade(`Provider policy cannot safely satisfy ${requestedHarness}; continuing with the current harness.`);
  }

  const budgetDecision = consumeHarnessUpgradeBudget(controller, currentHarness, requestedHarness);
  if (!budgetDecision.granted) {
    return continueOnDeniedUpgrade(
      budgetDecision.reason ?? `Budget reserve could not satisfy upgrade to ${requestedHarness}; continuing with the current harness.`,
    );
  }

  if (controller.upgradeCeiling && getHarnessRank(requestedHarness) >= getHarnessRank(controller.upgradeCeiling)) {
    controller.upgradeCeiling = undefined;
  }

  return {
    updatedDirective: directive,
    transition: {
      ...baseTransition,
      approved: true,
    },
    haltRun: false,
  };
}

async function runManagedWorkerTask(
  worker: ManagedTaskWorkerSpec,
  preparedOptions: KodaXOptions,
  prompt: string,
  executeDefault: () => Promise<KodaXResult>,
  controller: ManagedTaskBudgetController,
): Promise<{ result: KodaXResult; budgetRequest?: KodaXBudgetExtensionRequest; budgetExtensionGranted?: number; budgetExtensionReason?: string }> {
  let attempts = 0;
  let currentPrompt = prompt;
  let lastResult: KodaXResult | undefined;

  while (attempts < MANAGED_TASK_ROUTER_MAX_RETRIES) {
    attempts += 1;
    const result = attempts === 1
      ? await executeDefault()
      : await runDirectKodaX(preparedOptions, currentPrompt);
    lastResult = result;

    const text = extractMessageText(result) || result.lastText;
    const requiredBlockReason =
      worker.role === 'evaluator'
        ? (!parseManagedTaskVerdictDirective(text) ? `missing ${MANAGED_TASK_VERDICT_BLOCK}` : undefined)
        : worker.role === 'planner'
          ? (!parseManagedTaskContractDirective(text) ? `missing ${MANAGED_TASK_CONTRACT_BLOCK}` : undefined)
          : worker.role === 'scout'
            ? (!parseManagedTaskScoutDirective(text) ? `missing ${MANAGED_TASK_SCOUT_BLOCK}` : undefined)
            : worker.role === 'generator' && !worker.terminalAuthority
                ? (!parseManagedTaskHandoffDirective(text) ? `missing ${MANAGED_TASK_HANDOFF_BLOCK}` : undefined)
                : undefined;

    if (requiredBlockReason && attempts < MANAGED_TASK_ROUTER_MAX_RETRIES) {
      currentPrompt = buildProtocolRetryPrompt(
        prompt,
        worker,
        requiredBlockReason,
        buildProtocolRetryRoleSummary(worker, result, attempts, requiredBlockReason),
      );
      continue;
    }

    const budgetRequest = parseBudgetExtensionRequest(text);
    if (budgetRequest) {
      return {
        result,
        budgetRequest,
        budgetExtensionGranted: 0,
        budgetExtensionReason: 'Per-worker iteration extensions are deprecated; rely on the global AMA work budget instead.',
      };
    }

    return {
      result: requiredBlockReason
        ? markMissingManagedBlockResult(result, worker, requiredBlockReason)
        : result,
    };
  }

  return {
    result: lastResult
      ? markMissingManagedBlockResult(
        lastResult,
        worker,
        worker.role === 'evaluator'
          ? `missing ${MANAGED_TASK_VERDICT_BLOCK}`
          : worker.role === 'planner'
            ? `missing ${MANAGED_TASK_CONTRACT_BLOCK}`
            : worker.role === 'scout'
              ? `missing ${MANAGED_TASK_SCOUT_BLOCK}`
              : worker.role === 'generator' && !worker.terminalAuthority
                ? `missing ${MANAGED_TASK_HANDOFF_BLOCK}`
                : 'missing required managed-task block',
      )
      : await executeDefault(),
  };
}

function createManagedOrchestrationEvents(
  baseEvents: KodaXEvents | undefined,
  agentMode: KodaXAgentMode,
  harnessProfile: KodaXTaskRoutingDecision['harnessProfile'],
  currentRound: number,
  maxRounds: number,
  controller: ManagedTaskBudgetController,
  upgradeCeiling?: KodaXTaskRoutingDecision['harnessProfile'],
): OrchestrationRunEvents<ManagedTaskWorkerSpec, string> | undefined {
  if (!baseEvents?.onTextDelta && !baseEvents?.onManagedTaskStatus) {
    return undefined;
  }

  return {
    onTaskStart: async (task) => {
      baseEvents.onTextDelta?.(`\n[${task.title}] starting\n`);
      baseEvents.onManagedTaskStatus?.({
        agentMode,
        harnessProfile,
        activeWorkerId: task.id,
        activeWorkerTitle: task.title,
        currentRound,
        maxRounds,
        phase: 'worker',
        upgradeCeiling,
        ...buildManagedStatusBudgetFields(controller),
      });
    },
    onTaskMessage: async (task, message) => {
      baseEvents.onTextDelta?.(`\n[${task.title}] ${message}\n`);
    },
    onTaskComplete: async (task, completed) => {
      baseEvents.onTextDelta?.(`\n[${task.title}] ${completed.status}: ${completed.result.summary ?? 'No summary available.'}\n`);
      baseEvents.onManagedTaskStatus?.({
        agentMode,
        harnessProfile,
        activeWorkerId: task.id,
        activeWorkerTitle: task.title,
        currentRound,
        maxRounds,
        phase: 'worker',
        note: `${task.title} ${completed.status}`,
        upgradeCeiling,
        ...buildManagedStatusBudgetFields(controller),
      });
    },
  };
}

function createTacticalFanoutStatusEvents(
  baseEvents: KodaXEvents | undefined,
  agentMode: KodaXAgentMode,
  harnessProfile: KodaXTaskRoutingDecision['harnessProfile'],
  getPlan: () => KodaXFanoutSchedulerPlan,
): OrchestrationRunEvents<ManagedTaskWorkerSpec, string> | undefined {
  if (!baseEvents?.onManagedTaskStatus) {
    return undefined;
  }

  const buildStatus = (
    task: ManagedTaskWorkerSpec,
    note?: string,
  ): KodaXManagedTaskStatusEvent => {
    const childFanoutClass = task.metadata?.fanoutClass === 'finding-validation'
      || task.metadata?.fanoutClass === 'evidence-scan'
      || task.metadata?.fanoutClass === 'module-triage'
      || task.metadata?.fanoutClass === 'hypothesis-check'
      ? task.metadata.fanoutClass
      : undefined;
    return {
      agentMode,
      harnessProfile,
      activeWorkerId: task.id,
      activeWorkerTitle: task.title,
      phase: 'worker',
      note,
      childFanoutClass,
      childFanoutCount: childFanoutClass ? countActiveFanoutBranches(getPlan()) : undefined,
    };
  };

  return {
    onTaskStart: async (task) => {
      baseEvents.onManagedTaskStatus?.(buildStatus(task));
    },
    onTaskComplete: async (task, completed) => {
      baseEvents.onManagedTaskStatus?.(
        buildStatus(task, `${task.title} ${completed.status}`),
      );
    },
  };
}

async function executeManagedTaskRound(
  options: KodaXOptions,
  task: KodaXManagedTask,
  workerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] },
  workspaceDir: string,
  runId: string,
  routingPromptOverlay: string | undefined,
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode,
  controller: ManagedTaskBudgetController,
  agentMode: KodaXAgentMode,
  round: number,
  maxRounds: number,
  plan: ReasoningPlan,
  sessionStorage: KodaXSessionStorage | undefined,
  previousDirective?: ManagedTaskVerdictDirective,
): Promise<ManagedTaskRoundExecution> {
  let directive: ManagedTaskVerdictDirective | undefined;
  let budgetRequest: KodaXBudgetExtensionRequest | undefined;
  let budgetExtensionGranted: number | undefined;
  let budgetExtensionReason: string | undefined;
  const workerResults = new Map<string, KodaXResult>();
  const contractDirectives = new Map<string, ManagedTaskContractDirective>();
  let taskSnapshot = task;
  const managedWorkerRunner = createKodaXTaskRunner<ManagedTaskWorkerSpec>({
    baseOptions: options,
    runAgent: runDirectKodaX,
    createOptions: (worker, _context, defaultOptions) => buildWorkerRunOptions(
      defaultOptions,
      task,
      worker,
      workerSet.terminalWorkerId,
      routingPromptOverlay,
      qualityAssuranceMode,
      sessionStorage,
      resolveManagedMemoryStrategy(options, plan, worker.role, round, previousDirective),
      createBudgetSnapshot(controller, task.contract.harnessProfile, round, worker.role, worker.id),
      controller,
    ),
    runTask: async (worker, _context, preparedOptions, prompt, executeDefault) => {
      const execution = await runManagedWorkerTask(
        worker,
        preparedOptions,
        prompt,
        executeDefault,
        controller,
      );
      if (execution.budgetRequest) {
        budgetRequest = execution.budgetRequest;
        budgetExtensionGranted = execution.budgetExtensionGranted;
        budgetExtensionReason = execution.budgetExtensionReason;
      }
      return execution.result;
    },
    onResult: async (worker, _context, result) => {
      const sanitized = worker.role === 'evaluator'
        ? sanitizeManagedWorkerResult(result, { enforceVerdictBlock: true })
        : worker.role === 'planner'
            ? sanitizeContractResult(result)
          : worker.role === 'scout'
            ? sanitizeScoutResult(result)
            : worker.role === 'generator' && !worker.terminalAuthority
              ? sanitizeHandoffResult(result, worker.title)
              : { result };
      workerResults.set(worker.id, sanitized.result);
      let completionStatus: 'ready' | 'incomplete' | 'blocked' | 'missing' = 'missing';
      if (worker.role === 'scout') {
        completionStatus = (sanitized.directive as ManagedTaskScoutDirective | undefined) ? 'ready' : 'missing';
      } else if (worker.role === 'planner') {
        completionStatus = (sanitized.directive as ManagedTaskContractDirective | undefined) ? 'ready' : 'missing';
      } else if (worker.role === 'evaluator') {
        const verdictDirective = sanitized.directive as ManagedTaskVerdictDirective | undefined;
        completionStatus = verdictDirective?.status === 'accept'
          ? 'ready'
          : verdictDirective?.status === 'revise'
            ? 'incomplete'
            : verdictDirective?.status ?? 'missing';
      } else {
        const handoffDirective = sanitized.directive as ManagedTaskHandoffDirective | undefined;
        completionStatus = handoffDirective?.status ?? (
          sanitized.result.success
            ? 'ready'
            : sanitized.result.signal === 'BLOCKED'
              ? 'blocked'
              : 'missing'
        );
      }
      const taskWithTelemetry = applyManagedToolTelemetry(taskSnapshot, sanitized.result);
      taskSnapshot = {
        ...taskWithTelemetry,
        runtime: {
          ...taskWithTelemetry.runtime,
          completionContractStatus: {
            ...(taskWithTelemetry.runtime?.completionContractStatus ?? {}),
            [worker.id]: completionStatus,
          },
        },
      };
      if (sessionStorage instanceof ManagedWorkerSessionStorage) {
        sessionStorage.saveMemoryNote(
          buildManagedWorkerSessionId(task, worker),
          buildManagedWorkerMemoryNote(task, worker, sanitized.result, round),
        );
      }
      if (worker.role === 'planner') {
        const contractDirective = (sanitized.directive as ManagedTaskContractDirective | undefined)
          ?? parseManagedTaskContractDirective(
            extractMessageText(sanitized.result) || sanitized.result.lastText,
          );
        if (contractDirective) {
          contractDirectives.set(worker.id, contractDirective);
          taskSnapshot = applyManagedTaskContractDirectives(
            taskSnapshot,
            contractDirectives,
          );
          await writeManagedTaskSnapshotArtifacts(taskSnapshot.evidence.workspaceDir, taskSnapshot);
        }
      }
      const roleRoundSummary = buildManagedWorkerRoundSummary(
        taskSnapshot,
        worker,
        sanitized.result,
        round,
        sanitized.directive as ManagedTaskScoutDirective | ManagedTaskContractDirective | ManagedTaskVerdictDirective | undefined,
      );
      if (roleRoundSummary) {
        taskSnapshot = {
          ...taskSnapshot,
          runtime: {
            ...taskSnapshot.runtime,
            roleRoundSummaries: {
              ...(taskSnapshot.runtime?.roleRoundSummaries ?? {}),
              [worker.role]: roleRoundSummary,
            },
          },
        };
      }
      if (worker.id === workerSet.terminalWorkerId && worker.role === 'evaluator') {
        directive = sanitized.directive as ManagedTaskVerdictDirective | undefined;
      }
      return sanitized.result;
    },
  });

  const orchestrationResult = await runOrchestration<ManagedTaskWorkerSpec, string>({
    runId,
    workspaceDir,
    maxParallel: 1,
    tasks: workerSet.workers,
    signal: options.abortSignal,
    runner: async (worker, context) => {
      await context.emit(`Launching ${worker.title}`);
      return managedWorkerRunner(worker, context);
    },
    events: createManagedOrchestrationEvents(
      options.events,
      agentMode,
      task.contract.harnessProfile,
      round,
      maxRounds,
      controller,
      task.runtime?.upgradeCeiling,
    ),
  });

  if (!directive) {
    for (const worker of workerSet.workers) {
      const result = workerResults.get(worker.id);
      if (!result) {
        continue;
      }
      if (worker.role === 'planner') {
        const contractDirective = parseManagedTaskContractDirective(extractMessageText(result) || result.lastText);
        if (!contractDirective) {
          directive = {
            source: 'worker',
            status: 'revise',
            reason: result.signalReason || `${worker.title} did not produce a consumable sprint contract.`,
            followups: [
              `Re-run ${worker.title} and require a final ${MANAGED_TASK_CONTRACT_BLOCK} fenced block before execution proceeds.`,
            ],
            userFacingText: sanitizeManagedUserFacingText(extractMessageText(result) || result.lastText),
          };
          break;
        }
      }
      if (worker.role === 'generator') {
        const handoff = parseManagedTaskHandoffDirective(extractMessageText(result) || result.lastText);
        if (handoff && handoff.status !== 'ready') {
          directive = {
            source: 'worker',
            status: handoff.status === 'blocked' ? 'blocked' : 'revise',
            reason: handoff.summary || result.signalReason || `${worker.title} reported ${handoff.status}.`,
            followups: handoff.followup.filter((item) => item.toLowerCase() !== 'none'),
            userFacingText: handoff.userFacingText || handoff.summary || '',
          };
          break;
        }
        if (!handoff && result.success === false) {
          directive = {
            source: 'worker',
            status: result.signal === 'BLOCKED' ? 'blocked' : 'revise',
            reason: result.signalReason || `${worker.title} did not produce a consumable handoff.`,
            followups: [],
            userFacingText: sanitizeManagedUserFacingText(extractMessageText(result) || result.lastText),
          };
          break;
        }
      }
    }
  }

  return {
    workerSet,
    workerResults,
    contractDirectives,
    orchestrationResult,
    taskSnapshot,
    workspaceDir,
    directive,
    budgetRequest,
    budgetExtensionGranted,
    budgetExtensionReason,
  };
}

function applyManagedTaskDirective(
  task: KodaXManagedTask,
  directive: ManagedTaskVerdictDirective | undefined,
): KodaXManagedTask {
  if (!directive) {
    return task;
  }
  const preferredPublicText = directive.userAnswer?.trim() || directive.userFacingText;

  if (directive.status === 'accept') {
    return {
      ...task,
      verdict: {
        ...task.verdict,
        summary: preferredPublicText || task.verdict.summary,
        disposition: 'complete',
        continuationSuggested: false,
      },
    };
  }

  const signalReason = directive.reason || 'Evaluator requested another revision before acceptance.';
  const disposition = directive.status === 'revise' ? 'needs_continuation' : 'blocked';
  return {
    ...task,
    contract: {
      ...task.contract,
      status: 'blocked',
      updatedAt: new Date().toISOString(),
    },
    verdict: {
      ...task.verdict,
      status: 'blocked',
      summary: preferredPublicText || task.verdict.summary,
      signal: 'BLOCKED',
      signalReason,
      disposition,
      continuationSuggested: directive.status === 'revise',
    },
  };
}

function applyManagedTaskContractDirectives(
  task: KodaXManagedTask,
  directives: Map<string, ManagedTaskContractDirective>,
): KodaXManagedTask {
  if (directives.size === 0) {
    return task;
  }

  const selectedAssignmentId = directives.has('planner')
    ? 'planner'
    : undefined;
  const selected = selectedAssignmentId ? directives.get(selectedAssignmentId) : Array.from(directives.values()).at(-1);
  if (!selected) {
    return task;
  }

  const requiredEvidence = selected.requiredEvidence.length > 0
    ? selected.requiredEvidence
    : task.contract.requiredEvidence;

  return {
    ...task,
    contract: {
      ...task.contract,
      contractSummary: selected.summary ?? task.contract.contractSummary,
      successCriteria: selected.successCriteria.length > 0
        ? selected.successCriteria
        : task.contract.successCriteria,
      requiredEvidence,
      constraints: selected.constraints.length > 0
        ? selected.constraints
        : task.contract.constraints,
      contractCreatedByAssignmentId: selectedAssignmentId ?? task.contract.contractCreatedByAssignmentId,
      contractUpdatedAt: new Date().toISOString(),
    },
  };
}

function synchronizeManagedTaskGraph(
  task: KodaXManagedTask,
  workerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] },
  harnessProfile: KodaXTaskRoutingDecision['harnessProfile'],
  upgradeCeiling?: KodaXTaskRoutingDecision['harnessProfile'],
): KodaXManagedTask {
  const previousAssignments = new Map(task.roleAssignments.map((assignment) => [assignment.id, assignment]));
  return {
    ...task,
    contract: {
      ...task.contract,
      harnessProfile,
      updatedAt: new Date().toISOString(),
    },
    roleAssignments: [
      ...workerSet.workers.map((worker) => {
        const existing = previousAssignments.get(worker.id);
        return {
          id: worker.id,
          role: worker.role,
          title: worker.title,
          dependsOn: worker.dependsOn ?? [],
          status: existing?.status ?? 'planned',
          summary: existing?.summary,
          sessionId: existing?.sessionId,
          agent: worker.agent,
          toolPolicy: worker.toolPolicy,
        };
      }),
    ],
    workItems: [
      ...workerSet.workers.map((worker) => ({
        id: worker.id,
        assignmentId: worker.id,
        description: worker.title,
        execution: worker.execution ?? 'serial',
      })),
    ],
    verdict: {
      ...task.verdict,
      decidedByAssignmentId: workerSet.terminalWorkerId,
    },
    runtime: {
      ...task.runtime,
      currentHarness: harnessProfile,
      upgradeCeiling,
    },
  };
}

export async function runManagedTask(
  options: KodaXOptions,
  prompt: string,
): Promise<KodaXResult> {
  const agentMode = resolveManagedAgentMode(options);
  if (agentMode === 'sa') {
    const intentGate = inferIntentGate(prompt);
    return runDirectKodaX(
      {
        ...options,
        context: {
          ...options.context,
          promptOverlay: buildDirectPathTaskFamilyPromptOverlay(
            intentGate.taskFamily,
            [options.context?.promptOverlay],
          ),
        },
      },
      prompt,
    );
  }

  const managedPlanning = await createManagedReasoningPlan(options, prompt);
  const managedOptions: KodaXOptions = managedPlanning.repoRoutingSignals
    ? {
      ...options,
      context: {
        ...options.context,
        repoRoutingSignals: managedPlanning.repoRoutingSignals,
      },
    }
    : options;
  const managedOriginalTask = resolveManagedOriginalTask(managedOptions.context, prompt);
  let plan = applyAgentModeToPlan(managedPlanning.plan, agentMode);
  const rawRoutingDecision = managedPlanning.rawDecision;
  let finalRoutingDecision = cloneRoutingDecisionWithReviewTarget(
    plan.decision,
    managedPlanning.reviewTarget,
  );
  let routingOverrideReason = managedPlanning.routingOverrideReason;
  let liveRoutingNote = createLiveRoutingNote(
    rawRoutingDecision,
    finalRoutingDecision,
    managedPlanning.repoRoutingSignals,
    routingOverrideReason,
  );
  const initialBudgetController = createManagedBudgetController(managedOptions, plan, agentMode);

  managedOptions.events?.onManagedTaskStatus?.({
    agentMode,
    harnessProfile: finalRoutingDecision.harnessProfile,
    phase: 'routing',
    note: liveRoutingNote,
    upgradeCeiling: finalRoutingDecision.upgradeCeiling,
    ...buildManagedStatusBudgetFields(initialBudgetController),
  });

  if (shouldBypassScoutForManagedH0(finalRoutingDecision)) {
    return runDirectKodaX(
      {
        ...managedOptions,
        context: {
          ...managedOptions.context,
          promptOverlay: applyDirectPathTaskFamilyShaping(
            plan,
            [
              managedOptions.context?.promptOverlay,
              `[Managed Task Routing] ${createRoutingBreadcrumb(rawRoutingDecision, finalRoutingDecision, routingOverrideReason)}`,
            ].filter(Boolean).join('\n\n'),
          ),
        },
      },
      prompt,
    );
  }

  managedOptions.events?.onManagedTaskStatus?.({
    agentMode,
    harnessProfile: finalRoutingDecision.harnessProfile,
    activeWorkerId: 'scout',
    activeWorkerTitle: 'Scout',
    phase: 'preflight',
    note: 'Scout analyzing task complexity',
    upgradeCeiling: finalRoutingDecision.upgradeCeiling,
    ...buildManagedStatusBudgetFields(initialBudgetController),
  });
  const scoutBudgetController = initialBudgetController;
  const scoutExecution = await runManagedScoutStage(managedOptions, prompt, plan, scoutBudgetController);
  plan = applyScoutDecisionToPlan(plan, scoutExecution.directive);
  const skillMap = buildSkillMap(managedOptions.context?.skillInvocation, scoutExecution.directive);
  finalRoutingDecision = cloneRoutingDecisionWithReviewTarget(
    plan.decision,
    managedPlanning.reviewTarget,
  );
  if (shouldRunTacticalReviewFanout(
    agentMode,
    getManagedTaskSurface(managedOptions),
    plan,
    finalRoutingDecision,
    scoutExecution.directive,
  )) {
    return runTacticalReviewFlow(
      managedOptions,
      managedOriginalTask,
      plan,
      scoutExecution,
      rawRoutingDecision,
      finalRoutingDecision,
      routingOverrideReason,
      skillMap,
      agentMode,
      scoutBudgetController,
    );
  }

  if (shouldRunTacticalInvestigationFanout(
    agentMode,
    getManagedTaskSurface(managedOptions),
    plan,
    finalRoutingDecision,
    scoutExecution.directive,
  )) {
    return runTacticalInvestigationFlow(
      managedOptions,
      managedOriginalTask,
      plan,
      scoutExecution,
      rawRoutingDecision,
      finalRoutingDecision,
      routingOverrideReason,
      skillMap,
      agentMode,
      scoutBudgetController,
    );
  }

  if (scoutExecution.directive.confirmedHarness === 'H0_DIRECT') {
    const scoutShape = createScoutCompleteTaskShape(
      managedOptions,
      managedOriginalTask,
      managedOriginalTask,
      plan,
      {
        originalTask: managedOriginalTask,
        skillInvocation: managedOptions.context?.skillInvocation,
        skillMap,
      },
    );
    const scoutCompleteBudgetController = createManagedBudgetController(managedOptions, plan, agentMode);
    scoutCompleteBudgetController.spentBudget = Math.max(
      scoutCompleteBudgetController.spentBudget,
      scoutBudgetController.spentBudget,
    );
    await mkdir(scoutShape.workspaceDir, { recursive: true });
    const scoutSkillArtifacts = await writeManagedSkillArtifacts(
      scoutShape.workspaceDir,
      managedOptions.context?.skillInvocation,
      skillMap,
    );
    const scoutRoleRoundSummary = buildManagedWorkerRoundSummary(
      scoutShape.task,
      scoutShape.workers[0]!,
      scoutExecution.result,
      1,
      scoutExecution.directive,
    );
    scoutShape.task = {
      ...scoutShape.task,
      runtime: {
        ...applyManagedBudgetRuntimeState(scoutShape.task.runtime, scoutCompleteBudgetController),
        budget: createBudgetSnapshot(scoutCompleteBudgetController, 'H0_DIRECT', 1, 'scout'),
        routingAttempts: plan.decision.routingAttempts,
        routingSource: plan.decision.routingSource,
        rawRoutingDecision,
        finalRoutingDecision,
        routingOverrideReason,
        qualityAssuranceMode: scoutShape.qualityAssuranceMode,
        scorecard: createVerificationScorecard(scoutShape.task, undefined),
        scoutDecision: {
          summary: scoutExecution.directive.summary ?? 'Scout completed the task directly.',
          recommendedHarness: 'H0_DIRECT',
          readyForUpgrade: false,
          scope: scoutExecution.directive.scope,
          requiredEvidence: scoutExecution.directive.requiredEvidence,
          reviewFilesOrAreas: scoutExecution.directive.reviewFilesOrAreas,
          evidenceAcquisitionMode: scoutExecution.directive.evidenceAcquisitionMode,
          skillSummary: scoutExecution.directive.skillMap?.skillSummary,
          executionObligations: scoutExecution.directive.skillMap?.executionObligations,
          verificationObligations: scoutExecution.directive.skillMap?.verificationObligations,
          ambiguities: scoutExecution.directive.skillMap?.ambiguities,
          projectionConfidence: scoutExecution.directive.skillMap?.projectionConfidence,
        },
        skillMap,
        evidenceAcquisitionMode: scoutExecution.directive.evidenceAcquisitionMode ?? 'overview',
        reviewFilesOrAreas: scoutExecution.directive.reviewFilesOrAreas,
        roleRoundSummaries: scoutRoleRoundSummary
          ? { scout: scoutRoleRoundSummary }
          : undefined,
      },
      evidence: {
        ...scoutShape.task.evidence,
        artifacts: mergeEvidenceArtifacts(
          scoutShape.task.evidence.artifacts,
          scoutSkillArtifacts,
        ),
      },
    };
    const scoutManagedTask = applyScoutTerminalResultToTask(
      scoutShape.task,
      scoutExecution.result,
      scoutExecution.directive,
    );
    await writeManagedTaskSnapshotArtifacts(scoutShape.workspaceDir, scoutManagedTask);
    managedOptions.events?.onManagedTaskStatus?.({
      agentMode,
      harnessProfile: 'H0_DIRECT',
      activeWorkerId: 'scout',
      activeWorkerTitle: 'Scout',
      phase: 'completed',
      note: 'Scout completed the task directly',
      upgradeCeiling: finalRoutingDecision.upgradeCeiling,
      ...buildManagedStatusBudgetFields(scoutCompleteBudgetController),
    });
    scheduleManagedTaskRepoIntelligenceCapture(
      resolveManagedTaskRepoIntelligenceContext(managedOptions),
      scoutShape.workspaceDir,
      managedOptions,
    );
    return {
      ...scoutExecution.result,
      managedTask: scoutManagedTask,
      routingDecision: finalRoutingDecision,
    };
  }

  const shape = createTaskShape(
    managedOptions,
    managedOriginalTask,
    managedOriginalTask,
    plan,
    {
      originalTask: managedOriginalTask,
      skillInvocation: managedOptions.context?.skillInvocation,
      skillMap,
    },
  );
  const budgetController = createManagedBudgetController(managedOptions, plan, agentMode);
  budgetController.spentBudget = Math.max(budgetController.spentBudget, scoutBudgetController.spentBudget);
  const sessionStorage = new ManagedWorkerSessionStorage();
  await mkdir(shape.workspaceDir, { recursive: true });
  const skillArtifacts = await writeManagedSkillArtifacts(
    shape.workspaceDir,
    managedOptions.context?.skillInvocation,
    skillMap,
  );
  shape.task = await attachManagedTaskRepoIntelligence(managedOptions, shape.task);
  shape.task = {
    ...shape.task,
    runtime: {
      ...applyManagedBudgetRuntimeState(shape.task.runtime, budgetController),
      budget: createBudgetSnapshot(budgetController, shape.task.contract.harnessProfile, 0, undefined),
      routingAttempts: plan.decision.routingAttempts,
      routingSource: plan.decision.routingSource,
      scorecard: createVerificationScorecard(shape.task, undefined),
      qualityAssuranceMode: shape.qualityAssuranceMode,
      rawRoutingDecision,
      finalRoutingDecision,
      routingOverrideReason,
      scoutDecision: {
        summary: scoutExecution.directive.summary ?? 'Scout completed.',
        recommendedHarness: finalRoutingDecision.harnessProfile,
        readyForUpgrade: finalRoutingDecision.harnessProfile !== 'H0_DIRECT',
        scope: scoutExecution.directive.scope,
        requiredEvidence: scoutExecution.directive.requiredEvidence,
        reviewFilesOrAreas: scoutExecution.directive.reviewFilesOrAreas,
        evidenceAcquisitionMode: scoutExecution.directive.evidenceAcquisitionMode,
        skillSummary: scoutExecution.directive.skillMap?.skillSummary,
        executionObligations: scoutExecution.directive.skillMap?.executionObligations,
        verificationObligations: scoutExecution.directive.skillMap?.verificationObligations,
        ambiguities: scoutExecution.directive.skillMap?.ambiguities,
        projectionConfidence: scoutExecution.directive.skillMap?.projectionConfidence,
      },
      skillMap,
      evidenceAcquisitionMode: scoutExecution.directive.evidenceAcquisitionMode ?? 'overview',
      reviewFilesOrAreas: scoutExecution.directive.reviewFilesOrAreas,
    },
    evidence: {
      ...shape.task.evidence,
      artifacts: mergeEvidenceArtifacts(
        shape.task.evidence.artifacts,
        skillArtifacts,
      ),
      entries: [
        ...shape.task.evidence.entries,
        {
          assignmentId: 'scout',
          title: 'Scout',
          role: 'scout',
          round: 0,
          status: scoutExecution.result.success ? 'completed' : 'failed',
          summary: scoutExecution.directive.summary,
          output: scoutExecution.directive.userFacingText || extractMessageText(scoutExecution.result),
          sessionId: scoutExecution.result.sessionId,
          signal: scoutExecution.result.signal,
          signalReason: scoutExecution.result.signalReason,
        },
      ],
    },
  };

  let managedTask = shape.task;
  let roundDirective: ManagedTaskVerdictDirective | undefined;
  let roundExecution: ManagedTaskRoundExecution | undefined;
  let pendingInitialWorkerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] } | undefined;
  let initialWorkerSet = { terminalWorkerId: shape.terminalWorkerId, workers: shape.workers };
  let maxRounds = resolveManagedTaskMaxRounds(managedOptions, plan, agentMode);
  let h1CheckedDirectRevisesUsed = 0;
  await writeManagedTaskSnapshotArtifacts(shape.workspaceDir, managedTask);

  for (let round = 1; round <= maxRounds; round += 1) {
    const evidenceRecoveryNote = (
      (managedTask.runtime?.consecutiveEvidenceOnlyIterations ?? 0) >= EVIDENCE_ONLY_ITERATION_THRESHOLD
      && managedTask.runtime?.evidenceAcquisitionMode !== 'diff-bundle'
    )
      ? [
        '[Evidence Recovery]',
        'Recent iterations repeated serial diff paging without enough synthesis.',
        'Switch the next evidence pass to changed_diff_bundle before using changed_diff or read for deeper inspection.',
      ].join('\n')
      : undefined;
    const roundPrompt = [
      buildManagedRoundPrompt(managedOriginalTask, round, roundDirective),
      evidenceRecoveryNote,
    ].filter(Boolean).join('\n\n');
    const roundDecision: KodaXTaskRoutingDecision = {
      ...plan.decision,
      harnessProfile: managedTask.contract.harnessProfile,
      upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
    };
    const nextPhase = round === 1 || shouldReplanManagedRound(roundDirective)
      ? 'initial'
      : 'refinement';
    const workerSet = pendingInitialWorkerSet
      ?? (round === 1
        ? initialWorkerSet
        : buildManagedTaskWorkers(
          roundPrompt,
          roundDecision,
          managedOptions.context?.taskMetadata,
          managedOptions.context?.taskVerification,
          shape.qualityAssuranceMode,
          withManagedSkillArtifactPromptPaths({
            originalTask: managedOriginalTask,
            skillInvocation: managedOptions.context?.skillInvocation,
            skillMap: managedTask.runtime?.skillMap,
            previousRoleSummaries: managedTask.runtime?.roleRoundSummaries,
          }, shape.workspaceDir),
          managedOptions.context?.repoIntelligenceMode,
          nextPhase,
        ));
    pendingInitialWorkerSet = undefined;
    const roundWorkspaceDir = path.join(shape.workspaceDir, 'rounds', `round-${String(round).padStart(2, '0')}`);
    if (round > 1) {
      managedOptions.events?.onTextDelta?.(`\n[Managed Task] starting refinement round ${round}\n`);
    }
    managedOptions.events?.onManagedTaskStatus?.({
      agentMode,
      harnessProfile: managedTask.contract.harnessProfile,
      currentRound: round,
      maxRounds,
      phase: 'round',
      note: round > 1 ? `Starting refinement round ${round}` : 'Starting managed task execution',
      upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
      ...buildManagedStatusBudgetFields(budgetController),
    });
    budgetController.currentHarness = managedTask.contract.harnessProfile;
    managedTask = {
      ...managedTask,
      runtime: {
        ...applyManagedBudgetRuntimeState(managedTask.runtime, budgetController),
        budget: createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, round, undefined),
      },
    };
    await writeManagedTaskSnapshotArtifacts(shape.workspaceDir, managedTask);
    roundExecution = await executeManagedTaskRound(
      managedOptions,
      managedTask,
      workerSet,
      roundWorkspaceDir,
      `${shape.task.contract.taskId}-round-${round}`,
      shape.routingPromptOverlay,
      shape.qualityAssuranceMode,
      budgetController,
      agentMode,
      round,
      maxRounds,
      plan,
      sessionStorage,
      roundDirective,
    );
    managedTask = applyOrchestrationResultToTask(
      roundExecution.taskSnapshot,
      workerSet.terminalWorkerId,
      roundExecution.orchestrationResult,
      roundExecution.workerResults,
      round,
      roundWorkspaceDir,
    );
    managedTask = applyManagedTaskContractDirectives(
      managedTask,
      roundExecution.contractDirectives,
    );
    managedTask = {
      ...managedTask,
      runtime: {
        ...applyManagedBudgetRuntimeState(managedTask.runtime, budgetController),
        budget: createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, round, undefined),
        memoryStrategies: {
          ...(managedTask.runtime?.memoryStrategies ?? {}),
          ...Object.fromEntries(
            workerSet.workers
              .filter((worker) => worker.memoryStrategy)
              .map((worker) => [worker.id, worker.memoryStrategy as KodaXMemoryStrategy]),
          ),
        },
        memoryNotes: sessionStorage.snapshotMemoryNotes(),
      },
    };
    await writeManagedTaskSnapshotArtifacts(shape.workspaceDir, managedTask);

    roundDirective = roundExecution.directive;
    if (roundDirective) {
      if (
        managedTask.contract.harnessProfile === 'H1_EXECUTE_EVAL'
        && roundDirective.status === 'revise'
      ) {
        if (h1CheckedDirectRevisesUsed === 0) {
          h1CheckedDirectRevisesUsed += 1;
          maxRounds = Math.max(maxRounds, round + 1);
          budgetController.plannedRounds = Math.max(budgetController.plannedRounds, maxRounds);
          roundDirective = {
            ...roundDirective,
            nextHarness: undefined,
            followups: [
              ...(roundDirective.followups ?? []),
              'H1 checked-direct is taking one same-harness revise pass before final acceptance.',
            ],
          };
        } else {
          roundDirective = {
            ...roundDirective,
            status: 'blocked',
            nextHarness: undefined,
            reason: roundDirective.reason ?? 'Checked-direct review remained incomplete after one lightweight revise pass.',
            followups: [
              ...(roundDirective.followups ?? []),
              'H1 is capped at a single same-harness revise pass. Return the best supported answer with clear limits instead of escalating to H2.',
            ],
            userFacingText: roundDirective.userFacingText || managedTask.verdict.summary,
          };
        }
      }
      roundDirective = await persistManagedTaskDirectiveArtifact(roundWorkspaceDir, roundDirective);
      managedTask = {
        ...managedTask,
        evidence: {
          ...managedTask.evidence,
          artifacts: mergeEvidenceArtifacts(
            managedTask.evidence.artifacts,
            [
              {
                kind: 'json',
                path: roundDirective.artifactPath!,
                description: `Managed task feedback artifact for round ${round}`,
              },
              {
                kind: 'markdown',
                path: path.join(roundWorkspaceDir, 'feedback.md'),
                description: `Managed task feedback summary for round ${round}`,
              },
            ],
          ),
        },
      };

      const upgradeResolution = resolveHarnessUpgrade(
        managedTask,
        roundDirective,
        agentMode,
        budgetController,
        shape.providerPolicy,
        round,
      );
      roundDirective = upgradeResolution.updatedDirective;
      if (upgradeResolution.transition) {
        managedTask = withHarnessTransition(managedTask, upgradeResolution.transition);
      }
      if (upgradeResolution.degradedContinue) {
        managedTask = {
          ...managedTask,
          runtime: {
            ...applyManagedBudgetRuntimeState(managedTask.runtime, budgetController),
            degradedContinue: true,
            providerRuntimeBehavior: {
              downgraded: true,
              reasons: [
                ...(managedTask.runtime?.providerRuntimeBehavior?.reasons ?? []),
                upgradeResolution.transition?.denialReason ?? roundDirective?.reason ?? 'Continuing with current harness after denied upgrade.',
              ],
            },
          },
        };
      }

      if (upgradeResolution.transition?.approved && roundDirective?.nextHarness) {
        const targetHarness = roundDirective.nextHarness;
        if (targetHarness === 'H2_PLAN_EXECUTE_EVAL') {
          budgetController.plannedRounds = Math.max(budgetController.plannedRounds, round + 1);
          maxRounds = Math.max(maxRounds, budgetController.plannedRounds, round + 1);
        }
        const upgradedDecision: KodaXTaskRoutingDecision = {
          ...plan.decision,
          harnessProfile: targetHarness,
          upgradeCeiling: budgetController.upgradeCeiling,
        };
        pendingInitialWorkerSet = buildManagedTaskWorkers(
          roundPrompt,
          upgradedDecision,
          managedOptions.context?.taskMetadata,
          managedOptions.context?.taskVerification,
          shape.qualityAssuranceMode,
          withManagedSkillArtifactPromptPaths({
            originalTask: managedOriginalTask,
            skillInvocation: managedOptions.context?.skillInvocation,
            skillMap: managedTask.runtime?.skillMap,
            previousRoleSummaries: managedTask.runtime?.roleRoundSummaries,
          }, shape.workspaceDir),
          managedOptions.context?.repoIntelligenceMode,
          'initial',
        );
        managedTask = synchronizeManagedTaskGraph(
          managedTask,
          pendingInitialWorkerSet,
          targetHarness,
          budgetController.upgradeCeiling,
        );
        managedTask = {
          ...managedTask,
          runtime: {
            ...applyManagedBudgetRuntimeState(managedTask.runtime, budgetController),
            budget: createBudgetSnapshot(budgetController, targetHarness, round, undefined),
          },
        };
        managedOptions.events?.onTextDelta?.(
          `\n[Managed Task] approved harness upgrade ${upgradeResolution.transition.from} -> ${upgradeResolution.transition.to} for the next round.\n`,
        );
        managedOptions.events?.onManagedTaskStatus?.({
          agentMode,
          harnessProfile: targetHarness,
          currentRound: round,
          maxRounds,
          phase: 'upgrade',
          note: `Approved harness upgrade ${upgradeResolution.transition.from} -> ${upgradeResolution.transition.to}`,
          upgradeCeiling: budgetController.upgradeCeiling,
          ...buildManagedStatusBudgetFields(budgetController),
        });
      } else if (upgradeResolution.transition && !upgradeResolution.transition.approved && upgradeResolution.haltRun) {
        const denialReason = upgradeResolution.transition.denialReason
          ?? `Requested harness ${upgradeResolution.transition.to} could not be satisfied.`;
        managedOptions.events?.onTextDelta?.(
          `\n[Managed Task] requested harness upgrade denied: ${denialReason}\n`,
        );
        managedOptions.events?.onManagedTaskStatus?.({
          agentMode,
          harnessProfile: managedTask.contract.harnessProfile,
          currentRound: round,
          maxRounds,
          phase: 'upgrade',
          note: `Denied harness upgrade ${upgradeResolution.transition.from} -> ${upgradeResolution.transition.to}: ${denialReason}`,
          upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
          ...buildManagedStatusBudgetFields(budgetController),
        });
        managedTask = {
          ...managedTask,
          contract: {
            ...managedTask.contract,
            status: 'blocked',
            updatedAt: new Date().toISOString(),
          },
          verdict: {
            ...managedTask.verdict,
            status: 'blocked',
            signal: 'BLOCKED',
            signalReason: denialReason,
            disposition: 'needs_continuation',
            continuationSuggested: true,
            summary: roundDirective?.userFacingText || managedTask.verdict.summary,
          },
          runtime: {
            ...applyManagedBudgetRuntimeState(managedTask.runtime, budgetController),
            budget: createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, round, undefined),
          },
        };
        roundDirective = {
          ...(roundDirective ?? {
            source: 'evaluator',
            status: 'blocked',
            followups: [],
            userFacingText: managedTask.verdict.summary,
          }),
          status: 'blocked',
          reason: denialReason,
        };
        break;
      } else if (upgradeResolution.transition && !upgradeResolution.transition.approved) {
        const denialReason = upgradeResolution.transition.denialReason
          ?? `Requested harness ${upgradeResolution.transition.to} could not be satisfied.`;
        managedOptions.events?.onTextDelta?.(
          `\n[Managed Task] requested harness upgrade denied; continuing current harness: ${denialReason}\n`,
        );
      }
    }
    if (roundExecution.budgetRequest && roundExecution.budgetExtensionGranted === 0) {
      managedTask = {
        ...managedTask,
        verdict: {
          ...managedTask.verdict,
          disposition: 'needs_continuation',
          continuationSuggested: true,
          signal: 'BLOCKED',
          signalReason: roundExecution.budgetExtensionReason ?? roundExecution.budgetRequest.fallbackIfDenied,
          summary: roundExecution.budgetRequest.fallbackIfDenied || managedTask.verdict.summary,
        },
        runtime: {
          ...applyManagedBudgetRuntimeState(managedTask.runtime, budgetController),
          budget: {
            ...createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, round, undefined),
            extensionDenied: true,
            extensionReason: roundExecution.budgetExtensionReason ?? roundExecution.budgetRequest.reason,
          },
        },
      };
      roundDirective = {
        source: 'evaluator',
        status: 'revise',
        reason: roundExecution.budgetExtensionReason ?? roundExecution.budgetRequest.reason,
        followups: [roundExecution.budgetRequest.fallbackIfDenied],
        userFacingText: managedTask.verdict.summary,
      };
    }
    if (roundDirective?.status === 'revise') {
      const budgetDecision = await maybeRequestAdditionalWorkBudget(
        managedOptions.events,
        budgetController,
        {
          summary: roundDirective.reason
            ?? roundDirective.userFacingText
            ?? managedTask.verdict.summary
            ?? 'Additional work required.',
          currentRound: round,
          maxRounds,
        },
      );
      if (budgetDecision === 'approved') {
        if (round >= maxRounds) {
          maxRounds += 1;
        }
        budgetController.plannedRounds = Math.max(budgetController.plannedRounds, maxRounds);
        managedTask = {
          ...managedTask,
          runtime: {
            ...applyManagedBudgetRuntimeState(managedTask.runtime, budgetController),
            budget: createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, round, undefined),
          },
        };
        managedOptions.events?.onTextDelta?.(
          `\n[Managed Task] additional work budget approved (+${GLOBAL_WORK_BUDGET_INCREMENT}). Continuing the run.\n`,
        );
        managedOptions.events?.onManagedTaskStatus?.({
          agentMode,
          harnessProfile: managedTask.contract.harnessProfile,
          currentRound: round,
          maxRounds,
          phase: 'round',
          note: `Additional work budget approved (+${GLOBAL_WORK_BUDGET_INCREMENT}). Continuing the run.`,
          upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
          ...buildManagedStatusBudgetFields(budgetController),
        });
      } else if (budgetDecision === 'denied') {
        const denialReason = 'User denied additional AMA work budget.';
        managedTask = {
          ...managedTask,
          contract: {
            ...managedTask.contract,
            status: 'blocked',
            updatedAt: new Date().toISOString(),
          },
          verdict: {
            ...managedTask.verdict,
            status: 'blocked',
            signal: 'BLOCKED',
            signalReason: denialReason,
            disposition: 'needs_continuation',
            continuationSuggested: true,
            summary: roundDirective.userFacingText
              || roundDirective.reason
              || managedTask.verdict.summary,
          },
          runtime: {
            ...applyManagedBudgetRuntimeState(managedTask.runtime, budgetController),
            budget: createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, round, undefined),
          },
        };
        roundDirective = {
          ...roundDirective,
          status: 'blocked',
          reason: roundDirective.reason ?? denialReason,
          userFacingText: managedTask.verdict.summary,
        };
        managedOptions.events?.onTextDelta?.(
          `\n[Managed Task] additional work budget denied. Stopping with the current best result.\n`,
        );
        managedOptions.events?.onManagedTaskStatus?.({
          agentMode,
          harnessProfile: managedTask.contract.harnessProfile,
          currentRound: round,
          maxRounds,
          phase: 'completed',
          note: denialReason,
          upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
          ...buildManagedStatusBudgetFields(budgetController),
        });
        break;
      }
    }
    if (
      roundDirective?.status === 'revise'
      && managedTask.contract.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
      && !roundDirective.nextHarness
      && maxRounds < MANAGED_TASK_MAX_REFINEMENT_ROUND_CAP
    ) {
      maxRounds = Math.max(maxRounds, round + 1, MANAGED_TASK_MIN_REFINEMENT_ROUNDS + 1);
      budgetController.plannedRounds = Math.max(budgetController.plannedRounds, maxRounds);
    }
    if (roundDirective?.status === 'revise' && round < maxRounds) {
      const requesterLabel = roundDirective.source === 'worker'
          ? 'worker handoff'
          : 'evaluator';
      managedOptions.events?.onTextDelta?.(
        `\n[Managed Task] ${requesterLabel} requested another pass: ${roundDirective.reason ?? 'additional evidence required.'}${roundDirective.nextHarness ? ` Requested harness=${roundDirective.nextHarness}.` : ''}\n`,
      );
      continue;
    }
    break;
  }

  managedTask = applyManagedTaskDirective(managedTask, roundDirective);
  managedTask = {
    ...managedTask,
    runtime: {
      ...applyManagedBudgetRuntimeState(managedTask.runtime, budgetController),
      budget: createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, maxRounds, undefined),
      scorecard: createVerificationScorecard(managedTask, roundDirective),
      memoryNotes: sessionStorage.snapshotMemoryNotes(),
    },
  };
  const result = buildFallbackManagedResult(
    managedTask,
    roundExecution?.workerResults ?? new Map<string, KodaXResult>(),
    roundExecution?.workerSet.terminalWorkerId ?? shape.terminalWorkerId,
  );

  await writeManagedTaskArtifacts(shape.workspaceDir, managedTask, {
    success: result.success,
    lastText: result.lastText,
    sessionId: result.sessionId,
    signal: result.signal,
    signalReason: result.signalReason,
  }, roundDirective);

  managedOptions.events?.onManagedTaskStatus?.({
    agentMode,
    harnessProfile: managedTask.contract.harnessProfile,
    currentRound: Math.min(maxRounds, buildManagedTaskRoundHistory(managedTask).at(-1)?.round ?? maxRounds),
    maxRounds,
    phase: 'completed',
    note: managedTask.verdict.summary,
    upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
    ...buildManagedStatusBudgetFields(budgetController),
  });

  return mergeManagedTaskIntoResult(
    {
      ...result,
      routingDecision: result.routingDecision ?? plan.decision,
    },
    managedTask,
  );
}
