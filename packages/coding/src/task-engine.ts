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
  buildFallbackRoutingDecision,
  buildPromptOverlay,
  buildProviderPolicyHintsForDecision,
  createReasoningPlan,
  reasoningModeToDepth,
  resolveReasoningMode,
  type ReasoningPlan,
} from './reasoning.js';
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
  getRepoRoutingSignals,
  renderImpactEstimate,
  renderModuleContext,
} from './repo-intelligence/query.js';
import type {
  KodaXAgentMode,
  KodaXBudgetDisclosureZone,
  KodaXBudgetExtensionRequest,
  KodaXEvents,
  KodaXJsonValue,
  KodaXManagedTask,
  KodaXManagedBudgetSnapshot,
  KodaXMemoryStrategy,
  KodaXOptions,
  KodaXRepoRoutingSignals,
  KodaXResult,
  KodaXSessionData,
  KodaXSessionStorage,
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
}

interface ManagedTaskShape {
  task: KodaXManagedTask;
  terminalWorkerId: string;
  workers: ManagedTaskWorkerSpec[];
  workspaceDir: string;
  routingPromptOverlay?: string;
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode;
  providerPolicy?: ReasoningPlan['providerPolicy'];
}

interface ManagedTaskRepoIntelligenceSnapshot {
  artifacts: KodaXTaskEvidenceArtifact[];
}

interface ManagedTaskVerdictDirective {
  source: 'contract-review' | 'evaluator';
  status: 'accept' | 'revise' | 'blocked';
  reason?: string;
  followups: string[];
  userFacingText: string;
  artifactPath?: string;
}

interface ManagedTaskContractDirective {
  summary?: string;
  successCriteria: string[];
  requiredEvidence: string[];
  constraints: string[];
}

interface ManagedTaskRoundExecution {
  workerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] };
  workerResults: Map<string, KodaXResult>;
  contractDirectives: Map<string, ManagedTaskContractDirective>;
  orchestrationResult: OrchestrationRunResult<ManagedTaskWorkerSpec, string>;
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
  plannedRounds: number;
  spentBudget: number;
}

function truncateText(value: string, maxLength = 400): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

const MANAGED_TASK_CONTRACT_BLOCK = 'kodax-task-contract';
const MANAGED_TASK_CONTRACT_REVIEW_BLOCK = 'kodax-task-contract-review';
const MANAGED_TASK_VERDICT_BLOCK = 'kodax-task-verdict';
const MANAGED_TASK_BUDGET_REQUEST_BLOCK = 'kodax-budget-request';
const MANAGED_TASK_MAX_REFINEMENT_ROUND_CAP = 12;
const MANAGED_TASK_MIN_REFINEMENT_ROUNDS = 2;
const MANAGED_TASK_ROUTER_MAX_RETRIES = 3;
const MANAGED_TASK_BUDGET_BASE: Record<KodaXTaskRoutingDecision['harnessProfile'], number> = {
  H0_DIRECT: 50,
  H1_EXECUTE_EVAL: 100,
  H2_PLAN_EXECUTE_EVAL: 200,
  H3_MULTI_WORKER: 350,
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
  if (agentMode !== 'sa') {
    return {
      ...plan,
      promptOverlay: [
        plan.promptOverlay,
        '[Agent Mode: AMA] Adaptive multi-agent harness selection is enabled.',
      ].filter(Boolean).join('\n\n'),
    };
  }

  if (plan.decision.harnessProfile === 'H0_DIRECT') {
    return {
      ...plan,
      promptOverlay: [
        plan.promptOverlay,
        '[Agent Mode: SA] Single-agent execution is pinned for this run.',
      ].filter(Boolean).join('\n\n'),
    };
  }

  return {
    ...plan,
    decision: {
      ...plan.decision,
      harnessProfile: 'H0_DIRECT',
      reason: `${plan.decision.reason} Agent mode SA forced single-agent execution to reduce token usage.`,
      routingNotes: [
        ...(plan.decision.routingNotes ?? []),
        'Agent mode SA disabled adaptive multi-agent role split for this run.',
      ],
    },
    promptOverlay: [
      plan.promptOverlay,
      '[Agent Mode: SA] Single-agent execution is pinned for this run.',
    ].filter(Boolean).join('\n\n'),
  };
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

function createManagedBudgetController(
  options: KodaXOptions,
  plan: ReasoningPlan,
  agentMode: KodaXAgentMode,
): ManagedTaskBudgetController {
  if (agentMode !== 'ama' || plan.decision.harnessProfile === 'H0_DIRECT') {
    return {
      totalBudget: MANAGED_TASK_BUDGET_BASE.H0_DIRECT,
      reserveBudget: 0,
      reserveRemaining: 0,
      plannedRounds: 1,
      spentBudget: 0,
    };
  }

  let totalBudget = MANAGED_TASK_BUDGET_BASE[plan.decision.harnessProfile];
  const primaryTask = String(plan.decision.primaryTask);
  const tokenCount = options.context?.contextTokenSnapshot?.currentTokens ?? 0;
  const longRunning = Boolean(
    options.context?.taskSurface === 'project'
    || options.context?.providerPolicyHints?.longRunning
    || options.context?.longRunning
  );

  if (longRunning) {
    totalBudget = Math.round(totalBudget * 1.25);
  }
  if (
    primaryTask === 'review'
    || primaryTask === 'verify'
    || primaryTask === 'debug'
    || primaryTask === 'investigate'
  ) {
    totalBudget = Math.round(totalBudget * 1.15);
  }
  if (plan.decision.requiresBrainstorm || plan.decision.complexity === 'systemic') {
    totalBudget = Math.round(totalBudget * 1.2);
  }
  if (tokenCount >= 120_000) {
    totalBudget = Math.round(totalBudget * 0.65);
  } else if (tokenCount >= 60_000) {
    totalBudget = Math.round(totalBudget * 0.8);
  }

  totalBudget = clampNumber(totalBudget, 50, 500);
  const reserveBudget = clampNumber(Math.round(totalBudget * 0.2), 0, Math.max(0, totalBudget - 25));
  const executableBudget = Math.max(1, totalBudget - reserveBudget);
  const roundDivisor = plan.decision.harnessProfile === 'H3_MULTI_WORKER'
    ? 35
    : plan.decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
      ? 26
      : 30;
  const plannedRounds = clampNumber(
    Math.ceil(executableBudget / roundDivisor),
    MANAGED_TASK_MIN_REFINEMENT_ROUNDS,
    MANAGED_TASK_MAX_REFINEMENT_ROUND_CAP,
  );

  return {
    totalBudget,
    reserveBudget,
    reserveRemaining: reserveBudget,
    plannedRounds,
    spentBudget: 0,
  };
}

function resolveBudgetZone(
  round: number,
  plannedRounds: number,
  role: KodaXTaskRole,
): KodaXBudgetDisclosureZone {
  const ratio = plannedRounds <= 0 ? 1 : round / plannedRounds;
  const yellowThreshold = role === 'planner' || role === 'validator' || role === 'evaluator' ? 0.5 : 0.6;
  const orangeThreshold = role === 'planner' || role === 'validator' || role === 'evaluator' ? 0.78 : 0.85;
  const redThreshold = role === 'planner' || role === 'validator' || role === 'evaluator' ? 0.9 : 0.95;

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
  const baseByHarness: Record<KodaXTaskRoutingDecision['harnessProfile'], number> = {
    H0_DIRECT: 12,
    H1_EXECUTE_EVAL: 18,
    H2_PLAN_EXECUTE_EVAL: 24,
    H3_MULTI_WORKER: 30,
  };
  const roleMultiplier =
    role === 'planner' ? 0.45
      : role === 'validator' ? 0.5
      : role === 'evaluator' ? 0.55
      : role === 'lead' ? 0.5
      : 1;
  const soft = Math.max(4, Math.round(baseByHarness[harness] * roleMultiplier));
  return {
    soft,
    hard: soft + (role === 'generator' || role === 'worker' ? 6 : 3),
  };
}

function createBudgetSnapshot(
  controller: ManagedTaskBudgetController,
  harness: KodaXTaskRoutingDecision['harnessProfile'],
  round: number,
  role: KodaXTaskRole | undefined,
  workerId?: string,
): KodaXManagedBudgetSnapshot {
  const zone = resolveBudgetZone(round, controller.plannedRounds, role ?? 'worker');
  const iterLimits = resolveWorkerIterLimits(
    harness,
    role ?? 'worker',
  );
  return {
    totalBudget: controller.totalBudget,
    reserveBudget: controller.reserveBudget,
    reserveRemaining: controller.reserveRemaining,
    plannedRounds: controller.plannedRounds,
    currentRound: round,
    spentBudget: controller.spentBudget,
    remainingBudget: Math.max(0, controller.totalBudget - controller.spentBudget),
    workerId,
    role,
    zone,
    showExactRoundCounter: zone === 'orange' || zone === 'red',
    allowExtensionRequest: zone === 'orange' || zone === 'red',
    mustConverge: zone === 'red',
    softMaxIter: iterLimits.soft,
    hardMaxIter: iterLimits.hard,
  };
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
    `- Worker budget window: soft=${snapshot.softMaxIter ?? 'n/a'}, hard=${snapshot.hardMaxIter ?? 'n/a'}`,
    snapshot.zone === 'red'
      ? '- Final completion window: return a complete result, a blocked verdict, or a budget extension request.'
      : '- You are approaching the execution boundary. Do not open new exploration branches.',
  ];

  if (snapshot.allowExtensionRequest) {
    lines.push(
      `- If you are close to completion, append a \`\`\`${MANAGED_TASK_BUDGET_REQUEST_BLOCK}\` block requesting 1-3 additional iterations.`,
      '- Block shape: requested_iters: 1|2|3, reason: <why>, completion_expectation: <what finishes>, confidence_to_finish: <0..1>, fallback_if_denied: <best incomplete result plan>.',
    );
  }

  return lines.join('\n');
}

function resolveManagedMemoryStrategy(
  options: KodaXOptions,
  plan: ReasoningPlan | undefined,
  role: KodaXTaskRole,
  round: number,
  previousDirective?: ManagedTaskVerdictDirective,
): KodaXMemoryStrategy {
  if (role === 'planner' || role === 'validator' || role === 'evaluator') {
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
    `- Latest worker summary: ${latestSummary}`,
    latestFeedbackArtifact ? `- Latest feedback artifact: ${latestFeedbackArtifact}` : undefined,
    task.contract.verification?.runtime ? `- Runtime guide: ${runtimeGuidePath}` : undefined,
    `- Contract path: ${path.join(task.evidence.workspaceDir, 'contract.json')}`,
    `- Round history path: ${path.join(task.evidence.workspaceDir, 'round-history.json')}`,
    'Use the current contract and artifacts as the source of truth; do not rely on stale assumptions from older rounds.',
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
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
  const primaryTask = String(plan.decision.primaryTask);
  const verification = options.context?.taskVerification;
  const explicitVerification = Boolean(
    verification?.instructions?.length
    || verification?.requiredChecks?.length
    || verification?.requiredEvidence?.length
    || verification?.capabilityHints?.length
  );

  if (
    plan.decision.harnessProfile === 'H3_MULTI_WORKER'
    || plan.decision.needsIndependentQA
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

const INSPECTION_SHELL_PATTERNS = [
  '^(?:git\\s+(?:status|diff|show|log|branch|rev-parse|ls-files))\\b',
  '^(?:Get-ChildItem|Get-Content|Select-String|type|dir|ls|cat)\\b',
  '^(?:findstr|where|pwd|cd)\\b',
  '^(?:node|npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:lint|typecheck|check|list|why)\\b',
];

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

function inferFallbackDecision(
  prompt: string,
  repoSignals?: KodaXRepoRoutingSignals,
): KodaXTaskRoutingDecision {
  const base = buildFallbackRoutingDecision(prompt, undefined, {
    repoSignals,
  });
  const normalized = ` ${prompt.toLowerCase()} `;
  const asksForBrainstorm =
    /\b(brainstorm|options?|trade[\s-]?offs?|explore|compare approaches?)\b/.test(normalized);
  const appendIntent = /\b(append|continue|extend|follow[- ]up|iterate)\b/.test(normalized);
  const overwriteIntent = /\b(overwrite|rewrite|replace|migrate|refactor)\b/.test(normalized);

  if (
    /\b(multi-agent|parallel|across the monorepo|systemic|cross-cutting)\b/.test(normalized)
  ) {
    return {
      ...base,
      complexity: 'systemic',
      harnessProfile: 'H3_MULTI_WORKER',
      riskLevel: 'high',
      requiresBrainstorm: asksForBrainstorm,
      workIntent: overwriteIntent ? 'overwrite' : appendIntent ? 'append' : base.workIntent,
      reason: `${base.reason} Fallback task-engine routing selected H3 for cross-cutting scope.`,
      soloBoundaryConfidence: 0.18,
      needsIndependentQA: true,
      routingNotes: [
        ...(base.routingNotes ?? []),
        'Task-engine fallback routing escalated to H3 because the prompt looked cross-cutting or multi-worker.',
      ],
    };
  }

  if (
    asksForBrainstorm
    || /\b(plan|design|architecture|proposal|refactor|migration)\b/.test(normalized)
  ) {
    return {
      ...base,
      complexity: 'complex',
      harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
      requiresBrainstorm: asksForBrainstorm,
      workIntent: overwriteIntent ? 'overwrite' : appendIntent ? 'append' : base.workIntent,
      reason: `${base.reason} Fallback task-engine routing selected H2 for planning-heavy scope.`,
      soloBoundaryConfidence: 0.38,
      needsIndependentQA: true,
      routingNotes: [
        ...(base.routingNotes ?? []),
        'Task-engine fallback routing escalated to H2 because the prompt looked planning-heavy or exploratory.',
      ],
    };
  }

  if (
    /\b(review|verify|test|fix|bug|debug|investigate|audit)\b/.test(normalized)
    || prompt.trim().length > 280
  ) {
    return {
      ...base,
      complexity: 'moderate',
      harnessProfile: 'H1_EXECUTE_EVAL',
      workIntent: overwriteIntent ? 'overwrite' : appendIntent ? 'append' : base.workIntent,
      requiresBrainstorm: asksForBrainstorm,
      reason: `${base.reason} Fallback task-engine routing selected H1 for non-trivial execution.`,
      soloBoundaryConfidence: /\b(review|bug|fix)\b/.test(normalized) ? 0.72 : 0.58,
      needsIndependentQA: /\b(verify|test|audit|must[- ]fix|independent)\b/.test(normalized),
    };
  }

  return {
    ...base,
    complexity: 'simple',
    harnessProfile: 'H0_DIRECT',
    riskLevel: 'low',
    workIntent: overwriteIntent ? 'overwrite' : appendIntent ? 'append' : base.workIntent,
    requiresBrainstorm: asksForBrainstorm,
    reason: `${base.reason} Fallback task-engine routing kept the task in H0 direct mode.`,
    soloBoundaryConfidence: 0.9,
    needsIndependentQA: false,
  };
}

async function createManagedReasoningPlan(
  options: KodaXOptions,
  prompt: string,
): Promise<{ plan: ReasoningPlan; repoRoutingSignals?: KodaXRepoRoutingSignals }> {
  const repoRoutingSignals = options.context?.repoRoutingSignals
    ?? (
      (options.context?.executionCwd || options.context?.gitRoot)
        ? await getRepoRoutingSignals({
          executionCwd: options.context?.executionCwd,
          gitRoot: options.context?.gitRoot ?? undefined,
        }).catch(() => null)
        : null
    );
  try {
    const provider = resolveProvider(options.provider);
    return {
      plan: await createReasoningPlan(options, prompt, provider, {
        repoSignals: repoRoutingSignals ?? undefined,
      }),
      repoRoutingSignals: repoRoutingSignals ?? undefined,
    };
  } catch (error) {
    const decision = inferFallbackDecision(prompt, repoRoutingSignals ?? undefined);
    const mode = resolveReasoningMode(options);
    const depth = mode === 'auto'
      ? decision.recommendedThinkingDepth
      : mode === 'off'
        ? 'off'
        : reasoningModeToDepth(mode);

    return {
      plan: {
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
      },
      repoRoutingSignals: repoRoutingSignals ?? undefined,
    };
  }
}

function buildManagedWorkerAgent(role: KodaXTaskRole, workerId?: string): string {
  if (workerId === 'contract-review') {
    return 'ContractReviewAgent';
  }

  switch (role) {
    case 'lead':
      return 'LeadAgent';
    case 'planner':
      return 'PlanningAgent';
    case 'generator':
      return 'ExecutionAgent';
    case 'validator':
      return 'VerificationAgent';
    case 'evaluator':
      return 'EvaluationAgent';
    case 'worker':
      return 'SpecialistWorker';
    case 'direct':
    default:
      return 'DirectAgent';
  }
}

function buildManagedWorkerToolPolicy(
  role: KodaXTaskRole,
  verification: KodaXTaskVerificationContract | undefined,
): KodaXTaskToolPolicy | undefined {
  switch (role) {
    case 'lead':
    case 'planner':
      return {
        summary: 'Planning agents must stay read-only and may inspect repository state or design context, but must not mutate files or execute implementation steps.',
        blockedTools: [...WRITE_ONLY_TOOLS],
        allowedShellPatterns: INSPECTION_SHELL_PATTERNS,
      };
    case 'validator':
    case 'evaluator':
      return {
        summary: 'Verification agents may inspect the repo and run verification commands, including browser, startup, API, and runtime checks declared by the verification contract, but must not edit project files or mutate control-plane artifacts.',
        blockedTools: [...WRITE_ONLY_TOOLS],
        allowedShellPatterns: [
          ...VERIFICATION_SHELL_PATTERNS,
          ...buildRuntimeVerificationShellPatterns(verification),
        ],
      };
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
    `[Managed Task] task=${task.contract.taskId}; role=${worker.role}; worker=${worker.id}; terminal=${worker.id === terminalWorkerId ? 'yes' : 'no'}; agent=${worker.agent ?? buildManagedWorkerAgent(worker.role)}; qa=${qualityAssuranceMode}.`,
    worker.memoryStrategy
      ? `[Managed Task Memory] strategy=${worker.memoryStrategy}.`
      : undefined,
    `Managed task artifacts: contract=${path.join(task.evidence.workspaceDir, 'contract.json')}; rounds=${path.join(task.evidence.workspaceDir, 'round-history.json')}; runtimeGuide=${path.join(task.evidence.workspaceDir, 'runtime-execution.md')}.`,
    formatBudgetAdvisory(worker.budgetSnapshot),
    formatTaskContract(task.contract),
    formatTaskMetadata(task.contract.metadata),
    formatVerificationContract(task.contract.verification),
    formatToolPolicy(worker.toolPolicy),
  ]
    .filter((section): section is string => Boolean(section && section.trim()))
    .join('\n\n');
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
  workerId?: string,
  isTerminalAuthority = false,
): string {
  const decisionSummary = [
    `Primary task: ${decision.primaryTask}`,
    `Work intent: ${decision.workIntent}`,
    `Complexity: ${decision.complexity}`,
    `Risk: ${decision.riskLevel}`,
    `Harness: ${decision.harnessProfile}`,
    `Brainstorm required: ${decision.requiresBrainstorm ? 'yes' : 'no'}`,
  ].join('\n');

  const sharedClosingRule = [
    'Preserve any exact machine-readable closing contract requested by the original task.',
    'Do not claim completion authority unless your role explicitly owns final judgment.',
  ].join('\n');

  const contractSection = formatTaskContract({
    taskId: 'preview',
    surface: 'cli',
    objective: prompt,
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
  const isContractReview = workerId === 'contract-review';
  const reviewPresentationRule = decision.primaryTask === 'review'
    ? 'When the task is review or audit, speak directly to the user about the final review findings. Do not frame the answer as grading or critiquing the Generator.'
    : undefined;

  switch (role) {
    case 'lead':
      return [
        'You are the Lead role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        'Break the work into clear ownership boundaries and success criteria.',
        'Call out the evidence the evaluator should require before accepting the task.',
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
      ].join('\n\n');
    case 'planner':
      return [
        'You are the Planner role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        'Produce a concise execution plan, the critical risks, and the evidence checklist.',
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
      ].join('\n\n');
    case 'generator':
      return [
        'You are the Generator role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        reviewPresentationRule,
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Execute the task or produce the requested deliverable.',
        isTerminalAuthority
          ? 'You are the terminal delivery role for this run. Return the final user-facing answer and summarize concrete evidence inline.'
          : 'Leave final judgment to the evaluator and include a crisp evidence handoff.',
        sharedClosingRule,
      ].join('\n\n');
    case 'worker':
      return [
        'You are a specialist Worker role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Own the implementation work for your assigned slice and report evidence, changed areas, and residual risks.',
        'Do not overstep into evaluator judgment.',
        sharedClosingRule,
      ].join('\n\n');
    case 'validator':
      if (isContractReview) {
        return [
          'You are the Contract Reviewer role for a managed KodaX task.',
          decisionSummary,
          `Original task:\n${prompt}`,
          agentSection,
          contractSection,
          metadataSection,
          verificationSection,
          toolPolicySection,
          'Review the proposed task contract before implementation begins.',
          'Read the dependency handoff artifacts first, especially the structured handoff bundle and any contract files produced by planner or lead.',
          'Approve only if the planned scope, success criteria, required evidence, and constraints are concrete enough to verify.',
          'Use status=revise when the contract needs replanning or tighter success criteria before implementation should start.',
          'Use status=blocked when the task cannot responsibly proceed because key information is missing or contradictory.',
          [
            `Append a final fenced block named \`\`\`${MANAGED_TASK_CONTRACT_REVIEW_BLOCK}\` with this exact shape:`,
            'status: approve|revise|blocked',
            'reason: <one-line reason>',
            'followup:',
            '- <required next step>',
            '- <optional second next step>',
            'Keep the contract review above the block.',
          ].join('\n'),
          sharedClosingRule,
        ].join('\n\n');
      }

      return [
        'You are the Validator role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Independently look for gaps, missing evidence, risky assumptions, and verification needs.',
        'Execute the verification contract directly when it calls for tests, browser checks, or other validation tools.',
        'Treat implementation outputs as suspect until supported by concrete evidence.',
        sharedClosingRule,
      ].join('\n\n');
    case 'evaluator':
      return [
        'You are the Evaluator role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        reviewPresentationRule,
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Judge whether the dependency handoff satisfies the original task and whether the evidence is strong enough.',
        'You own the final verification pass and must personally execute any required checks or browser validation before accepting the task.',
        'Evaluate the task against the verification criteria and thresholds. If any hard threshold is not met, do not accept the task.',
        'Return the final user-facing answer. If the task is not ready, explain the blocker or missing evidence clearly.',
        'If the original task requires an exact closing block, include it in your final answer when you conclude.',
        [
          `Append a final fenced block named \`\`\`${MANAGED_TASK_VERDICT_BLOCK}\` with this exact shape:`,
          `status: accept|revise|blocked`,
          'reason: <one-line reason>',
          'followup:',
          '- <required next step>',
          '- <optional second next step>',
          'Keep the user-facing answer above the block. Use status=revise when more execution should happen before acceptance.',
        ].join('\n'),
      ].join('\n\n');
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
  phase: 'initial' | 'refinement' = 'initial',
): { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] } {
  const evaluatorRequired = qualityAssuranceMode === 'required' || decision.harnessProfile === 'H3_MULTI_WORKER';
  const createWorker = (
    id: string,
    title: string,
    role: KodaXTaskRole,
    isTerminalAuthority: boolean,
    dependsOn?: string[],
    execution?: ManagedTaskWorkerSpec['execution'],
  ): ManagedTaskWorkerSpec => {
    const agent = buildManagedWorkerAgent(role, id);
    const toolPolicy = buildManagedWorkerToolPolicy(role, verification);
    const worker: ManagedTaskWorkerSpec = {
      id,
      title,
      role,
      dependsOn,
      execution,
      agent,
      toolPolicy,
      metadata: {
        role,
        agent,
      },
      prompt: createRolePrompt(role, prompt, decision, verification, toolPolicy, agent, metadata, id, isTerminalAuthority),
    };
    worker.beforeToolExecute = createToolPolicyHook(worker);
    return worker;
  };

  if (phase === 'refinement') {
    if (decision.harnessProfile === 'H3_MULTI_WORKER') {
      return {
        terminalWorkerId: 'evaluator',
        workers: [
          createWorker('lead', 'Lead', 'lead', false),
          createWorker('planner', 'Planner', 'planner', false, ['lead']),
          createWorker('contract-review', 'Contract Reviewer', 'validator', false, ['lead', 'planner']),
          createWorker('worker-implementation', 'Implementation Worker', 'worker', false, ['contract-review'], 'parallel'),
          createWorker('worker-validation', 'Validation Worker', 'validator', false, ['contract-review'], 'parallel'),
          createWorker('evaluator', 'Evaluator', 'evaluator', true, ['lead', 'planner', 'contract-review', 'worker-implementation', 'worker-validation']),
        ],
      };
    }

    if (!evaluatorRequired) {
      return {
        terminalWorkerId: 'generator',
        workers: [
          ...(decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
            ? [createWorker('planner', 'Planner', 'planner', false)]
            : []),
          ...(decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
            ? [createWorker('contract-review', 'Contract Reviewer', 'validator', false, ['planner'])]
            : []),
          createWorker(
            'generator',
            'Generator',
            'generator',
            true,
            decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL' ? ['contract-review'] : undefined,
          ),
        ],
      };
    }

    return {
      terminalWorkerId: 'evaluator',
      workers: [
        ...(decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
          ? [createWorker('planner', 'Planner', 'planner', false)]
          : []),
        ...(decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
          ? [createWorker('contract-review', 'Contract Reviewer', 'validator', false, ['planner'])]
          : []),
        createWorker(
          'generator',
          'Generator',
          'generator',
          false,
          decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL' ? ['contract-review'] : undefined,
        ),
        createWorker(
          'evaluator',
          'Evaluator',
          'evaluator',
          true,
          decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
            ? ['planner', 'contract-review', 'generator']
            : ['generator'],
        ),
      ],
    };
  }

  if (decision.harnessProfile === 'H1_EXECUTE_EVAL') {
    if (!evaluatorRequired) {
      return {
        terminalWorkerId: 'generator',
        workers: [
          createWorker('generator', 'Generator', 'generator', true),
        ],
      };
    }

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
          createWorker('planner', 'Planner', 'planner', false),
          createWorker('contract-review', 'Contract Reviewer', 'validator', false, ['planner']),
          createWorker('generator', 'Generator', 'generator', true, ['contract-review']),
        ],
      };
    }

    return {
      terminalWorkerId: 'evaluator',
      workers: [
        createWorker('planner', 'Planner', 'planner', false),
        createWorker('contract-review', 'Contract Reviewer', 'validator', false, ['planner']),
        createWorker('generator', 'Generator', 'generator', false, ['contract-review']),
        createWorker('evaluator', 'Evaluator', 'evaluator', true, ['planner', 'contract-review', 'generator']),
      ],
    };
  }

  return {
    terminalWorkerId: 'evaluator',
    workers: [
      createWorker('lead', 'Lead', 'lead', false),
      createWorker('planner', 'Planner', 'planner', false, ['lead']),
      createWorker('contract-review', 'Contract Reviewer', 'validator', false, ['lead', 'planner']),
      createWorker('worker-implementation', 'Implementation Worker', 'worker', false, ['contract-review'], 'parallel'),
      createWorker('worker-validation', 'Validation Worker', 'validator', false, ['contract-review'], 'parallel'),
      createWorker('evaluator', 'Evaluator', 'evaluator', true, ['lead', 'planner', 'contract-review', 'worker-implementation', 'worker-validation']),
    ],
  };
}

function createTaskShape(
  options: KodaXOptions,
  prompt: string,
  plan: ReasoningPlan,
): ManagedTaskShape {
  const taskId = `task-${randomUUID()}`;
  const surface = getManagedTaskSurface(options);
  const workspaceDir = path.join(getManagedTaskWorkspaceRoot(options, surface), taskId);
  const createdAt = new Date().toISOString();
  const qualityAssuranceMode = resolveManagedTaskQualityAssuranceMode(options, plan);
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
        objective: prompt,
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
        routingAttempts: plan.decision.routingAttempts,
        routingSource: plan.decision.routingSource,
      },
    };

    return {
      task,
      terminalWorkerId: 'direct',
      workers: [],
      workspaceDir,
      routingPromptOverlay: plan.promptOverlay,
      qualityAssuranceMode: 'required',
      providerPolicy: plan.providerPolicy,
    };
  }

  const workerSet = buildManagedTaskWorkers(
    prompt,
    plan.decision,
    options.context?.taskMetadata,
    normalizedVerification,
    qualityAssuranceMode,
  );
  const task: KodaXManagedTask = {
    contract: {
      taskId,
      surface,
      objective: prompt,
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
      routingAttempts: plan.decision.routingAttempts,
      routingSource: plan.decision.routingSource,
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

function parseManagedTaskVerdictDirective(text: string): ManagedTaskVerdictDirective | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_VERDICT_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  const body = match[1]?.trim() ?? '';
  const visibleText = text.slice(0, match.index ?? text.length).trim();
  let status: ManagedTaskVerdictDirective['status'] | undefined;
  let reason: string | undefined;
  const followups: string[] = [];
  let inFollowups = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.toLowerCase().startsWith('status:')) {
      const candidate = line.slice('status:'.length).trim().toLowerCase();
      if (candidate === 'accept' || candidate === 'revise' || candidate === 'blocked') {
        status = candidate;
      }
      inFollowups = false;
      continue;
    }
    if (line.toLowerCase().startsWith('reason:')) {
      reason = line.slice('reason:'.length).trim();
      inFollowups = false;
      continue;
    }
    if (line.toLowerCase().startsWith('followup:')) {
      inFollowups = true;
      continue;
    }
    if (inFollowups) {
      followups.push(line.replace(/^-+\s*/, '').trim());
    }
  }

  if (!status) {
    return undefined;
  }

  return {
    source: 'evaluator',
    status,
    reason,
    followups: followups.filter(Boolean),
    userFacingText: visibleText,
  };
}

function parseManagedTaskContractReviewDirective(
  text: string,
): ManagedTaskVerdictDirective | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_CONTRACT_REVIEW_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  const body = match[1]?.trim() ?? '';
  const visibleText = text.replace(match[0], '').trim();
  let status: ManagedTaskVerdictDirective['status'] = 'blocked';
  let reason: string | undefined;
  const followups: string[] = [];
  let inFollowups = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const normalized = line.toLowerCase();
    if (normalized.startsWith('status:')) {
      const value = line.slice('status:'.length).trim().toLowerCase();
      if (value === 'approve' || value === 'accept') {
        status = 'accept';
      } else if (value === 'revise') {
        status = 'revise';
      } else {
        status = 'blocked';
      }
      inFollowups = false;
      continue;
    }
    if (normalized.startsWith('reason:')) {
      reason = line.slice('reason:'.length).trim();
      inFollowups = false;
      continue;
    }
    if (normalized.startsWith('followup:')) {
      inFollowups = true;
      continue;
    }
    if (inFollowups) {
      const item = line.replace(/^-+\s*/, '').trim();
      if (item) {
        followups.push(item);
      }
    }
  }

  return {
    source: 'contract-review',
    status,
    reason,
    followups: followups.filter(Boolean),
    userFacingText: visibleText,
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

  const sanitizedText = directive.userFacingText || text;
  return {
    directive,
    result: {
      ...result,
      lastText: sanitizedText,
      messages: replaceLastAssistantMessage(result.messages, sanitizedText),
    },
  };
}

function sanitizeContractReviewResult(
  result: KodaXResult,
): { result: KodaXResult; directive?: ManagedTaskVerdictDirective } {
  const text = extractMessageText(result) || result.lastText;
  const directive = parseManagedTaskContractReviewDirective(text);
  if (!directive) {
    const reason = `Contract review response omitted required ${MANAGED_TASK_CONTRACT_REVIEW_BLOCK} block.`;
    return {
      directive: {
        source: 'contract-review',
        status: 'blocked',
        reason,
        followups: [
          `Re-run contract review and require a final ${MANAGED_TASK_CONTRACT_REVIEW_BLOCK} fenced block with approve, revise, or blocked.`,
        ],
        userFacingText: text,
      },
      result: {
        ...result,
        success: false,
        signal: 'BLOCKED',
        signalReason: reason,
      },
    };
  }

  const sanitizedText = directive.userFacingText || text;
  const baseResult: KodaXResult = {
    ...result,
    lastText: sanitizedText,
    messages: replaceLastAssistantMessage(result.messages, sanitizedText),
  };
  if (directive.status === 'accept') {
    return {
      directive,
      result: {
        ...baseResult,
        success: true,
        signal: result.signal === 'BLOCKED' ? undefined : result.signal,
        signalReason: result.signal === 'BLOCKED' ? undefined : result.signalReason,
      },
    };
  }

  return {
    directive,
    result: {
      ...baseResult,
      success: false,
      signal: directive.status === 'blocked' ? 'BLOCKED' : result.signal,
      signalReason: directive.reason ?? result.signalReason,
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
    `${feedback.source === 'contract-review' ? 'Contract review' : 'Evaluator'} feedback after round ${round - 1}:`,
    feedback.artifactPath
      ? `Previous round feedback artifact: ${feedback.artifactPath}`
      : undefined,
    feedback.reason ? `Reason: ${feedback.reason}` : undefined,
    feedback.followups.length > 0
      ? ['Required follow-up:', ...feedback.followups.map((item) => `- ${item}`)].join('\n')
      : undefined,
    feedback.userFacingText
      ? `Prior findings preview:\n${truncateText(feedback.userFacingText, 1200)}`
      : undefined,
  ].filter((section): section is string => Boolean(section && section.trim()));

  return sections.join('\n\n');
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
      followups: directive.followups,
      userFacingText: directive.userFacingText,
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    markdownPath,
    [
      `# ${directive.source === 'contract-review' ? 'Contract Review' : 'Evaluator'} Feedback`,
      '',
      `- Status: ${directive.status}`,
      directive.reason ? `- Reason: ${directive.reason}` : undefined,
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
): KodaXEvents | undefined {
  if (!baseEvents) {
    return undefined;
  }

  if (forwardStream) {
    return undefined;
  }

  let textPrefixed = false;
  let thinkingPrefixed = false;
  const prefix = `[${worker.title}] `;
  const thinkingPrefix = `[${worker.title} thinking] `;

  return {
    askUser: baseEvents.askUser,
    onTextDelta: (text) => {
      if (!text) {
        return;
      }
      const rendered = textPrefixed ? text : `${prefix}${text}`;
      textPrefixed = true;
      baseEvents.onTextDelta?.(rendered);
    },
    onThinkingDelta: (text) => {
      if (!text) {
        return;
      }
      const rendered = thinkingPrefixed ? text : `${thinkingPrefix}${text}`;
      thinkingPrefixed = true;
      baseEvents.onThinkingDelta?.(rendered);
    },
    onThinkingEnd: (thinking) => {
      baseEvents.onThinkingEnd?.(`${prefix}${thinking}`);
      thinkingPrefixed = false;
    },
    onToolUseStart: (tool) => {
      baseEvents.onToolUseStart?.({
        ...tool,
        name: `${worker.title}:${tool.name}`,
      });
    },
    onToolResult: (result) => {
      baseEvents.onToolResult?.({
        ...result,
        name: `${worker.title}:${result.name}`,
      });
    },
    onToolInputDelta: (toolName, partialJson) => {
      baseEvents.onToolInputDelta?.(`${worker.title}:${toolName}`, partialJson);
    },
    onRetry: baseEvents.onRetry,
    onProviderRateLimit: baseEvents.onProviderRateLimit,
    onError: baseEvents.onError,
    onStreamEnd: () => {
      if (textPrefixed) {
        baseEvents.onTextDelta?.('\n');
      }
      if (thinkingPrefixed) {
        baseEvents.onThinkingDelta?.('\n');
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

async function captureManagedTaskRepoIntelligence(
  options: KodaXOptions,
  workspaceDir: string,
): Promise<ManagedTaskRepoIntelligenceSnapshot> {
  const executionCwd = options.context?.executionCwd?.trim();
  const gitRoot = options.context?.gitRoot?.trim();
  if (!executionCwd && !gitRoot) {
    return { artifacts: [] };
  }

  const repoContext = {
    executionCwd: executionCwd ?? gitRoot ?? process.cwd(),
    gitRoot: gitRoot ?? undefined,
  };
  const repoSnapshotDir = path.join(workspaceDir, 'repo-intelligence');
  await mkdir(repoSnapshotDir, { recursive: true });

  const artifacts: KodaXTaskEvidenceArtifact[] = [];
  const summarySections: string[] = [];

  const activeModuleTargetPath = executionCwd ? '.' : undefined;

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
    try {
      const moduleContext = await getModuleContext(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: false,
      });
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
      const impactEstimate = await getImpactEstimate(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: false,
      });
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
    artifacts.unshift({
      kind: 'markdown',
      path: summaryPath,
      description: 'Task-scoped repository intelligence summary',
    });
  }

  return { artifacts };
}

async function attachManagedTaskRepoIntelligence(
  options: KodaXOptions,
  task: KodaXManagedTask,
): Promise<KodaXManagedTask> {
  const snapshot = await captureManagedTaskRepoIntelligence(options, task.evidence.workspaceDir);
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
): KodaXOptions {
  worker.memoryStrategy = memoryStrategy;
  worker.budgetSnapshot = budgetSnapshot;
  const compactInitialMessages = memoryStrategy === 'compact' && sessionStorage instanceof ManagedWorkerSessionStorage
    ? buildCompactInitialMessages(task, worker, sessionStorage, budgetSnapshot?.currentRound ?? 1)
    : undefined;
  const roleEvents = createWorkerEvents(defaultOptions.events, worker, worker.id === terminalWorkerId);
  return {
    ...defaultOptions,
    maxIter: budgetSnapshot?.softMaxIter ?? defaultOptions.maxIter,
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
      role: task.roleAssignments.find((item) => item.id === completed.id)?.role ?? 'worker',
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

async function writeManagedTaskArtifacts(
  workspaceDir: string,
  task: KodaXManagedTask,
  result: Pick<KodaXResult, 'success' | 'lastText' | 'sessionId' | 'signal' | 'signalReason'>,
  directive?: ManagedTaskVerdictDirective,
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

function buildFallbackManagedResult(
  task: KodaXManagedTask,
  workerResults: Map<string, KodaXResult>,
  terminalWorkerId: string,
): KodaXResult {
  const terminalResult = workerResults.get(terminalWorkerId);
  if (terminalResult) {
    const finalText = extractMessageText(terminalResult) || terminalResult.lastText || task.verdict.summary;
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
    const finalText = extractMessageText(fallbackResult) || fallbackResult.lastText || task.verdict.summary;
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
    lastText: task.verdict.summary,
    signal: task.verdict.signal ?? (task.verdict.status === 'blocked' ? 'BLOCKED' : undefined),
    signalReason: task.verdict.signalReason,
    messages: [
      {
        role: 'assistant',
        content: task.verdict.summary,
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

function buildProtocolRetryPrompt(
  prompt: string,
  worker: ManagedTaskWorkerSpec,
  reason: string,
): string {
  return [
    prompt,
    [
      '[Managed Task Protocol Retry]',
      `Previous ${worker.title} output could not be safely consumed: ${reason}`,
      'Re-run the same role, keep the user-facing content, and append the required structured closing block exactly once at the end.',
    ].join('\n'),
  ].join('\n\n');
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
  if (controller.reserveRemaining <= 0) {
    return { granted: 0, reason: 'No reserve budget remains for extension.' };
  }
  if (request.confidenceToFinish < 0.55) {
    return { granted: 0, reason: 'Extension request confidence was too low to auto-approve.' };
  }
  const granted = Math.min(request.requestedIters, 3, controller.reserveRemaining);
  if (granted <= 0) {
    return { granted: 0, reason: 'Requested extension exceeds remaining reserve.' };
  }
  return { granted };
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
  let extensionUsed = false;

  while (attempts < MANAGED_TASK_ROUTER_MAX_RETRIES) {
    attempts += 1;
    const result = attempts === 1
      ? await executeDefault()
      : await runDirectKodaX(preparedOptions, currentPrompt);
    lastResult = result;

    const text = extractMessageText(result) || result.lastText;
    const needsVerdict = worker.role === 'evaluator';
    const needsContractReview = worker.id === 'contract-review';
    const needsContract = worker.role === 'planner' || worker.role === 'lead';
    const missingProtocol =
      (needsVerdict && !parseManagedTaskVerdictDirective(text))
      || (needsContractReview && !parseManagedTaskContractReviewDirective(text))
      || (needsContract && !parseManagedTaskContractDirective(text));

    if (missingProtocol && attempts < MANAGED_TASK_ROUTER_MAX_RETRIES) {
      currentPrompt = buildProtocolRetryPrompt(
        prompt,
        worker,
        needsVerdict
          ? `missing ${MANAGED_TASK_VERDICT_BLOCK}`
          : needsContractReview
            ? `missing ${MANAGED_TASK_CONTRACT_REVIEW_BLOCK}`
            : `missing ${MANAGED_TASK_CONTRACT_BLOCK}`,
      );
      continue;
    }

    const budgetRequest = parseBudgetExtensionRequest(text);
    if (budgetRequest && !extensionUsed) {
      const extension = shouldGrantBudgetExtension(controller, worker, budgetRequest);
      if (extension.granted > 0 && attempts < MANAGED_TASK_ROUTER_MAX_RETRIES) {
        extensionUsed = true;
        controller.reserveRemaining -= extension.granted;
        currentPrompt = [
          prompt,
          '[Managed Task Budget Extension Approved]',
          `You were granted ${extension.granted} additional iterations. Finish the task now and avoid opening new exploration branches.`,
        ].join('\n\n');
        preparedOptions.maxIter = (preparedOptions.maxIter ?? worker.budgetSnapshot?.softMaxIter ?? 8) + extension.granted;
        worker.budgetSnapshot = {
          ...(worker.budgetSnapshot ?? createBudgetSnapshot(controller, 'H1_EXECUTE_EVAL', 1, worker.role, worker.id)),
          extensionGrantedIters: extension.granted,
          reserveRemaining: controller.reserveRemaining,
        };
        continue;
      }
      return {
        result,
        budgetRequest,
        budgetExtensionGranted: extension.granted,
        budgetExtensionReason: extension.reason,
      };
    }

    return { result };
  }

  return {
    result: lastResult ?? await executeDefault(),
  };
}

function createManagedOrchestrationEvents(
  baseEvents: KodaXEvents | undefined,
): OrchestrationRunEvents<ManagedTaskWorkerSpec, string> | undefined {
  if (!baseEvents?.onTextDelta) {
    return undefined;
  }

  return {
    onTaskStart: async (task) => {
      baseEvents.onTextDelta?.(`\n[${task.title}] starting\n`);
    },
    onTaskMessage: async (task, message) => {
      baseEvents.onTextDelta?.(`\n[${task.title}] ${message}\n`);
    },
    onTaskComplete: async (task, completed) => {
      baseEvents.onTextDelta?.(`\n[${task.title}] ${completed.status}: ${completed.result.summary ?? 'No summary available.'}\n`);
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
  round: number,
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
        : worker.id === 'contract-review'
          ? sanitizeContractReviewResult(result)
          : { result };
      workerResults.set(worker.id, sanitized.result);
      if (sessionStorage instanceof ManagedWorkerSessionStorage) {
        sessionStorage.saveMemoryNote(
          buildManagedWorkerSessionId(task, worker),
          buildManagedWorkerMemoryNote(task, worker, sanitized.result, round),
        );
      }
      if (worker.role === 'lead' || worker.role === 'planner') {
        const contractDirective = parseManagedTaskContractDirective(
          extractMessageText(sanitized.result) || sanitized.result.lastText,
        );
        if (contractDirective) {
          contractDirectives.set(worker.id, contractDirective);
        }
      }
      if (worker.id === workerSet.terminalWorkerId) {
        directive = sanitized.directive;
      }
      if (worker.id === 'contract-review' && sanitized.directive?.status !== 'accept') {
        directive = sanitized.directive;
      }
      return sanitized.result;
    },
  });

  const orchestrationResult = await runOrchestration<ManagedTaskWorkerSpec, string>({
    runId,
    workspaceDir,
    maxParallel: task.contract.harnessProfile === 'H3_MULTI_WORKER' ? 2 : 1,
    tasks: workerSet.workers,
    signal: options.abortSignal,
    runner: async (worker, context) => {
      await context.emit(`Launching ${worker.title}`);
      return managedWorkerRunner(worker, context);
    },
    events: createManagedOrchestrationEvents(options.events),
  });

  return {
    workerSet,
    workerResults,
    contractDirectives,
    orchestrationResult,
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

  if (directive.status === 'accept') {
    return {
      ...task,
      verdict: {
        ...task.verdict,
        summary: directive.userFacingText || task.verdict.summary,
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
      summary: directive.userFacingText || task.verdict.summary,
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

  const selectedAssignmentId = task.contract.harnessProfile === 'H3_MULTI_WORKER'
    ? (directives.has('planner') ? 'planner' : directives.has('lead') ? 'lead' : undefined)
    : (directives.has('planner') ? 'planner' : directives.has('lead') ? 'lead' : undefined);
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

export async function runManagedTask(
  options: KodaXOptions,
  prompt: string,
): Promise<KodaXResult> {
  const agentMode = resolveManagedAgentMode(options);
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
  const plan = applyAgentModeToPlan(managedPlanning.plan, agentMode);
  const shape = createTaskShape(managedOptions, prompt, plan);
  const budgetController = createManagedBudgetController(managedOptions, plan, agentMode);
  const sessionStorage = new ManagedWorkerSessionStorage();
  await mkdir(shape.workspaceDir, { recursive: true });
  shape.task = await attachManagedTaskRepoIntelligence(managedOptions, shape.task);
  shape.task = {
    ...shape.task,
    runtime: {
      ...shape.task.runtime,
      budget: createBudgetSnapshot(budgetController, shape.task.contract.harnessProfile, 0, undefined),
      routingAttempts: plan.decision.routingAttempts,
      routingSource: plan.decision.routingSource,
      scorecard: createVerificationScorecard(shape.task, undefined),
    },
  };

  if (shape.task.contract.harnessProfile === 'H0_DIRECT') {
    const directOptions: KodaXOptions = {
      ...managedOptions,
      context: {
        ...managedOptions.context,
        taskSurface: shape.task.contract.surface,
        managedTaskWorkspaceDir: shape.workspaceDir,
        taskMetadata: shape.task.contract.metadata,
        taskVerification: shape.task.contract.verification,
        promptOverlay: [
          shape.routingPromptOverlay,
          managedOptions.context?.promptOverlay,
          '[Managed Task] direct execution path.',
          formatTaskMetadata(shape.task.contract.metadata),
          formatVerificationContract(shape.task.contract.verification),
        ].filter(Boolean).join('\n\n'),
      },
    };
    const result = await runDirectKodaX(directOptions, prompt);
    const managedTask = applyDirectResultToTask(shape.task, result);
    await writeManagedTaskArtifacts(shape.workspaceDir, managedTask, {
      success: result.success,
      lastText: extractMessageText(result),
      sessionId: result.sessionId,
      signal: result.signal,
      signalReason: result.signalReason,
    });
    return mergeManagedTaskIntoResult(
      {
        ...result,
        lastText: extractMessageText(result) || result.lastText,
        routingDecision: result.routingDecision ?? plan.decision,
      },
      managedTask,
    );
  }

  let managedTask = shape.task;
  let roundDirective: ManagedTaskVerdictDirective | undefined;
  let roundExecution: ManagedTaskRoundExecution | undefined;
  const maxRounds = resolveManagedTaskMaxRounds(managedOptions, plan, agentMode);
  managedOptions.events?.onTextDelta?.(
    `\n[Managed Task] quality assurance mode=${shape.qualityAssuranceMode}\n`,
  );
  if (maxRounds > 1) {
    managedOptions.events?.onTextDelta?.(
      `\n[Managed Task] adaptive round budget=${maxRounds} for harness=${plan.decision.harnessProfile}; totalBudget=${budgetController.totalBudget}; reserve=${budgetController.reserveBudget}\n`,
    );
  }

  for (let round = 1; round <= maxRounds; round += 1) {
    const roundPrompt = buildManagedRoundPrompt(prompt, round, roundDirective);
    const workerSet = round === 1
      ? { terminalWorkerId: shape.terminalWorkerId, workers: shape.workers }
      : buildManagedTaskWorkers(
        roundPrompt,
        plan.decision,
        managedOptions.context?.taskMetadata,
        managedOptions.context?.taskVerification,
        shape.qualityAssuranceMode,
        'refinement',
      );
    const roundWorkspaceDir = path.join(shape.workspaceDir, 'rounds', `round-${String(round).padStart(2, '0')}`);
    if (round > 1) {
      managedOptions.events?.onTextDelta?.(`\n[Managed Task] starting refinement round ${round}\n`);
    }
    budgetController.spentBudget = clampNumber(
      Math.round(((round - 1) / Math.max(1, maxRounds)) * (budgetController.totalBudget - budgetController.reserveRemaining)),
      0,
      budgetController.totalBudget,
    );
    managedTask = {
      ...managedTask,
      runtime: {
        ...managedTask.runtime,
        budget: createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, round, undefined),
      },
    };
    roundExecution = await executeManagedTaskRound(
      managedOptions,
      managedTask,
      workerSet,
      roundWorkspaceDir,
      `${shape.task.contract.taskId}-round-${round}`,
      shape.routingPromptOverlay,
      shape.qualityAssuranceMode,
      budgetController,
      round,
      plan,
      sessionStorage,
      roundDirective,
    );
    managedTask = applyOrchestrationResultToTask(
      managedTask,
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
        ...managedTask.runtime,
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

    roundDirective = roundExecution.directive;
    if (roundDirective) {
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
          ...managedTask.runtime,
          budget: {
            ...createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, round, undefined),
            extensionDenied: true,
            extensionReason: roundExecution.budgetExtensionReason ?? roundExecution.budgetRequest.reason,
          },
        },
      };
      roundDirective = {
        source: 'evaluator',
        status: 'blocked',
        reason: roundExecution.budgetExtensionReason ?? roundExecution.budgetRequest.reason,
        followups: [roundExecution.budgetRequest.fallbackIfDenied],
        userFacingText: managedTask.verdict.summary,
      };
      break;
    }
    if (roundDirective?.status === 'revise' && round < maxRounds) {
      managedOptions.events?.onTextDelta?.(
        `\n[Managed Task] ${roundDirective.source === 'contract-review' ? 'contract review' : 'evaluator'} requested another pass: ${roundDirective.reason ?? 'additional evidence required.'}\n`,
      );
      continue;
    }
    break;
  }

  managedTask = applyManagedTaskDirective(managedTask, roundDirective);
  managedTask = {
    ...managedTask,
    runtime: {
      ...managedTask.runtime,
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

  return mergeManagedTaskIntoResult(
    {
      ...result,
      routingDecision: result.routingDecision ?? plan.decision,
    },
    managedTask,
  );
}
