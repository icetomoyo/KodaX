import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
import { runKodaX as runDirectKodaX } from './agent.js';
import {
  createKodaXTaskRunner,
  runOrchestration,
  type KodaXAgentWorkerSpec,
  type OrchestrationCompletedTask,
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
  getFanoutBranch,
} from './fanout-scheduler.js';
import {
  analyzeChangedScope,
  getRepoOverview,
  renderChangedScope,
  renderRepoOverview,
} from './repo-intelligence/index.js';
import { debugLogRepoIntelligence } from './repo-intelligence/internal.js';
// FEATURE_067 v2: Child agents are now dispatched via dispatch_child_task tool.
// Only collectWriteChildDiffs and buildEvaluatorMergePrompt are used (dynamically imported).
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
import { filterRepoIntelligenceWorkingToolNames, isRepoIntelligenceWorkingToolName, MCP_TOOL_NAMES } from './tools/index.js';
import {
  hydrateManagedProtocolPayloadVisibleText,
  MANAGED_PROTOCOL_TOOL_NAME,
  MANAGED_TASK_CONTRACT_BLOCK,
  MANAGED_TASK_HANDOFF_BLOCK,
  MANAGED_TASK_SCOUT_BLOCK,
  MANAGED_TASK_VERDICT_BLOCK,
  mergeManagedProtocolPayload,
  normalizeManagedDirectCompletionReady,
} from './managed-protocol.js';
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
  KodaXManagedLiveEvent,
  KodaXManagedTaskRuntimeState,
  KodaXManagedBudgetSnapshot,
  KodaXManagedContractPayload,
  KodaXManagedHandoffPayload,
  KodaXManagedProtocolPayload,
  KodaXManagedScoutPayload,
  KodaXManagedTaskStatusEvent,
  KodaXManagedVerdictPayload,
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
  ManagedMutationTracker,
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

type ManagedTaskVerdictDirective = KodaXManagedVerdictPayload;

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

type ManagedTaskScoutDirective = KodaXManagedScoutPayload;
type ManagedTaskContractDirective = KodaXManagedContractPayload;
type ManagedTaskHandoffDirective = KodaXManagedHandoffPayload;

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

interface TacticalLookupShard {
  id: string;
  question: string;
  scope: string;
  priority: 'high' | 'medium' | 'low';
  paths: string[];
  rationale: string[];
}

interface TacticalLookupShardsDirective {
  summary: string;
  shards: TacticalLookupShard[];
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
  handoffDirectives: Map<string, ManagedTaskHandoffDirective>;
  orchestrationResult: OrchestrationRunResult<ManagedTaskWorkerSpec, string>;
  taskSnapshot: KodaXManagedTask;
  workspaceDir: string;
  directive?: ManagedTaskVerdictDirective;
  budgetRequest?: KodaXBudgetExtensionRequest;
  budgetExtensionGranted?: number;
  budgetExtensionReason?: string;
  /** FEATURE_067 v2: Worktree paths from write fan-out, for post-round cleanup. */
  childWriteWorktreePaths?: ReadonlyMap<string, string>;
}

type ManagedTaskQualityAssuranceMode = 'required' | 'optional';

// FEATURE_062: Simplified budget controller — 2 core fields (totalBudget/spentBudget) + harness state.
interface ManagedTaskBudgetController {
  totalBudget: number;
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

function normalizeManagedVerdictStatus(candidate: string): ManagedTaskVerdictDirective['status'] | undefined {
  const trimmed = candidate.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed
    .replace(/[`"'()[\]{}<>]+/g, '')
    .replace(/[.:;!?]+$/g, '')
    .replace(/[_\s-]+/g, ' ')
    .trim();
  const firstToken = normalized.split(/\s+/, 1)[0] ?? '';
  if (!firstToken) {
    return undefined;
  }

  if (/^accept(?:ed|s|ing)?$/.test(firstToken) || firstToken === 'approve' || firstToken === 'approved') {
    return 'accept';
  }
  if (/^revis(?:e|ed|es|ing)?$/.test(firstToken)) {
    return 'revise';
  }
  if (/^block(?:ed|ing)?$/.test(firstToken)) {
    return 'blocked';
  }
  return undefined;
}

function normalizeManagedNextHarness(
  candidate: string,
): ManagedTaskVerdictDirective['nextHarness'] | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed
    .replace(/[`"'()[\]{}<>]+/g, '')
    .replace(/[.:;!?]+$/g, '')
    .replace(/[\s-]+/g, '_')
    .trim()
    .toUpperCase();
  if (normalized === 'H1_EXECUTE_EVAL' || normalized === 'H1') {
    return 'H1_EXECUTE_EVAL';
  }
  if (normalized === 'H2_PLAN_EXECUTE_EVAL' || normalized === 'H2') {
    return 'H2_PLAN_EXECUTE_EVAL';
  }
  return undefined;
}

function normalizeManagedScoutHarness(
  candidate: string,
): ManagedTaskScoutDirective['confirmedHarness'] | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed
    .replace(/[`"'()[\]{}<>]+/g, '')
    .replace(/[.:;!?]+$/g, '')
    .replace(/[\s-]+/g, '_')
    .trim()
    .toUpperCase();
  if (normalized === 'H0_DIRECT' || normalized === 'H0') {
    return 'H0_DIRECT';
  }
  if (normalized === 'H1_EXECUTE_EVAL' || normalized === 'H1') {
    return 'H1_EXECUTE_EVAL';
  }
  if (normalized === 'H2_PLAN_EXECUTE_EVAL' || normalized === 'H2') {
    return 'H2_PLAN_EXECUTE_EVAL';
  }
  return undefined;
}

function normalizeManagedHandoffStatus(
  candidate: string,
): ManagedTaskHandoffDirective['status'] | undefined {
  const trimmed = candidate.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed
    .replace(/[`"'()[\]{}<>]+/g, '')
    .replace(/[.:;!?]+$/g, '')
    .replace(/[_\s-]+/g, ' ')
    .trim();
  const firstToken = normalized.split(/\s+/, 1)[0] ?? '';
  if (!firstToken) {
    return undefined;
  }
  if (/^ready$/.test(firstToken)) {
    return 'ready';
  }
  if (/^incomplete$/.test(firstToken) || /^partial(?:ly)?$/.test(firstToken)) {
    return 'incomplete';
  }
  if (/^block(?:ed|ing)?$/.test(firstToken) || /^failed?$/.test(firstToken)) {
    return 'blocked';
  }
  return undefined;
}

function normalizeManagedEvidenceAcquisitionMode(
  candidate: string,
): ManagedTaskScoutDirective['evidenceAcquisitionMode'] | undefined {
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/[`"'()[\]{}<>]+/g, '')
    .replace(/[.:;!?]+$/g, '')
    .replace(/[_\s-]+/g, '-')
    .trim();
  if (normalized === 'overview') {
    return 'overview';
  }
  if (normalized === 'diff-bundle' || normalized === 'bundle') {
    return 'diff-bundle';
  }
  if (normalized === 'diff-slice' || normalized === 'slice') {
    return 'diff-slice';
  }
  if (normalized === 'file-read' || normalized === 'read') {
    return 'file-read';
  }
  return undefined;
}

function normalizeManagedProjectionConfidence(
  candidate: string,
): KodaXSkillMap['projectionConfidence'] | undefined {
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/[`"'()[\]{}<>]+/g, '')
    .replace(/[.:;!?]+$/g, '')
    .trim();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return undefined;
}

function normalizeStringListValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((item) => item.replace(/^-+\s*/, '').trim())
      .filter(Boolean);
  }
  return [];
}

function findLastFencedBlock(
  text: string,
  blockName: string,
): { body: string; index: number } | undefined {
  const pattern = new RegExp(String.raw`\`\`\`${blockName}\s*([\s\S]*?)\`\`\``, 'ig');
  let lastMatch: RegExpExecArray | undefined;
  for (;;) {
    const match = pattern.exec(text);
    if (!match) {
      break;
    }
    lastMatch = match;
  }
  if (!lastMatch) {
    return undefined;
  }
  return {
    body: lastMatch[1]?.trim() ?? '',
    index: lastMatch.index,
  };
}

function parseManagedTaskVerdictDirectiveFromJson(
  body: string,
  visibleText: string,
): ManagedTaskVerdictDirective | undefined {
  let parsed: {
    status?: string;
    reason?: string;
    user_answer?: string;
    userAnswer?: string;
    next_harness?: string;
    nextHarness?: string;
    followup?: string[] | string;
    followups?: string[] | string;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const status = parsed?.status ? normalizeManagedVerdictStatus(String(parsed.status)) : undefined;
  if (!status) {
    return undefined;
  }
  const nextHarnessCandidate = parsed.next_harness ?? parsed.nextHarness;
  const followupValue = parsed.followup ?? parsed.followups;
  const followups = Array.isArray(followupValue)
    ? followupValue.map((item) => String(item).trim()).filter(Boolean)
    : typeof followupValue === 'string'
      ? followupValue.split(/\r?\n/).map((item) => item.replace(/^-+\s*/, '').trim()).filter(Boolean)
      : [];
  return {
    source: 'evaluator',
    status,
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim() || undefined : undefined,
    nextHarness: nextHarnessCandidate ? normalizeManagedNextHarness(String(nextHarnessCandidate)) : undefined,
    followups,
    userFacingText: visibleText,
    userAnswer: typeof parsed.user_answer === 'string'
      ? parsed.user_answer.trim() || undefined
      : typeof parsed.userAnswer === 'string'
        ? parsed.userAnswer.trim() || undefined
        : undefined,
  };
}

function buildManagedProtocolFailureVisibleText(
  worker: ManagedTaskWorkerSpec,
  reason: string,
  rawText: string,
): string {
  const publicReason = summarizeManagedProtocolFailureReason(reason);
  const sanitized = worker.role === 'evaluator'
    ? sanitizeEvaluatorPublicAnswer(rawText)
    : sanitizeManagedUserFacingText(rawText);
  const excerpt = truncateText(sanitized || 'No user-facing content could be safely recovered from the worker output.', 1600);
  return [
    `${worker.title} output could not be consumed: ${publicReason}.`,
    '',
    'Recovered visible excerpt:',
    excerpt,
  ].join('\n');
}

function resolveManagedProtocolFailureReasons(reason: string): { publicReason: string; debugReason: string } {
  const normalized = reason.trim();
  if (!normalized) {
    return {
      publicReason: 'required structured completion data was missing',
      debugReason: 'No protocol failure reason was provided.',
    };
  }

  if (
    normalized.includes(MANAGED_PROTOCOL_TOOL_NAME)
    || normalized.includes(MANAGED_TASK_VERDICT_BLOCK)
    || normalized.includes(MANAGED_TASK_CONTRACT_BLOCK)
    || normalized.includes(MANAGED_TASK_SCOUT_BLOCK)
    || normalized.includes(MANAGED_TASK_HANDOFF_BLOCK)
  ) {
    if (/verdict|evaluator/i.test(normalized)) {
      return {
        publicReason: 'required structured verification data was missing',
        debugReason: normalized,
      };
    }
    return {
      publicReason: 'required structured completion data was missing',
      debugReason: normalized,
    };
  }

  return {
    publicReason: normalized,
    debugReason: normalized,
  };
}

function summarizeManagedProtocolFailureReason(reason: string): string {
  return resolveManagedProtocolFailureReasons(reason).publicReason;
}

function compactManagedProtocolFailureResult(
  result: KodaXResult,
  worker: ManagedTaskWorkerSpec,
  reason: string,
): { result: KodaXResult; visibleText: string; rawText: string } {
  const rawText = result.protocolRawText || extractMessageText(result) || result.lastText;
  const visibleText = buildManagedProtocolFailureVisibleText(worker, reason, rawText);
  const { publicReason, debugReason } = resolveManagedProtocolFailureReasons(reason);
  return {
    rawText,
    visibleText,
    result: {
      ...result,
      success: false,
      signal: 'BLOCKED',
      signalReason: `${worker.title} output could not be consumed: ${publicReason}.`,
      signalDebugReason: `${worker.title} output could not be consumed: ${debugReason}.`,
      protocolRawText: rawText,
      lastText: visibleText,
      messages: replaceLastAssistantMessage(result.messages, visibleText),
    },
  };
}

function buildVerificationDegradedVisibleText(
  baseText: string,
  reason: string,
): string {
  const normalizedBase = baseText.trim();
  const note = `Verification degraded: ${reason}`;
  if (!normalizedBase) {
    return note;
  }
  return normalizedBase.includes(note) ? normalizedBase : `${normalizedBase}\n\n${note}`;
}

function withManagedProtocolPayload(
  result: KodaXResult,
  payload: Partial<KodaXManagedProtocolPayload>,
): KodaXResult {
  const mergedPayload = mergeManagedProtocolPayload(result.managedProtocolPayload, payload);
  return {
    ...result,
    managedProtocolPayload: mergedPayload,
  };
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
  /** FEATURE_067: Evaluator review prompt for write fan-out diffs from Generator's child agents. */
  childWriteReviewPrompt?: string;
}

// NOTE: When adding a new kodax-* fence block name, also add it to
// MANAGED_FENCE_NAMES (near sanitizeManagedUserFacingText) so that
// truncated versions are correctly stripped from user-facing output.
const TACTICAL_REVIEW_FINDINGS_BLOCK = 'kodax-review-findings';
const TACTICAL_INVESTIGATION_SHARDS_BLOCK = 'kodax-investigation-shards';
const TACTICAL_LOOKUP_SHARDS_BLOCK = 'kodax-lookup-shards';
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

// FEATURE_071: Worker Checkpoint & Mid-Execution Recovery
const CHECKPOINT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const CHECKPOINT_FILE = 'checkpoint.json';

interface ManagedTaskCheckpoint {
  version: 1;
  taskId: string;
  createdAt: string;
  gitCommit: string;
  objective: string;
  harnessProfile: KodaXHarnessProfile;
  currentRound: number;
  completedWorkerIds: string[];
  scoutCompleted: boolean;
}

interface ValidatedCheckpoint {
  checkpoint: ManagedTaskCheckpoint;
  workspaceDir: string;
  managedTask: KodaXManagedTask;
}

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

// FEATURE_071: Checkpoint utility functions

async function getGitHeadCommit(gitRoot: string | undefined | null): Promise<string | undefined> {
  const cwd = path.resolve(gitRoot?.trim() || process.cwd());
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function writeCheckpoint(
  workspaceDir: string,
  checkpoint: ManagedTaskCheckpoint,
): Promise<void> {
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, CHECKPOINT_FILE),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    'utf8',
  );
}

async function deleteCheckpoint(workspaceDir: string): Promise<void> {
  try {
    await unlink(path.join(workspaceDir, CHECKPOINT_FILE));
  } catch {
    // Checkpoint may already be gone — safe to ignore.
  }
}

async function findValidCheckpoint(
  options: KodaXOptions,
): Promise<ValidatedCheckpoint | undefined> {
  const gitRoot = options.context?.gitRoot;
  const surface = getManagedTaskSurface(options);
  const root = getManagedTaskWorkspaceRoot(options, surface);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return undefined;
  }

  const currentCommit = await getGitHeadCommit(gitRoot);
  const now = Date.now();

  for (const entry of entries) {
    const workspaceDir = path.join(root, entry);
    const checkpointPath = path.join(workspaceDir, CHECKPOINT_FILE);
    try {
      const fileStat = await stat(checkpointPath);
      if (!fileStat.isFile()) {
        continue;
      }
      const raw = await readFile(checkpointPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }
      const candidate = parsed as Record<string, unknown>;
      if (
        candidate.version !== 1
        || typeof candidate.taskId !== 'string'
        || typeof candidate.createdAt !== 'string'
        || typeof candidate.gitCommit !== 'string'
        || typeof candidate.harnessProfile !== 'string'
      ) {
        continue;
      }
      const checkpoint: ManagedTaskCheckpoint = {
        version: 1,
        taskId: candidate.taskId,
        createdAt: candidate.createdAt,
        gitCommit: candidate.gitCommit,
        objective: typeof candidate.objective === 'string' ? candidate.objective : '',
        harnessProfile: candidate.harnessProfile as KodaXHarnessProfile,
        currentRound: typeof candidate.currentRound === 'number' ? candidate.currentRound : 1,
        completedWorkerIds: Array.isArray(candidate.completedWorkerIds)
          ? (candidate.completedWorkerIds as unknown[]).filter((v): v is string => typeof v === 'string')
          : [],
        scoutCompleted: candidate.scoutCompleted === true,
      };
      // Validate age
      const createdTime = new Date(checkpoint.createdAt).getTime();
      if (Number.isNaN(createdTime)) {
        continue;
      }
      const age = now - createdTime;
      if (age > CHECKPOINT_MAX_AGE_MS || age < 0) {
        // Auto-clean expired checkpoints to prevent accumulation.
        await deleteCheckpoint(workspaceDir);
        continue;
      }
      // Validate git commit — code has changed since checkpoint, context is stale.
      if (currentCommit && checkpoint.gitCommit && checkpoint.gitCommit !== currentCommit) {
        await deleteCheckpoint(workspaceDir);
        continue;
      }
      // Load the managed task snapshot
      const managedTaskPath = path.join(workspaceDir, 'managed-task.json');
      const taskRaw = await readFile(managedTaskPath, 'utf8');
      const taskParsed: unknown = JSON.parse(taskRaw);
      if (!taskParsed || typeof taskParsed !== 'object') {
        continue;
      }
      const managedTask = taskParsed as KodaXManagedTask;
      if (!managedTask.contract?.taskId || !managedTask.evidence?.workspaceDir) {
        continue;
      }
      return { checkpoint, workspaceDir, managedTask };
    } catch {
      continue;
    }
  }
  return undefined;
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

// FEATURE_062: Simplified — just cap + used + harness state.
function createManagedBudgetController(
  _options: KodaXOptions,
  plan: ReasoningPlan,
  agentMode: KodaXAgentMode,
): ManagedTaskBudgetController {
  const isH0 = agentMode !== 'ama' || plan.decision.harnessProfile === 'H0_DIRECT';
  return {
    totalBudget: isH0 ? MANAGED_TASK_BUDGET_BASE.H0_DIRECT : MANAGED_TASK_BUDGET_BASE[plan.decision.harnessProfile],
    spentBudget: 0,
    currentHarness: isH0 ? 'H0_DIRECT' : plan.decision.harnessProfile,
    upgradeCeiling: isH0 ? undefined : plan.decision.upgradeCeiling,
  };
}

// FEATURE_062: Simplified snapshot — zone derived from used/cap ratio, no per-role iter limits.
function createBudgetSnapshot(
  controller: ManagedTaskBudgetController,
  harness: KodaXTaskRoutingDecision['harnessProfile'],
  round: number,
  role: KodaXTaskRole | undefined,
  workerId?: string,
): KodaXManagedBudgetSnapshot {
  const remaining = Math.max(0, controller.totalBudget - controller.spentBudget);
  const pct = controller.totalBudget > 0 ? controller.spentBudget / controller.totalBudget : 0;
  const zone: KodaXBudgetDisclosureZone = pct < 0.7 ? 'green' : pct < 0.85 ? 'yellow' : pct < 0.95 ? 'orange' : 'red';
  return {
    totalBudget: controller.totalBudget,
    reserveBudget: 0,
    reserveRemaining: 0,
    upgradeReserveBudget: 0,
    upgradeReserveRemaining: 0,
    plannedRounds: 1,
    currentRound: round,
    spentBudget: controller.spentBudget,
    remainingBudget: remaining,
    workerId,
    role,
    currentHarness: controller.currentHarness || harness,
    upgradeCeiling: controller.upgradeCeiling,
    zone,
    showExactRoundCounter: zone === 'orange' || zone === 'red',
    allowExtensionRequest: zone === 'orange' || zone === 'red',
    mustConverge: zone === 'red',
    softMaxIter: remaining,
    hardMaxIter: remaining,
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

// FEATURE_062: Simplified — just add iterations to the cap.
function extendManagedWorkBudget(
  controller: ManagedTaskBudgetController,
  additionalUnits = GLOBAL_WORK_BUDGET_INCREMENT,
): void {
  controller.totalBudget += additionalUnits;
}

async function maybeRequestAdditionalWorkBudget(
  events: KodaXEvents | undefined,
  controller: ManagedTaskBudgetController,
  context: {
    summary: string;
    currentRound: number;
    maxRounds: number;
    originalTask?: string;
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
  const useChinese = /[\u4e00-\u9fff]/.test(context.originalTask ?? context.summary);
  const choice = await events.askUser({
    question: useChinese
      ? `当前 AMA 运行已使用 ${controller.spentBudget}/${controller.totalBudget} 工作单元（${usedPercent}%），需要更多工作量。是否追加 ${GLOBAL_WORK_BUDGET_INCREMENT} 单元？`
      : `This AMA run has used ${controller.spentBudget}/${controller.totalBudget} work units (${usedPercent}%) and needs more work. Add ${GLOBAL_WORK_BUDGET_INCREMENT} more work units?`,
    options: [
      {
        label: useChinese ? `继续 (+${GLOBAL_WORK_BUDGET_INCREMENT})` : `Continue (+${GLOBAL_WORK_BUDGET_INCREMENT})`,
        value: 'continue',
        description: useChinese
          ? `追加 ${GLOBAL_WORK_BUDGET_INCREMENT} 工作单元，从第 ${context.currentRound}/${context.maxRounds} 轮继续。`
          : `Grant ${GLOBAL_WORK_BUDGET_INCREMENT} more work units and continue from round ${context.currentRound}/${context.maxRounds}.`,
      },
      {
        label: useChinese ? '停止' : 'Stop here',
        value: 'stop',
        description: useChinese
          ? `使用当前最佳结果。最新进展：${truncateText(context.summary, 80)}`
          : `Finish now with the current best result. Latest note: ${truncateText(context.summary, 80)}`,
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

// FEATURE_062: Simplified budget hint based on used/cap ratio.
function formatBudgetHint(snapshot: KodaXManagedBudgetSnapshot | undefined): string | undefined {
  if (!snapshot || snapshot.totalBudget <= 0) {
    return undefined;
  }
  const pct = snapshot.spentBudget / snapshot.totalBudget;
  if (pct >= 0.85) {
    return `[Budget] ${snapshot.remainingBudget} iterations remaining. Produce a complete result now.`;
  }
  if (pct >= 0.7) {
    return '[Budget] Begin converging. Reduce exploration, organize completion path.';
  }
  return undefined;
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
  // FEATURE_061 Phase 3: Planner replan session resumption deferred to Phase 5.
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
    nextFocus: [`Re-run ${worker.title} and emit the required managed protocol payload (or append the fallback closing block exactly once if tools are unavailable).`],
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

// FEATURE_062: maxRounds is always 1 initially; extension increases it in the round loop.
function resolveManagedTaskMaxRounds(
  _options: KodaXOptions,
  _plan: ReasoningPlan,
  _agentMode: KodaXAgentMode,
): number {
  return 1;
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
  'dispatch_child_task',
  ...MCP_TOOL_NAMES,
] as const;

const PLANNER_ALLOWED_TOOLS = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'glob',
  'grep',
  'read',
  ...MCP_TOOL_NAMES,
] as const;

const H1_EVALUATOR_ALLOWED_TOOLS = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'changed_diff',
  'glob',
  'grep',
  'read',
  ...MCP_TOOL_NAMES,
] as const;

const H1_READONLY_GENERATOR_ALLOWED_TOOLS = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'changed_diff',
  'glob',
  'grep',
  'read',
  'dispatch_child_task',
  ...MCP_TOOL_NAMES,
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

// FEATURE_061 Phase 1: Harness guardrails removed — Scout is the harness authority.
function applyManagedHarnessGuardrailsToPlan(
  plan: ReasoningPlan,
  reviewTarget: ManagedReviewTarget,
): {
  plan: ReasoningPlan;
  routingOverrideReason?: string;
} {
  const decisionWithTarget = cloneRoutingDecisionWithReviewTarget(plan.decision, reviewTarget);
  if (decisionWithTarget === plan.decision) {
    return { plan };
  }
  return {
    plan: {
      ...plan,
      decision: decisionWithTarget,
      amaControllerDecision: buildAmaControllerDecision(decisionWithTarget),
      promptOverlay: buildPromptOverlay(
        decisionWithTarget,
        plan.providerPolicy?.routingNotes,
        plan.providerPolicy,
        buildAmaControllerDecision(decisionWithTarget),
      ),
    },
  };
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

  if (reason || rawDecision.harnessProfile !== finalDecision.harnessProfile) {
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
  return base;
}

// FEATURE_061 Phase 1: reviewTarget and reviewScale are informational context for Scout.
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

  const finalDecision: KodaXTaskRoutingDecision = diffDrivenReview && reviewScale
    ? {
      ...rawDecision,
      primaryTask: 'review',
      reviewScale,
      routingNotes: [
        ...(rawDecision.routingNotes ?? []),
        `Diff-driven review surface was classified as ${reviewScale}; use it to shape evidence acquisition, not to force a heavier harness.`,
      ],
      reason: `${rawDecision.reason} Diff-driven review scope was recorded for evidence strategy without forcing a heavier harness.`,
    }
    : reviewScale
      ? { ...rawDecision, reviewScale }
      : rawDecision;

  if (finalDecision === plan.decision) {
    return { plan, rawDecision, reviewTarget };
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
    // FEATURE_067 AMA redesign (Phase 4): Pass conversation history to the model router
    // so it can assess task complexity with full context (e.g., "你先实现吧" after discussing a 10-file project).
    const recentMessages = Array.isArray(options.session?.initialMessages) && options.session.initialMessages.length > 0
      ? options.session.initialMessages.slice(-10) // Last 10 messages for context
      : undefined;
    const plan = await createReasoningPlan(options, prompt, provider, {
      repoSignals: repoRoutingSignals ?? undefined,
      recentMessages,
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
    if (!policy) {
      return policy;
    }

    const allowedTools = policy.allowedTools?.length
      ? Array.from(new Set([
          ...(strictRepoIntelligenceOff
            ? filterRepoIntelligenceWorkingToolNames(policy.allowedTools)
            : policy.allowedTools),
          MANAGED_PROTOCOL_TOOL_NAME,
        ]))
      : policy.allowedTools;

    return {
      ...policy,
      allowedTools,
      summary: strictRepoIntelligenceOff && policy.allowedTools
        ? [
            policy.summary,
            'Repo-intelligence working tools are disabled in off mode; rely on general-purpose read/glob/grep evidence instead.',
          ].join(' ')
        : policy.summary,
    };
  };

  switch (role) {
    case 'scout':
      // Scout has full tool access. The three-level quality framework (eval-verified 100%
      // accuracy on strong models) guides harness decisions via prompt, not tool restrictions.
      // Scout investigates, declares confirmed_harness, and for H0 tasks completes directly.
      // For H1/H2 tasks, Scout escalates to the multi-agent pipeline.
      return undefined;
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
    formatBudgetHint(worker.budgetSnapshot),
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
    if (normalizedTool === MANAGED_PROTOCOL_TOOL_NAME) {
      return true;
    }
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
    `Complexity hint: ${decision.complexity}`,
    `Risk: ${decision.riskLevel}`,
    // FEATURE_061: Don't show pre-decided harness to Scout. Scout is the routing
    // authority and decides the harness based on its own evidence analysis.
    ...(role === 'scout'
      ? [`Topology ceiling: ${decision.topologyCeiling ?? decision.upgradeCeiling ?? 'none'}`]
      : [
        `Harness: ${decision.harnessProfile}`,
        `Topology ceiling: ${decision.topologyCeiling ?? decision.upgradeCeiling ?? 'none'}`,
      ]),
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
    ? [
      'When the task is review or audit, speak directly to the user about the final review findings. Do not frame the answer as grading or critiquing the Generator.',
      'Lead with concrete findings, ordered by severity, and anchor each finding to the strongest available file/path evidence.',
      'If there are no findings, say so explicitly before mentioning residual risks or testing gaps.',
    ].join('\n')
    : undefined;
  const evaluatorPublicAnswerRule = decision.primaryTask === 'review'
    ? [
      'Your public answer must read like the final review report itself.',
      'List concrete findings first, ordered by severity, with tight file/path references whenever the evidence supports them.',
      'Do not collapse the review into a one-line quality summary when concrete findings exist.',
      'If you found no actionable issues, say that explicitly before any residual-risk note.',
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
  const managedProtocolToolInstructions = role !== 'direct' && (!isTerminalAuthority || role !== 'generator')
    ? [
      `PROTOCOL EMISSION — MUST be in the SAME response as your answer:`,
      `Write your user-facing answer, then call "${MANAGED_PROTOCOL_TOOL_NAME}" exactly once — all in the SAME response.`,
      `Pass role="${role}" and a minimal protocol payload matching your role contract.`,
      'Do NOT stop between writing your answer and calling the protocol tool. Emit both in one turn.',
      'Keep the user-facing answer in normal text. Do not bury it inside the protocol payload.',
      'Never mention internal protocol tools, fenced blocks, MCP, capability runtimes, or extension runtimes in the user-facing answer.',
      'If tool calling is unavailable, append the required fenced block at the end of this same response.',
    ].join('\n')
    : undefined;

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
        managedProtocolToolInstructions,
        decision.primaryTask === 'review'
          ? 'If you finish a review directly, write the answer as the review report itself: findings first, with concrete file/path references, not as a meta-summary of your own process.'
          : undefined,
        // FEATURE_067 AMA redesign: Three-level quality framework (eval-verified 92%+ accuracy)
        // Replaces the old capability-based harness guidance with a quality-assurance mental model.
        [
          'HARNESS DECISION — Think of yourself as a senior engineer who just received this task.',
          'Before writing any code, ask yourself: "What would I do before starting?"',
          '',
          'H0_DIRECT — "I\'d just do this myself. It\'s simple enough that no one needs to check my work."',
          '  Examples: fixing a typo, answering a question, looking up a config value, writing a one-line change, git commit/push.',
          '  Complete the task directly (including edits, bash commands, etc.) and set direct_completion_ready: yes when done.',
          '',
          'H1_EXECUTE_EVAL — "I know how to do this, but I\'d want someone to review my work before shipping."',
          '  Examples: fixing a specific bug, making a focused code change across a few files, doing a code review where conclusions matter.',
          '',
          'H2_PLAN_EXECUTE_EVAL — "I need to think about the approach first, maybe sketch it out, before I start coding."',
          '  Examples: building a new feature from scratch, refactoring across modules, designing a new system, implementing something with multiple architectural decisions.',
        ].join('\n'),
        'You are the task analyst and harness decision-maker. Assess the task scope, declare your harness decision, and for H0 tasks complete the work directly.',
        'Prefer scope facts first: changed scope, module spread, diff size, verification requirements, and any explicit task constraints.',
        'If you confirm H0_DIRECT: complete the task yourself (including file edits, git operations, etc.) and give the final user-facing answer. Set direct_completion_ready: yes when done.',
        'If you confirm H1 or H2: stop after investigation. Your findings will be passed to the Generator as handoff context. Focus on scope assessment and key findings, not exhaustive analysis.',
        'Respect any stated topology ceiling or upgrade ceiling in the routing metadata.',
        scoutReviewEvidenceGuidance,
        // FEATURE_067: dispatch_child_task tool guidance for parallel fan-out
        [
          'PARALLEL CHILD AGENTS: You have access to the dispatch_child_task tool.',
          'Each call runs ONE independent child agent. To parallelize, call it MULTIPLE TIMES in the SAME response (multiple tool_use blocks). Each child appears as a separate tool with its own status.',
          '',
          'DECISION RULE — after your initial scope analysis (1-2 turns):',
          '  Does this task contain 2+ INDEPENDENT sub-tasks, each requiring multi-file reading and multi-step reasoning?',
          '  → YES (2+ sub-tasks): call dispatch_child_task once PER sub-task in the SAME turn.',
          '  → NO (only 1 sub-task, or sub-tasks are simple): do the work YOURSELF with parallel tool calls (glob, grep, read).',
          '',
          'RULE: If you identify 2+ independent sub-tasks, dispatch them ALL as parallel children. Do NOT talk yourself out of parallelism by deciding "I can handle one of them myself" — the whole point is PARALLEL execution.',
          '',
          'ANTI-PATTERN — NEVER dispatch exactly 1 child agent. A single child is ALWAYS worse than doing it yourself:',
          '  - Extra overhead (child startup, briefing, result relay) with ZERO parallelism benefit.',
          '  - If you can only identify 1 sub-task, that means the task is not a fan-out task. Handle it directly.',
          '',
          'Example — 3-package security audit (3 independent sub-tasks → 3 parallel children):',
          '  tool_use: dispatch_child_task({id:"sec-ai",objective:"Analyze packages/ai security...",readOnly:true})',
          '  tool_use: dispatch_child_task({id:"sec-agent",objective:"Analyze packages/agent security...",readOnly:true})',
          '  tool_use: dispatch_child_task({id:"sec-coding",objective:"Analyze packages/coding security...",readOnly:true})',
          'All 3 execute in parallel. You receive each child\'s findings as separate tool results.',
          '',
          'TIMING: Decide EARLY (after initial scope, before deep investigation). Once you start deep-diving, child delegation becomes wasted work.',
          'You may call dispatch_child_task BEFORE deciding your confirmed_harness. Use the findings to make a better-informed harness decision.',
          'Scout can only dispatch readOnly tasks. Write fan-out is available to Generator only.',
        ].join('\n'),
        [
          `Append a final fenced block named \`\`\`${MANAGED_TASK_SCOUT_BLOCK}\` with this exact shape:`,
          'summary: <one-line scout summary>',
          'confirmed_harness: <required H0_DIRECT|H1_EXECUTE_EVAL|H2_PLAN_EXECUTE_EVAL>',
          'harness_rationale: <required one-line reason why this harness is appropriate>',
          'direct_completion_ready: <required yes|no>',
          'blocking_evidence:',
          '- <required if not H0; use "none" when H0 is ready to finish directly>',
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
        managedProtocolToolInstructions,
        plannerReviewEvidenceGuidance,
        'The Scout-confirmed harness is the active harness for this run. Do not reinterpret it locally; only request a stronger harness through an explicit later verdict if the evidence truly demands it.',
        'Produce a concise execution plan, the critical risks, and the evidence checklist.',
        `Your output is invalid unless you either call "${MANAGED_PROTOCOL_TOOL_NAME}" with the contract payload or append a final \`\`\`${MANAGED_TASK_CONTRACT_BLOCK}\`\`\` fenced block.`,
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
        managedProtocolToolInstructions,
        reviewPresentationRule,
        generatorReviewEvidenceGuidance,
        h1GeneratorExecutionGuidance,
        h1MutationGuardance,
        'The Scout-confirmed harness is the active harness for this run. Do not reinterpret it locally; only request a stronger harness through an explicit later verdict if the evidence truly demands it.',
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Execute the task or produce the requested deliverable.',
        isTerminalAuthority
          ? 'You are the terminal delivery role for this run. Return the final user-facing answer and summarize concrete evidence inline.'
          : 'Leave final judgment to the evaluator and include a crisp evidence handoff.',
        // FEATURE_067: Generator parallel task guidance via dispatch_child_task tool
        [
          'PARALLEL CHILD AGENTS: You have access to the dispatch_child_task tool.',
          'Each call runs ONE child agent. Call it MULTIPLE TIMES in the same response for parallel execution.',
          'NEVER dispatch exactly 1 child — a single child is always worse than doing it yourself (overhead, no parallelism, reduced quality).',
          'Only dispatch when you have 2+ genuinely independent sub-tasks that each need multi-step investigation.',
          'For read-only investigation: call with readOnly=true to gather evidence in parallel.',
          decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL' && !isTerminalAuthority
            ? 'For write fan-out: call with readOnly=false when modifying independent modules. Each write child runs in an isolated git worktree. The Evaluator will review all diffs before merging.'
            : 'Write fan-out (readOnly=false) is only available in H2_PLAN_EXECUTE_EVAL harness.',
        ].join('\n'),
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
        managedProtocolToolInstructions,
        reviewPresentationRule,
        evaluatorReviewEvidenceGuidance,
        'The Scout-confirmed harness is the active harness for this run. Do not reinterpret it locally; only recommend a stronger harness when the evidence clearly shows the current harness cannot safely finish the task.',
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Judge whether the dependency handoff satisfies the original task and whether the evidence is strong enough.',
        // FEATURE_067: Inject write fan-out review prompt for Evaluator
        rolePromptContext?.childWriteReviewPrompt
          ? [
            '## Child Agent Write Diffs — Pending Your Review',
            '',
            'The Generator spawned parallel child agents that modified code in isolated worktrees.',
            'Review each child\'s diff below. For each child, decide ACCEPT or REVISE.',
            'ACCEPT: changes are correct and consistent — they will be merged to the main branch.',
            'REVISE: changes need fixes — explain what\'s wrong so Generator can retry.',
            '',
            rolePromptContext.childWriteReviewPrompt,
          ].join('\n')
          : undefined,
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
        artifacts: buildContextInputEvidenceArtifacts(options.context),
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
      artifacts: buildContextInputEvidenceArtifacts(options.context),
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

// FEATURE_061 Phase 2: Scout H0 completion — Scout does actual work and returns the result directly.
async function completeScoutH0Task(ctx: {
  options: KodaXOptions;
  originalTask: string;
  plan: ReasoningPlan;
  scoutExecution: { result: KodaXResult; directive: ManagedTaskScoutDirective };
  scoutBudgetController: ManagedTaskBudgetController;
  rawRoutingDecision: KodaXTaskRoutingDecision;
  finalRoutingDecision: KodaXTaskRoutingDecision;
  routingOverrideReason: string | undefined;
  skillMap: KodaXSkillMap | undefined;
  agentMode: KodaXAgentMode;
}): Promise<KodaXResult> {
  const { options, originalTask, plan, scoutExecution, scoutBudgetController,
    rawRoutingDecision, finalRoutingDecision, routingOverrideReason, skillMap, agentMode } = ctx;

  const surface = getManagedTaskSurface(options);
  const taskId = `task-${randomUUID()}`;
  const workspaceDir = path.join(getManagedTaskWorkspaceRoot(options, surface), taskId);
  const createdAt = new Date().toISOString();
  const qualityAssuranceMode = resolveManagedTaskQualityAssuranceMode(options, plan);
  const amaControllerDecision = plan.amaControllerDecision;
  const scoutAgent = buildManagedWorkerAgent('scout', 'scout');
  const scoutToolPolicy = buildManagedWorkerToolPolicy(
    'scout', options.context?.taskVerification, 'H0_DIRECT', undefined, options.context?.repoIntelligenceMode,
  );
  const normalizedVerification = options.context?.taskVerification
    ? {
      ...options.context.taskVerification,
      rubricFamily: inferVerificationRubricFamily(options.context.taskVerification, plan.decision.primaryTask),
      criteria: resolveVerificationCriteria(options.context.taskVerification, plan.decision.primaryTask),
      runtime: deriveRuntimeVerificationContract(options.context.taskVerification, options),
    }
    : undefined;

  const budgetController = createManagedBudgetController(options, plan, agentMode);
  budgetController.spentBudget = Math.max(budgetController.spentBudget, scoutBudgetController.spentBudget);
  await mkdir(workspaceDir, { recursive: true });
  const skillArtifacts = await writeManagedSkillArtifacts(workspaceDir, options.context?.skillInvocation, skillMap);

  const task: KodaXManagedTask = {
    contract: {
      taskId, surface, objective: originalTask, createdAt, updatedAt: createdAt,
      status: 'running', primaryTask: plan.decision.primaryTask,
      workIntent: plan.decision.workIntent, complexity: plan.decision.complexity,
      riskLevel: plan.decision.riskLevel, harnessProfile: 'H0_DIRECT',
      recommendedMode: plan.decision.recommendedMode,
      requiresBrainstorm: plan.decision.requiresBrainstorm,
      reason: plan.decision.reason,
      contractSummary: undefined, successCriteria: [],
      requiredEvidence: options.context?.taskVerification?.requiredEvidence ?? [],
      constraints: [], metadata: options.context?.taskMetadata,
      verification: normalizedVerification,
    },
    roleAssignments: [{
      id: 'scout', role: 'scout', title: 'Scout', dependsOn: [],
      status: 'running', agent: scoutAgent, toolPolicy: scoutToolPolicy,
    }],
    workItems: [{
      id: 'scout', assignmentId: 'scout',
      description: 'Scout completes the task directly.',
      execution: 'serial',
    }],
    evidence: {
      workspaceDir,
      artifacts: mergeEvidenceArtifacts(
        buildContextInputEvidenceArtifacts(options.context),
        skillArtifacts,
      ),
      entries: [],
      routingNotes: plan.decision.routingNotes ?? [],
    },
    verdict: {
      status: 'running', decidedByAssignmentId: 'scout',
      summary: 'Scout is completing the task directly.',
    },
    runtime: {
      ...applyAmaRuntimeState(undefined, amaControllerDecision),
      ...applyManagedBudgetRuntimeState(undefined, budgetController),
      budget: createBudgetSnapshot(budgetController, 'H0_DIRECT', 1, 'scout'),
      currentHarness: 'H0_DIRECT',
      upgradeCeiling: plan.decision.upgradeCeiling,
      harnessTransitions: [],
      routingAttempts: plan.decision.routingAttempts,
      routingSource: plan.decision.routingSource,
      rawRoutingDecision, finalRoutingDecision, routingOverrideReason,
      qualityAssuranceMode,
      scorecard: createVerificationScorecard({ contract: { verification: normalizedVerification } } as KodaXManagedTask, undefined),
      scoutDecision: {
        summary: scoutExecution.directive.summary ?? 'Scout completed the task directly.',
        recommendedHarness: 'H0_DIRECT', readyForUpgrade: false,
        scope: scoutExecution.directive.scope,
        requiredEvidence: scoutExecution.directive.requiredEvidence,
        reviewFilesOrAreas: scoutExecution.directive.reviewFilesOrAreas,
        evidenceAcquisitionMode: scoutExecution.directive.evidenceAcquisitionMode,
        harnessRationale: scoutExecution.directive.harnessRationale,
        blockingEvidence: scoutExecution.directive.blockingEvidence,
        directCompletionReady: scoutExecution.directive.directCompletionReady,
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
  };

  const scoutWorkerSpec: ManagedTaskWorkerSpec = {
    id: 'scout', role: 'scout', title: 'Scout', dependsOn: [],
    agent: scoutAgent, toolPolicy: scoutToolPolicy,
    memoryStrategy: 'reset-handoff', terminalAuthority: true,
    prompt: '',
  };
  const roundSummary = buildManagedWorkerRoundSummary(
    task, scoutWorkerSpec, scoutExecution.result, 1, scoutExecution.directive,
  );
  if (roundSummary) {
    task.runtime = { ...task.runtime, roleRoundSummaries: { scout: roundSummary } };
  }

  // FEATURE_067 v2: Child agents are now dispatched via dispatch_child_task tool during Scout's turn.
  // Findings are already in scoutExecution.result.lastText (returned as tool results).
  // No system-side child execution needed here.
  const scoutResult = scoutExecution.result;

  const completedTask = applyScoutTerminalResultToTask(task, scoutResult, scoutExecution.directive);
  await writeManagedTaskSnapshotArtifacts(workspaceDir, completedTask);
  options.events?.onManagedTaskStatus?.({
    agentMode, harnessProfile: 'H0_DIRECT',
    activeWorkerId: 'scout', activeWorkerTitle: 'Scout',
    phase: 'completed', note: 'Scout completed the task directly',
    persistToHistory: true,
    events: [{
      key: 'managed-task-completed',
      kind: 'completed',
      summary: completedTask.verdict.disposition === 'complete'
        ? 'Task completed'
        : completedTask.verdict.disposition === 'needs_continuation'
          ? 'Task needs continuation'
          : `Task ended: ${completedTask.verdict.disposition ?? 'unknown'}`,
      detail: completedTask.verdict.summary,
      persistToHistory: true,
    }],
    upgradeCeiling: finalRoutingDecision.upgradeCeiling,
    ...buildManagedStatusBudgetFields(budgetController),
  });
  scheduleManagedTaskRepoIntelligenceCapture(
    resolveManagedTaskRepoIntelligenceContext(options), workspaceDir, options,
  );

  return { ...scoutResult, managedTask: completedTask, routingDecision: finalRoutingDecision };
}

function isManagedBackgroundFanoutWorker(
  worker: ManagedTaskWorkerSpec,
): boolean {
  return worker.execution === 'parallel'
    || worker.metadata?.fanoutClass === 'finding-validation'
    || worker.metadata?.fanoutClass === 'evidence-scan'
    || worker.metadata?.fanoutClass === 'module-triage'
    || worker.metadata?.fanoutClass === 'hypothesis-check';
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

/**
 * All known managed fence block names.  Used to detect truncated fences
 * whose info string is a prefix of one of these names (e.g. "k", "kod",
 * "kodax-task-sc" are all prefixes of "kodax-task-scout").
 */
const MANAGED_FENCE_NAMES: readonly string[] = [
  MANAGED_TASK_SCOUT_BLOCK,               // kodax-task-scout
  MANAGED_TASK_CONTRACT_BLOCK,            // kodax-task-contract
  MANAGED_TASK_HANDOFF_BLOCK,             // kodax-task-handoff
  MANAGED_TASK_VERDICT_BLOCK,             // kodax-task-verdict
  TACTICAL_REVIEW_FINDINGS_BLOCK,         // kodax-review-findings
  TACTICAL_INVESTIGATION_SHARDS_BLOCK,    // kodax-investigation-shards
  TACTICAL_LOOKUP_SHARDS_BLOCK,           // kodax-lookup-shards
  TACTICAL_CHILD_RESULT_BLOCK,            // kodax-child-result
  MANAGED_TASK_BUDGET_REQUEST_BLOCK,      // kodax-budget-request
];

/**
 * Check whether `candidate` is a prefix of any known managed fence name.
 * Case-insensitive. Used to identify truncated fences (e.g. "```k", "```kodax-task-sc").
 */
function isManagedFencePrefix(candidate: string): boolean {
  const lower = candidate.toLowerCase();
  return MANAGED_FENCE_NAMES.some((name) => name.startsWith(lower));
}

/**
 * Find the start index of a trailing unclosed fence whose info string is a
 * prefix of a known managed fence name.  Returns -1 if not found.
 *
 * Scans backwards from the end of the text so that earlier closed code blocks
 * (e.g. ```python...```) do not shadow a truncated managed fence at the tail.
 *
 * Matches patterns like:
 *   \n```k           (truncated at 1st char)
 *   \n```kodax-task   (truncated mid-name)
 *   \n```kodax-task-scout\nsummary: ...  (truncated mid-body)
 */
function findIncompleteManagedFenceIndex(text: string): number {
  let searchFrom = text.length;

  while (searchFrom > 0) {
    const backtickIdx = text.lastIndexOf('```', searchFrom - 1);
    if (backtickIdx < 0) return -1;

    // Must start at beginning of a line (preceded by \n) or at position 0.
    if (backtickIdx > 0 && text[backtickIdx - 1] !== '\n') {
      searchFrom = backtickIdx;
      continue;
    }

    // Extract info string (word chars + hyphens immediately after ```)
    const rest = text.slice(backtickIdx + 3);
    const infoMatch = rest.match(/^([\w-]+)/);

    if (!infoMatch) {
      // Bare ``` with no info string → this is a closing fence marker.
      // Everything above it is closed.  Stop searching.
      return -1;
    }

    const infoString = infoMatch[1];
    const body = rest.slice(infoString.length);

    // Check whether this fence is closed (a bare ``` on its own line after it).
    if (/\n\s*```\s*(\n|$)/.test(body)) {
      // Closed fence — not what we are looking for.  Stop searching;
      // any earlier fence is also necessarily closed.
      return -1;
    }

    // ── Unclosed fence found ──
    // Include the preceding newline in the cut position.
    const fenceStart = backtickIdx > 0
      ? (backtickIdx > 1 && text[backtickIdx - 2] === '\r'
        ? backtickIdx - 2
        : backtickIdx - 1)
      : backtickIdx;

    // Full "kodax" prefix → definitively ours, strip regardless of body content.
    if (infoString.toLowerCase().startsWith('kodax')) {
      return fenceStart;
    }

    // Partial prefix (e.g. "k", "ko", "kod", "koda") → only strip if:
    //   1. The info string IS a prefix of a known managed fence name, AND
    //   2. The body is empty or whitespace-only (the fence name itself was
    //      truncated, not a legitimate code block with actual content).
    if (isManagedFencePrefix(infoString) && /^\s*$/.test(body)) {
      return fenceStart;
    }

    // Last unclosed fence is not managed — stop.
    return -1;
  }

  return -1;
}

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
  let visibleText = (cutIndex > 0 ? trimmed.slice(0, cutIndex) : trimmed).trim();
  // Strip complete managed fences (with closing ```).
  // Full "kodax" prefix required — the name is never truncated in a closed fence.
  for (;;) {
    const stripped = visibleText.replace(/\r?\n?\`\`\`kodax[\w-]*\s*[\s\S]*?\`\`\`\s*$/i, '').trim();
    if (stripped === visibleText) {
      break;
    }
    visibleText = stripped;
  }
  // Strip trailing incomplete managed fence (no closing ``` — max_tokens truncation).
  // Uses prefix-matching against known managed fence names to avoid misidentifying
  // legitimate code blocks (e.g. ```kotlin, ```ksh).
  const incompleteFenceIdx = findIncompleteManagedFenceIndex(visibleText);
  if (incompleteFenceIdx >= 0) {
    visibleText = visibleText.slice(0, incompleteFenceIdx).trim();
  }
  return visibleText;
}

function sanitizeManagedStreamingText(text: string): string {
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

  // Detect incomplete managed fence using prefix-matching against known names.
  const incompleteManagedFenceIndex = findIncompleteManagedFenceIndex(trimmed);
  if (incompleteManagedFenceIndex >= 0 && (cutIndex === -1 || incompleteManagedFenceIndex < cutIndex)) {
    cutIndex = incompleteManagedFenceIndex;
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
  const block = findLastFencedBlock(text, MANAGED_TASK_SCOUT_BLOCK);
  if (!block) {
    return undefined;
  }

  const body = block.body;
  const visibleText = sanitizeManagedUserFacingText(text.slice(0, block.index).trim());
  try {
    const parsed = JSON.parse(body) as {
      summary?: string;
      scope?: unknown;
      required_evidence?: unknown;
      requiredEvidence?: unknown;
      review_files_or_areas?: unknown;
      reviewFilesOrAreas?: unknown;
      evidence_acquisition_mode?: string;
      evidenceAcquisitionMode?: string;
      confirmed_harness?: string;
      confirmedHarness?: string;
      harness_rationale?: string;
      harnessRationale?: string;
      blocking_evidence?: unknown;
      blockingEvidence?: unknown;
      direct_completion_ready?: string | boolean;
      directCompletionReady?: string | boolean;
      skill_summary?: string;
      skillSummary?: string;
      projection_confidence?: string;
      projectionConfidence?: string;
      execution_obligations?: unknown;
      executionObligations?: unknown;
      verification_obligations?: unknown;
      verificationObligations?: unknown;
      ambiguities?: unknown;
    };
    const scope = normalizeStringListValue(parsed.scope);
    const requiredEvidence = normalizeStringListValue(parsed.required_evidence ?? parsed.requiredEvidence);
    const reviewFilesOrAreas = normalizeStringListValue(parsed.review_files_or_areas ?? parsed.reviewFilesOrAreas);
    const blockingEvidence = normalizeStringListValue(parsed.blocking_evidence ?? parsed.blockingEvidence);
    const executionObligations = normalizeStringListValue(parsed.execution_obligations ?? parsed.executionObligations);
    const verificationObligations = normalizeStringListValue(parsed.verification_obligations ?? parsed.verificationObligations);
    const ambiguities = normalizeStringListValue(parsed.ambiguities);
    const confirmedHarness = parsed.confirmed_harness || parsed.confirmedHarness
      ? normalizeManagedScoutHarness(String(parsed.confirmed_harness ?? parsed.confirmedHarness))
      : undefined;
    const evidenceAcquisitionMode = parsed.evidence_acquisition_mode || parsed.evidenceAcquisitionMode
      ? normalizeManagedEvidenceAcquisitionMode(String(parsed.evidence_acquisition_mode ?? parsed.evidenceAcquisitionMode))
      : undefined;
    const skillSummary = typeof parsed.skill_summary === 'string'
      ? parsed.skill_summary.trim() || undefined
      : typeof parsed.skillSummary === 'string'
        ? parsed.skillSummary.trim() || undefined
        : undefined;
    const projectionConfidence = parsed.projection_confidence || parsed.projectionConfidence
      ? normalizeManagedProjectionConfidence(String(parsed.projection_confidence ?? parsed.projectionConfidence))
      : undefined;
    const harnessRationale = typeof (parsed.harness_rationale ?? parsed.harnessRationale) === 'string'
      ? String(parsed.harness_rationale ?? parsed.harnessRationale).trim() || undefined
      : undefined;
    const directCompletionReady = typeof (parsed.direct_completion_ready ?? parsed.directCompletionReady) === 'string'
      ? normalizeManagedDirectCompletionReady(String(parsed.direct_completion_ready ?? parsed.directCompletionReady))
      : typeof (parsed.direct_completion_ready ?? parsed.directCompletionReady) === 'boolean'
        ? ((parsed.direct_completion_ready ?? parsed.directCompletionReady) ? 'yes' : 'no')
        : undefined;
    if (
      parsed.summary
      || scope.length > 0
      || requiredEvidence.length > 0
      || reviewFilesOrAreas.length > 0
      || confirmedHarness
      || harnessRationale
      || blockingEvidence.length > 0
      || directCompletionReady
      || evidenceAcquisitionMode
      || skillSummary
      || executionObligations.length > 0
      || verificationObligations.length > 0
      || ambiguities.length > 0
      || projectionConfidence
      || visibleText
    ) {
      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary.trim() || undefined : undefined,
        scope,
        requiredEvidence,
        reviewFilesOrAreas,
        evidenceAcquisitionMode,
        confirmedHarness,
        harnessRationale,
        blockingEvidence,
        directCompletionReady,
        userFacingText: visibleText,
        skillMap: skillSummary || executionObligations.length > 0 || verificationObligations.length > 0 || ambiguities.length > 0 || projectionConfidence
          ? {
              skillSummary,
              executionObligations,
              verificationObligations,
              ambiguities,
              projectionConfidence,
            }
          : undefined,
      };
    }
  } catch {
    // Fall back to the line-oriented parser below.
  }
  let summary: string | undefined;
  let confirmedHarness: ManagedTaskScoutDirective['confirmedHarness'];
  let harnessRationale: string | undefined;
  let directCompletionReady: ManagedTaskScoutDirective['directCompletionReady'];
  let evidenceAcquisitionMode: ManagedTaskScoutDirective['evidenceAcquisitionMode'];
  const scope: string[] = [];
  const requiredEvidence: string[] = [];
  const reviewFilesOrAreas: string[] = [];
  const blockingEvidence: string[] = [];
  let skillSummary: string | undefined;
  let projectionConfidence: KodaXSkillMap['projectionConfidence'] | undefined;
  const executionObligations: string[] = [];
  const verificationObligations: string[] = [];
  const ambiguities: string[] = [];
  let currentList:
    | 'scope'
    | 'evidence'
    | 'review-files'
    | 'blocking-evidence'
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
    if (/^summary\s*[:=]/i.test(line)) {
      summary = line.replace(/^summary\s*[:=]\s*/i, '').trim();
      currentList = undefined;
      continue;
    }
    if (/^(confirmed_harness|confirmedharness|harness)\s*[:=]/i.test(line)) {
      confirmedHarness = normalizeManagedScoutHarness(line.replace(/^(confirmed_harness|confirmedharness|harness)\s*[:=]\s*/i, ''));
      currentList = undefined;
      continue;
    }
    if (/^(harness_rationale|harnessrationale)\s*[:=]/i.test(line)) {
      harnessRationale = line.replace(/^(harness_rationale|harnessrationale)\s*[:=]\s*/i, '').trim();
      currentList = undefined;
      continue;
    }
    if (/^(direct_completion_ready|directcompletionready)\s*[:=]/i.test(line)) {
      directCompletionReady = normalizeManagedDirectCompletionReady(
        line.replace(/^(direct_completion_ready|directcompletionready)\s*[:=]\s*/i, ''),
      );
      currentList = undefined;
      continue;
    }
    if (/^(evidence_acquisition_mode|evidenceacquisitionmode)\s*[:=]/i.test(line)) {
      evidenceAcquisitionMode = normalizeManagedEvidenceAcquisitionMode(
        line.replace(/^(evidence_acquisition_mode|evidenceacquisitionmode)\s*[:=]\s*/i, ''),
      );
      currentList = undefined;
      continue;
    }
    if (/^(skill_summary|skillsummary)\s*[:=]/i.test(line)) {
      skillSummary = line.replace(/^(skill_summary|skillsummary)\s*[:=]\s*/i, '').trim();
      currentList = undefined;
      continue;
    }
    if (/^(projection_confidence|projectionconfidence)\s*[:=]/i.test(line)) {
      projectionConfidence = normalizeManagedProjectionConfidence(
        line.replace(/^(projection_confidence|projectionconfidence)\s*[:=]\s*/i, ''),
      );
      currentList = undefined;
      continue;
    }
    if (/^scope\s*[:=]/i.test(line)) {
      currentList = 'scope';
      const firstItem = line.replace(/^scope\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        scope.push(firstItem.replace(/^-+\s*/, '').trim());
      }
      continue;
    }
    if (/^(required_evidence|requiredevidence)\s*[:=]/i.test(line)) {
      currentList = 'evidence';
      const firstItem = line.replace(/^(required_evidence|requiredevidence)\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        requiredEvidence.push(firstItem.replace(/^-+\s*/, '').trim());
      }
      continue;
    }
    if (/^(review_files_or_areas|reviewfilesorareas)\s*[:=]/i.test(line)) {
      currentList = 'review-files';
      const firstItem = line.replace(/^(review_files_or_areas|reviewfilesorareas)\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        reviewFilesOrAreas.push(firstItem.replace(/^-+\s*/, '').trim());
      }
      continue;
    }
    if (/^(blocking_evidence|blockingevidence)\s*[:=]/i.test(line)) {
      currentList = 'blocking-evidence';
      const firstItem = line.replace(/^(blocking_evidence|blockingevidence)\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        blockingEvidence.push(firstItem.replace(/^-+\s*/, '').trim());
      }
      continue;
    }
    if (/^(execution_obligations|executionobligations)\s*[:=]/i.test(line)) {
      currentList = 'execution-obligations';
      const firstItem = line.replace(/^(execution_obligations|executionobligations)\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        executionObligations.push(firstItem.replace(/^-+\s*/, '').trim());
      }
      continue;
    }
    if (/^(verification_obligations|verificationobligations)\s*[:=]/i.test(line)) {
      currentList = 'verification-obligations';
      const firstItem = line.replace(/^(verification_obligations|verificationobligations)\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        verificationObligations.push(firstItem.replace(/^-+\s*/, '').trim());
      }
      continue;
    }
    if (/^ambiguities\s*[:=]/i.test(line)) {
      currentList = 'ambiguities';
      const firstItem = line.replace(/^ambiguities\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        ambiguities.push(firstItem.replace(/^-+\s*/, '').trim());
      }
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
    } else if (currentList === 'blocking-evidence') {
      blockingEvidence.push(item);
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
    && !harnessRationale
    && blockingEvidence.length === 0
    && !directCompletionReady
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
    harnessRationale,
    blockingEvidence: blockingEvidence.filter(Boolean),
    directCompletionReady,
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
  const block = findLastFencedBlock(text, MANAGED_TASK_HANDOFF_BLOCK);
  if (!block) {
    return undefined;
  }

  const body = block.body;
  const visibleText = sanitizeManagedUserFacingText(text.slice(0, block.index).trim());
  try {
    const parsed = JSON.parse(body) as {
      status?: string;
      summary?: string;
      evidence?: unknown;
      followup?: unknown;
      followups?: unknown;
    };
    const status = parsed.status ? normalizeManagedHandoffStatus(String(parsed.status)) : undefined;
    if (status) {
      return {
        status,
        summary: typeof parsed.summary === 'string' ? parsed.summary.trim() || undefined : undefined,
        evidence: normalizeStringListValue(parsed.evidence),
        followup: normalizeStringListValue(parsed.followup ?? parsed.followups),
        userFacingText: visibleText,
      };
    }
  } catch {
    // Fall back to the line-oriented parser below.
  }
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
    if (/^status\s*[:=]/i.test(line)) {
      status = normalizeManagedHandoffStatus(line.replace(/^status\s*[:=]\s*/i, ''));
      currentList = undefined;
      continue;
    }
    if (/^summary\s*[:=]/i.test(line)) {
      summary = line.replace(/^summary\s*[:=]\s*/i, '').trim();
      currentList = undefined;
      continue;
    }
    if (/^evidence\s*[:=]/i.test(line)) {
      currentList = 'evidence';
      const firstItem = line.replace(/^evidence\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        evidence.push(firstItem.replace(/^-+\s*/, '').trim());
      }
      continue;
    }
    if (/^followups?\s*[:=]/i.test(line)) {
      currentList = 'followup';
      const firstItem = line.replace(/^followups?\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        followup.push(firstItem.replace(/^-+\s*/, '').trim());
      }
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
  const block = findLastFencedBlock(text, MANAGED_TASK_VERDICT_BLOCK);
  if (!block) {
    return undefined;
  }

  const body = block.body;
  const visibleText = sanitizeManagedUserFacingText(text.slice(0, block.index).trim());
  const jsonDirective = parseManagedTaskVerdictDirectiveFromJson(body, visibleText);
  if (jsonDirective) {
    return jsonDirective;
  }
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
    const fieldMatch = normalized.match(/^(status|reason|user_answer|useranswer|answer|next_harness|nextharness|followup|followups)\s*[:=]\s*(.*)$/);
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
    if (/^status\s*[:=]/i.test(line)) {
      status = normalizeManagedVerdictStatus(line.replace(/^status\s*[:=]\s*/i, ''));
      activeSection = undefined;
      continue;
    }
    if (/^reason\s*[:=]/i.test(line)) {
      reason = line.replace(/^reason\s*[:=]\s*/i, '').trim();
      activeSection = undefined;
      continue;
    }
    if (/^(user_answer|useranswer|answer)\s*[:=]/i.test(line)) {
      flushUserAnswer();
      activeSection = 'user_answer';
      const firstLine = rawLine.replace(/^\s*(user_answer|useranswer|answer)\s*[:=]\s*/i, '');
      userAnswerLines.push(firstLine);
      continue;
    }
    if (/^(next_harness|nextharness)\s*[:=]/i.test(line)) {
      nextHarness = normalizeManagedNextHarness(line.replace(/^(next_harness|nextharness)\s*[:=]\s*/i, ''));
      activeSection = undefined;
      continue;
    }
    if (/^followups?\s*[:=]/i.test(line)) {
      flushUserAnswer();
      activeSection = 'followup';
      const firstItem = line.replace(/^followups?\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        followups.push(firstItem.replace(/^-+\s*/, '').trim());
      }
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

export const __managedProtocolTestables = {
  parseManagedTaskScoutDirective,
  parseManagedTaskContractDirective,
  parseManagedTaskHandoffDirective,
  parseManagedTaskVerdictDirective,
};

export const __checkpointTestables = {
  writeCheckpoint,
  deleteCheckpoint,
  findValidCheckpoint,
  getGitHeadCommit,
  CHECKPOINT_MAX_AGE_MS,
  CHECKPOINT_FILE,
};


function parseManagedTaskContractDirective(text: string): ManagedTaskContractDirective | undefined {
  const block = findLastFencedBlock(text, MANAGED_TASK_CONTRACT_BLOCK);
  if (!block) {
    return undefined;
  }

  const body = block.body;
  try {
    const parsed = JSON.parse(body) as {
      summary?: string;
      success_criteria?: unknown;
      successCriteria?: unknown;
      required_evidence?: unknown;
      requiredEvidence?: unknown;
      constraints?: unknown;
    };
    const successCriteria = normalizeStringListValue(parsed.success_criteria ?? parsed.successCriteria);
    const requiredEvidence = normalizeStringListValue(parsed.required_evidence ?? parsed.requiredEvidence);
    const constraints = normalizeStringListValue(parsed.constraints);
    if (
      parsed.summary
      || successCriteria.length > 0
      || requiredEvidence.length > 0
      || constraints.length > 0
    ) {
      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary.trim() || undefined : undefined,
        successCriteria,
        requiredEvidence,
        constraints,
      };
    }
  } catch {
    // Fall back to the line-oriented parser below.
  }
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
    if (/^summary\s*[:=]/i.test(line)) {
      summary = line.replace(/^summary\s*[:=]\s*/i, '').trim();
      currentList = undefined;
      continue;
    }
    if (/^(success_criteria|successcriteria)\s*[:=]/i.test(line)) {
      currentList = 'success';
      const firstItem = line.replace(/^(success_criteria|successcriteria)\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        successCriteria.push(firstItem.replace(/^-+\s*/, '').trim());
      }
      continue;
    }
    if (/^(required_evidence|requiredevidence)\s*[:=]/i.test(line)) {
      currentList = 'evidence';
      const firstItem = line.replace(/^(required_evidence|requiredevidence)\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        requiredEvidence.push(firstItem.replace(/^-+\s*/, '').trim());
      }
      continue;
    }
    if (/^constraints\s*[:=]/i.test(line)) {
      currentList = 'constraints';
      const firstItem = line.replace(/^constraints\s*[:=]\s*/i, '').trim();
      if (firstItem) {
        constraints.push(firstItem.replace(/^-+\s*/, '').trim());
      }
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
  const text = result.protocolRawText || extractMessageText(result) || result.lastText;
  const directive = result.managedProtocolPayload?.verdict ?? parseManagedTaskVerdictDirective(text);
  if (!directive) {
    if (options?.enforceVerdictBlock) {
      const reason = `Evaluator response omitted required ${MANAGED_TASK_VERDICT_BLOCK} block.`;
      const compacted = compactManagedProtocolFailureResult(result, {
        id: 'evaluator',
        title: 'Evaluator',
        role: 'evaluator',
        terminalAuthority: false,
        execution: 'serial',
        agent: 'default',
        prompt: '',
      }, `missing ${MANAGED_TASK_VERDICT_BLOCK}`);
      return {
        directive: {
          source: 'evaluator',
          status: 'blocked',
          reason: 'Evaluator omitted the required structured verification payload.',
          debugReason: reason,
          protocolParseFailed: true,
          followups: [
            `Re-run the evaluator and require a final ${MANAGED_TASK_VERDICT_BLOCK} fenced block with accept, revise, or blocked.`,
          ],
          userFacingText: compacted.visibleText,
          rawResponseText: compacted.rawText,
        },
        result: {
          ...compacted.result,
          protocolRawText: undefined,
          managedProtocolPayload: undefined,
        },
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
      ...withManagedProtocolPayload(result, { verdict: directive }),
      protocolRawText: undefined,
      lastText: sanitizedText,
      messages: replaceLastAssistantMessage(result.messages, sanitizedText),
    },
  };
}

function sanitizeContractResult(
  result: KodaXResult,
): { result: KodaXResult; directive?: ManagedTaskContractDirective } {
  const text = extractMessageText(result) || result.lastText;
  const directive = result.managedProtocolPayload?.contract ?? parseManagedTaskContractDirective(text);
  if (!directive) {
    return { result };
  }

  const sanitizedText = directive.summary || sanitizeManagedUserFacingText(text) || text;
  return {
    directive,
    result: {
      ...withManagedProtocolPayload(result, { contract: directive }),
      lastText: sanitizedText,
      messages: replaceLastAssistantMessage(result.messages, sanitizedText),
    },
  };
}

function isManagedBlockingEvidenceEmpty(items: string[] | undefined): boolean {
  return !items || items.length === 0 || items.every((item) => {
    const normalized = item.trim().toLowerCase();
    return !normalized || normalized === 'none' || normalized === 'n/a' || normalized === 'na' || normalized === '-';
  });
}

function validateScoutDirectiveConsistency(
  directive: ManagedTaskScoutDirective,
  primaryTask?: KodaXTaskRoutingDecision['primaryTask'],
): string | undefined {
  const harness = directive.confirmedHarness;
  if (!harness) {
    return 'missing confirmed_harness';
  }

  const hasRationale = Boolean(directive.harnessRationale?.trim());
  const noBlockingEvidence = isManagedBlockingEvidenceEmpty(directive.blockingEvidence);
  const hasUserFacingReviewConclusion = Boolean(
    directive.userFacingText?.trim()
    || directive.summary?.trim(),
  );

  if (harness === 'H0_DIRECT') {
    // FEATURE_067: H0 allows both direct_completion_ready values:
    //   'yes' → text-only completion (greeting, lookup, review)
    //   'no'  → needs write tools → triggers H0 continuation path
    if (directive.directCompletionReady !== 'yes' && directive.directCompletionReady !== 'no') {
      return 'H0_DIRECT requires direct_completion_ready: yes or no';
    }
    if (!noBlockingEvidence) {
      return 'H0_DIRECT requires blocking_evidence to be empty or "none"';
    }
    if (!hasRationale) {
      return 'H0_DIRECT requires harness_rationale';
    }
    if (primaryTask === 'review' && directive.directCompletionReady === 'yes' && !hasUserFacingReviewConclusion) {
      return 'H0_DIRECT review decisions require a user-facing review conclusion or summary';
    }
    return undefined;
  }

  if (directive.directCompletionReady === 'yes') {
    return `${harness} requires direct_completion_ready: no (not yes)`;
  }
  if (!hasRationale) {
    return `${harness} requires harness_rationale`;
  }
  if (noBlockingEvidence) {
    return `${harness} requires at least one non-empty blocking_evidence item`;
  }
  return undefined;
}

function sanitizeScoutResult(
  result: KodaXResult,
  options?: { primaryTask?: KodaXTaskRoutingDecision['primaryTask'] },
): { result: KodaXResult; directive?: ManagedTaskScoutDirective; failureReason?: string } {
  const text = extractMessageText(result) || result.lastText;
  const directive = result.managedProtocolPayload?.scout ?? parseManagedTaskScoutDirective(text);
  if (!directive) {
    const reason = `Scout response omitted required ${MANAGED_TASK_SCOUT_BLOCK} block.`;
    return {
      directive: undefined,
      failureReason: `missing ${MANAGED_TASK_SCOUT_BLOCK}`,
      result: {
        ...result,
        success: false,
        signal: 'BLOCKED',
        signalReason: reason,
      },
    };
  }

  const consistencyFailure = validateScoutDirectiveConsistency(directive, options?.primaryTask);
  if (consistencyFailure) {
    const reason = `Scout response produced an inconsistent ${MANAGED_TASK_SCOUT_BLOCK} payload: ${consistencyFailure}.`;
    return {
      directive: undefined,
      failureReason: consistencyFailure,
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
      ...withManagedProtocolPayload(result, { scout: directive }),
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
  const directive = result.managedProtocolPayload?.handoff ?? parseManagedTaskHandoffDirective(text);
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
      ...withManagedProtocolPayload(result, { handoff: directive }),
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
    feedback.rawArtifactPath
      ? `Previous round raw response artifact: ${feedback.rawArtifactPath}`
      : undefined,
    feedback.reason ? `Reason: ${feedback.reason}` : undefined,
    feedback.debugReason ? `Debug reason: ${feedback.debugReason}` : undefined,
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
  const rawArtifactPath = directive.rawResponseText?.trim()
    ? path.join(workspaceDir, 'feedback-raw.txt')
    : undefined;
  await writeFile(
    artifactPath,
    `${JSON.stringify({
      source: directive.source,
      status: directive.status,
      reason: directive.reason ?? null,
      debugReason: directive.debugReason ?? null,
      protocolParseFailed: directive.protocolParseFailed ?? false,
      nextHarness: directive.nextHarness ?? null,
      verificationDegraded: directive.verificationDegraded ?? false,
      continuationSuggested: directive.continuationSuggested ?? null,
      preferredFallbackWorkerId: directive.preferredFallbackWorkerId ?? null,
      followups: directive.followups,
      userFacingText: directive.userFacingText,
      rawArtifactPath: rawArtifactPath ?? null,
    }, null, 2)}\n`,
    'utf8',
  );
  if (rawArtifactPath) {
    await writeFile(rawArtifactPath, `${directive.rawResponseText!.trim()}\n`, 'utf8');
  }
  await writeFile(
    markdownPath,
    [
      `# ${directive.source === 'worker' ? 'Worker Handoff' : 'Evaluator'} Feedback`,
      '',
      `- Status: ${directive.status}`,
      directive.reason ? `- Reason: ${directive.reason}` : undefined,
      directive.debugReason ? `- Debug reason: ${directive.debugReason}` : undefined,
      directive.nextHarness ? `- Requested harness: ${directive.nextHarness}` : undefined,
      rawArtifactPath ? `- Raw response artifact: ${rawArtifactPath}` : undefined,
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
    rawArtifactPath,
    rawResponseText: undefined,
  };
}

function maybeBuildDegradedEvaluatorDirective(
  directive: ManagedTaskVerdictDirective | undefined,
  workerResults: Map<string, KodaXResult>,
  workerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] },
): ManagedTaskVerdictDirective | undefined {
  if (
    !directive
    || directive.source !== 'evaluator'
    || !directive.rawResponseText?.trim()
    || directive.protocolParseFailed !== true
  ) {
    return directive;
  }

  const fallbackWorker = workerSet.workers.find((worker) => worker.role === 'generator');
  const fallbackResult = fallbackWorker ? workerResults.get(fallbackWorker.id) : undefined;
  const fallbackText = sanitizeManagedUserFacingText(
    extractMessageText(fallbackResult) || fallbackResult?.lastText || '',
  ).trim();

  if (!fallbackWorker || !fallbackResult || !fallbackText) {
    return directive;
  }

  const degradedReason = `Evaluator omitted the required structured verification data after ${MANAGED_TASK_ROUTER_MAX_RETRIES} attempts. Showing the best available generator answer while keeping verification blocked.`;

  return {
    ...directive,
    status: 'blocked',
    reason: degradedReason,
    debugReason: directive.debugReason,
    userFacingText: buildVerificationDegradedVisibleText(fallbackText, degradedReason),
    userAnswer: buildVerificationDegradedVisibleText(fallbackText, degradedReason),
    verificationDegraded: true,
    continuationSuggested: true,
    preferredFallbackWorkerId: fallbackWorker.id,
    followups: [
      ...directive.followups,
      'Inspect the raw evaluator artifact or rerun the evaluator before treating this result as fully verified.',
    ],
  };
}

const MAX_MANAGED_TIMELINE_EVENTS = 64;

function createManagedLiveEvent(
  key: string,
  kind: KodaXManagedLiveEvent['kind'],
  summary: string,
  options?: {
    detail?: string;
    presentation?: KodaXManagedLiveEvent['presentation'];
    phase?: KodaXManagedLiveEvent['phase'];
    worker?: Pick<ManagedTaskWorkerSpec, 'id' | 'title'>;
    persistToHistory?: boolean;
  },
): KodaXManagedLiveEvent {
  return {
    key,
    kind,
    summary,
    detail: options?.detail,
    presentation: options?.presentation,
    phase: options?.phase,
    workerId: options?.worker?.id,
    workerTitle: options?.worker?.title,
    persistToHistory: options?.persistToHistory,
  };
}

function appendManagedTimelineEvent(
  timeline: readonly KodaXManagedLiveEvent[],
  event: KodaXManagedLiveEvent,
): KodaXManagedLiveEvent[] {
  const existingIndex = timeline.findIndex((entry) => entry.key === event.key);
  if (existingIndex >= 0) {
    const existing = timeline[existingIndex];
    if (
      existing.summary === event.summary
      && (existing.detail ?? '') === (event.detail ?? '')
      && existing.workerId === event.workerId
      && existing.phase === event.phase
      && existing.kind === event.kind
      && existing.presentation === event.presentation
      && existing.persistToHistory === event.persistToHistory
    ) {
      return [...timeline];
    }

    const nextTimeline = [...timeline];
    nextTimeline[existingIndex] = event;
    return nextTimeline.slice(-MAX_MANAGED_TIMELINE_EVENTS);
  }

  const previous = timeline[timeline.length - 1];
  if (
    previous
    && previous.summary === event.summary
    && (previous.detail ?? '') === (event.detail ?? '')
    && previous.workerId === event.workerId
    && previous.phase === event.phase
    && previous.kind === event.kind
    && previous.presentation === event.presentation
  ) {
    return [...timeline];
  }

  return [...timeline, event].slice(-MAX_MANAGED_TIMELINE_EVENTS);
}

function createWorkerEvents(
  baseEvents: KodaXEvents | undefined,
  worker: ManagedTaskWorkerSpec,
  forwardStream: boolean,
  controller?: ManagedTaskBudgetController,
  options?: {
    emitContent?: boolean;
    emitToolEvents?: boolean;
    emitProgressEventsWhenHidden?: boolean;
    emitIterationEvents?: boolean;
    statusContext?: {
      agentMode: KodaXAgentMode;
      harnessProfile: KodaXTaskRoutingDecision['harnessProfile'];
      currentRound: number;
      maxRounds: number;
      upgradeCeiling?: KodaXTaskRoutingDecision['harnessProfile'];
      recordLiveEvent?: (event: KodaXManagedLiveEvent) => void;
    };
    mutationTracker?: ManagedMutationTracker;
  },
): KodaXEvents | undefined {
  if (!baseEvents && !worker.beforeToolExecute && !controller) {
    return undefined;
  }

  const emitContent = options?.emitContent ?? true;
  const emitToolEvents = options?.emitToolEvents ?? emitContent;
  const emitProgressEventsWhenHidden = options?.emitProgressEventsWhenHidden ?? !emitContent;
  const emitIterationEvents = options?.emitIterationEvents ?? false;
  const statusContext = options?.statusContext;
  let textPrefixed = false;
  let thinkingPrefixed = false;
  const prefix = `[${worker.title}] `;
  const thinkingPrefix = `[${worker.title} thinking] `;
  let hiddenTextBuffer = '';
  let hiddenThinkingBuffer = '';
  let hiddenTextLastLength = 0;
  let hiddenThinkingLastLength = 0;
  let lastHiddenTextNote: string | undefined;
  let lastHiddenThinkingNote: string | undefined;
  let visibleTextBuffer = '';
  let emittedVisibleText = '';

  const emitWorkerStatusNote = (
    note: string,
    detailNote: string | undefined,
    options: {
      eventKey: string;
      presentation?: KodaXManagedLiveEvent['presentation'];
      persistToHistory?: boolean;
    },
  ): void => {
    if (!statusContext || !baseEvents?.onManagedTaskStatus) {
      return;
    }
    const event = createManagedLiveEvent(
      options.eventKey,
      /completed|finished|blocked|failed|ready/i.test(note) ? 'completed' : 'progress',
      note,
      {
        detail: detailNote ?? note,
        presentation: options.presentation,
        phase: 'worker',
        worker,
        persistToHistory: options.persistToHistory,
      },
    );
    statusContext.recordLiveEvent?.(event);
    baseEvents.onManagedTaskStatus({
      agentMode: statusContext.agentMode,
      harnessProfile: statusContext.harnessProfile,
      activeWorkerId: worker.id,
      activeWorkerTitle: worker.title,
      currentRound: statusContext.currentRound,
      maxRounds: statusContext.maxRounds,
      phase: 'worker',
      note,
      detailNote,
      events: [event],
      persistToHistory: options.persistToHistory,
      upgradeCeiling: statusContext.upgradeCeiling,
      ...buildManagedStatusBudgetFields(controller),
    });
  };

  const normalizeHiddenWorkerProgress = (value: string): string => (
    sanitizeManagedUserFacingText(value)
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );

  const buildHiddenWorkerProgressNotes = (
    kind: 'text' | 'thinking',
    value: string,
  ): { note: string; detailNote: string } | undefined => {
    const normalized = normalizeHiddenWorkerProgress(value);
    if (!normalized) {
      return undefined;
    }
    const compactSource = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-2)
      .join(' / ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!compactSource) {
      return undefined;
    }
    const compact = truncateText(compactSource, 180);
    const detail = truncateText(normalized, 2400);
    const labelPrefix = kind === 'thinking'
      ? `${worker.title} thinking: `
      : `${worker.title}: `;
    return {
      note: `${labelPrefix}${compact}`,
      detailNote: `${labelPrefix}${detail}`,
    };
  };

  const maybeEmitHiddenWorkerProgress = (
    kind: 'text' | 'thinking',
    delta: string,
    force = false,
  ): void => {
    if (emitContent || !emitProgressEventsWhenHidden || !delta) {
      return;
    }
    if (kind === 'text') {
      hiddenTextBuffer = `${hiddenTextBuffer}${delta}`.slice(-6000);
    } else {
      hiddenThinkingBuffer = `${hiddenThinkingBuffer}${delta}`.slice(-6000);
    }
    const source = kind === 'text' ? hiddenTextBuffer : hiddenThinkingBuffer;
    const normalized = normalizeHiddenWorkerProgress(source);
    if (!normalized) {
      return;
    }
    const lastLength = kind === 'text' ? hiddenTextLastLength : hiddenThinkingLastLength;
    const growth = normalized.length - lastLength;
    const hasBoundary = /[\r\n]/.test(delta) || /[.!?。！？:：]\s*$/.test(delta.trimEnd());
    if (!force && growth < 80 && !hasBoundary) {
      return;
    }
    if (!force && growth < 40) {
      return;
    }
    const notes = buildHiddenWorkerProgressNotes(kind, source);
    if (!notes) {
      return;
    }
    const lastNote = kind === 'text' ? lastHiddenTextNote : lastHiddenThinkingNote;
    if (notes.note === lastNote) {
      return;
    }
    emitWorkerStatusNote(notes.note, notes.detailNote, {
      eventKey: `worker-${statusContext?.currentRound ?? 1}-${worker.id}-hidden-${kind}`,
      presentation: kind === 'thinking' ? 'thinking' : 'assistant',
      persistToHistory: true,
    });
    if (kind === 'text') {
      lastHiddenTextNote = notes.note;
      hiddenTextLastLength = normalized.length;
    } else {
      lastHiddenThinkingNote = notes.note;
      hiddenThinkingLastLength = normalized.length;
    }
  };

  const flushHiddenWorkerProgress = (kind: 'text' | 'thinking'): void => {
    if (!emitProgressEventsWhenHidden) {
      return;
    }
    const source = kind === 'text' ? hiddenTextBuffer : hiddenThinkingBuffer;
    const notes = buildHiddenWorkerProgressNotes(kind, source);
    if (!notes) {
      return;
    }
    const lastNote = kind === 'text' ? lastHiddenTextNote : lastHiddenThinkingNote;
    if (notes.note === lastNote) {
      return;
    }
    emitWorkerStatusNote(notes.note, notes.detailNote, {
      eventKey: `worker-${statusContext?.currentRound ?? 1}-${worker.id}-hidden-${kind}`,
      presentation: kind === 'thinking' ? 'thinking' : 'assistant',
      persistToHistory: true,
    });
    const normalized = normalizeHiddenWorkerProgress(source);
    if (kind === 'text') {
      lastHiddenTextNote = notes.note;
      hiddenTextLastLength = normalized.length;
    } else {
      lastHiddenThinkingNote = notes.note;
      hiddenThinkingLastLength = normalized.length;
    }
  };

  const buildVisibleWorkerTextDelta = (delta: string): string => {
    visibleTextBuffer += delta;
    const sanitized = worker.role === 'evaluator'
      ? sanitizeEvaluatorPublicAnswer(sanitizeManagedStreamingText(visibleTextBuffer))
      : sanitizeManagedStreamingText(visibleTextBuffer);

    if (!sanitized) {
      return '';
    }
    if (!emittedVisibleText) {
      emittedVisibleText = sanitized;
      return sanitized;
    }
    if (sanitized.startsWith(emittedVisibleText)) {
      const nextDelta = sanitized.slice(emittedVisibleText.length);
      emittedVisibleText = sanitized;
      return nextDelta;
    }

    emittedVisibleText = sanitized;
    return '';
  };

  return {
    askUser: baseEvents?.askUser,
    beforeToolExecute: async (tool, input) => {
      const workerDecision = await worker.beforeToolExecute?.(tool, input);
      if (workerDecision !== undefined && workerDecision !== true) {
        return workerDecision;
      }
      // Track mutations for scope-aware protocol responses.
      const tracker = options?.mutationTracker;
      if (tracker) {
        const normalizedTool = tool.toLowerCase();
        if (WRITE_ONLY_TOOLS.has(normalizedTool) || normalizedTool === 'bash') {
          const filePath = typeof input?.file_path === 'string' ? input.file_path
            : typeof input?.path === 'string' ? input.path
            : undefined;
          if (filePath) {
            const oldLen = typeof input?.old_string === 'string' ? input.old_string.split('\n').length : 0;
            const newLen = typeof input?.new_string === 'string' ? input.new_string.split('\n').length : 0;
            const contentLen = typeof input?.content === 'string' ? input.content.split('\n').length : 0;
            const linesDelta = contentLen || Math.abs(newLen - oldLen) || 1;
            tracker.files.set(filePath, (tracker.files.get(filePath) || 0) + linesDelta);
            tracker.totalOps += 1;
          } else if (normalizedTool === 'bash') {
            const cmd = typeof input?.command === 'string' ? input.command : '';
            if (/\b(git\s+(add|commit|push|merge|rebase|reset)|npm\s+(publish|install)|rm\s|mv\s|cp\s)/i.test(cmd)) {
              tracker.totalOps += 1;
            }
          }
        }
      }
      const baseDecision = await baseEvents?.beforeToolExecute?.(tool, input);
      return baseDecision ?? true;
    },
    onIterationStart: (iter, maxIter) => {
      if (controller) {
        incrementManagedBudgetUsage(controller);
      }
      if (emitIterationEvents) {
        baseEvents?.onIterationStart?.(iter, maxIter);
      }
    },
    onIterationEnd: (info) => {
      if (emitIterationEvents) {
        baseEvents?.onIterationEnd?.(info);
      }
    },
    onTextDelta: (text) => {
      if (!emitContent || !text) {
        maybeEmitHiddenWorkerProgress('text', text);
        return;
      }
      const visibleDelta = buildVisibleWorkerTextDelta(text);
      if (!visibleDelta) {
        return;
      }
      const rendered = forwardStream
        ? visibleDelta
        : textPrefixed ? visibleDelta : `${prefix}${visibleDelta}`;
      textPrefixed = !forwardStream;
      baseEvents?.onTextDelta?.(rendered);
    },
    onThinkingDelta: (text) => {
      if (!emitContent || !text) {
        maybeEmitHiddenWorkerProgress('thinking', text);
        return;
      }
      const rendered = forwardStream
        ? text
        : thinkingPrefixed ? text : `${thinkingPrefix}${text}`;
      thinkingPrefixed = !forwardStream;
      baseEvents?.onThinkingDelta?.(rendered);
    },
    onThinkingEnd: (thinking) => {
      if (!emitContent) {
        if (thinking && thinking.length > hiddenThinkingBuffer.length) {
          hiddenThinkingBuffer = thinking.slice(-6000);
        }
        flushHiddenWorkerProgress('thinking');
        thinkingPrefixed = false;
        return;
      }
      baseEvents?.onThinkingEnd?.(forwardStream ? thinking : `${prefix}${thinking}`);
      thinkingPrefixed = false;
    },
    onToolUseStart: (tool) => {
      if (!emitToolEvents) {
        return;
      }
      baseEvents?.onToolUseStart?.({
        ...tool,
        name: forwardStream ? tool.name : `${worker.title}:${tool.name}`,
      });
    },
    onToolResult: (result) => {
      if (!emitToolEvents) {
        return;
      }
      baseEvents?.onToolResult?.({
        ...result,
        name: forwardStream ? result.name : `${worker.title}:${result.name}`,
      });
    },
    onToolInputDelta: (toolName, partialJson, meta) => {
      if (!emitToolEvents) {
        return;
      }
      baseEvents?.onToolInputDelta?.(
        forwardStream ? toolName : `${worker.title}:${toolName}`,
        partialJson,
        meta,
      );
    },
    onRetry: baseEvents?.onRetry,
    onProviderRecovery: baseEvents?.onProviderRecovery,
    onProviderRateLimit: baseEvents?.onProviderRateLimit,
    onError: baseEvents?.onError,
    onStreamEnd: () => {
      if (!emitContent) {
        flushHiddenWorkerProgress('text');
        flushHiddenWorkerProgress('thinking');
        textPrefixed = false;
        thinkingPrefixed = false;
        return;
      }
      if (textPrefixed) {
        baseEvents?.onTextDelta?.('\n');
      }
      if (thinkingPrefixed) {
        baseEvents?.onThinkingDelta?.('\n');
      }
      textPrefixed = false;
      thinkingPrefixed = false;
    },
    // FEATURE_067 v2: Pass through tool progress events for dispatch_child_task transcript updates.
    onToolProgress: baseEvents?.onToolProgress,
  };
}

function buildManagedWorkerSessionId(
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
): string {
  return `managed-task-worker-${task.contract.taskId}-${worker.id}`;
}

// FEATURE_061 Phase 3: Added continueFromSessionId for Scout→Worker context continuation.
function createWorkerSession(
  session: KodaXOptions['session'],
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  storage: KodaXSessionStorage | undefined,
  memoryStrategy: KodaXMemoryStrategy,
  compactInitialMessages?: KodaXSessionData['messages'],
  continueFromSessionId?: string,
): KodaXOptions['session'] {
  if (continueFromSessionId && storage) {
    return {
      ...session,
      id: continueFromSessionId,
      scope: 'managed-task-worker',
      resume: true,
      autoResume: true,
      storage,
    };
  }
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

function buildContextInputEvidenceArtifacts(
  context: KodaXOptions['context'] | undefined,
): KodaXTaskEvidenceArtifact[] {
  return (context?.inputArtifacts ?? []).flatMap((artifact) => (
    artifact.kind === 'image'
      ? [{
          kind: 'image' as const,
          path: artifact.path,
          description: artifact.description ?? 'Input image artifact',
        }]
      : []
  ));
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
  recordLiveEvent: ((event: KodaXManagedLiveEvent) => void) | undefined,
  maxRounds: number,
  continueFromSessionId?: string,
): KodaXOptions {
  worker.memoryStrategy = memoryStrategy;
  worker.budgetSnapshot = budgetSnapshot;
  const compactInitialMessages = memoryStrategy === 'compact' && sessionStorage instanceof ManagedWorkerSessionStorage
    ? buildCompactInitialMessages(task, worker, sessionStorage, budgetSnapshot?.currentRound ?? 1)
    : undefined;
  const emitManagedWorkerContent = !isManagedBackgroundFanoutWorker(worker);
  const managedProtocolEmission = worker.role !== 'direct' && (!worker.terminalAuthority || worker.role !== 'generator')
    ? {
        enabled: true as const,
        role: worker.role as Exclude<KodaXTaskRole, 'direct'>,
      }
    : undefined;
  const roleEvents = createWorkerEvents(
    defaultOptions.events,
    worker,
    emitManagedWorkerContent,
    controller,
    {
      emitContent: emitManagedWorkerContent,
      emitToolEvents: emitManagedWorkerContent,
      emitProgressEventsWhenHidden: !emitManagedWorkerContent,
      emitIterationEvents: true,
      statusContext: {
        agentMode: defaultOptions.agentMode ?? 'ama',
        harnessProfile: task.contract.harnessProfile,
        currentRound: budgetSnapshot?.currentRound ?? 1,
        maxRounds,
        upgradeCeiling: task.runtime?.upgradeCeiling,
        recordLiveEvent,
      },
    },
  );
  return {
    ...defaultOptions,
    maxIter: resolveRemainingManagedWorkBudget(controller),
    session: createWorkerSession(defaultOptions.session, task, worker, sessionStorage, memoryStrategy, compactInitialMessages, continueFromSessionId),
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
      managedProtocolEmission,
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

// FEATURE_061 Phase 3: Scout session is persisted to sessionStorage so H1/H2 workers can continue it.
async function runManagedScoutStage(
  options: KodaXOptions,
  prompt: string,
  plan: ReasoningPlan,
  controller: ManagedTaskBudgetController,
  sessionStorage?: ManagedWorkerSessionStorage,
): Promise<{ result: KodaXResult; directive: ManagedTaskScoutDirective; scoutSessionId?: string }> {
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
  // Mutation tracker: shared between createWorkerEvents (counts) and toolEmitManagedProtocol (reads).
  const scoutMutationTracker: ManagedMutationTracker = { files: new Map(), totalOps: 0 };
  const scoutEvents = createWorkerEvents(options.events, scoutWorker, true, controller, {
    emitContent: true,
    emitToolEvents: true,
    emitProgressEventsWhenHidden: false,
    emitIterationEvents: true,
    statusContext: {
      agentMode: options.agentMode ?? 'ama',
      harnessProfile: plan.decision.harnessProfile,
      currentRound: 1,
      maxRounds: 1,
      upgradeCeiling: plan.decision.topologyCeiling,
    },
    mutationTracker: scoutMutationTracker,
  });

  // FEATURE_061 Phase 3: Persist Scout session so H1/H2 workers can continue it.
  const scoutSessionId = sessionStorage ? `managed-scout-${randomUUID()}` : undefined;
  const scoutOptions: KodaXOptions = {
    ...options,
    maxIter: resolveRemainingManagedWorkBudget(controller),
    session: scoutSessionId && sessionStorage
      ? {
          ...options.session,
          id: scoutSessionId,
          scope: 'managed-task-worker',
          resume: false,
          autoResume: false,
          storage: sessionStorage,
        }
      : options.session,
    events: scoutEvents
      ? {
          ...options.events,
          ...scoutEvents,
        }
      : options.events,
    context: {
      ...options.context,
      managedProtocolEmission: {
        enabled: true,
        role: 'scout',
      },
      mutationTracker: scoutMutationTracker,
      promptOverlay: [
        options.context?.promptOverlay,
        plan.promptOverlay,
        '[Scout Phase] Assess scope, declare confirmed_harness, and for H0 tasks complete the work directly. For H1/H2 tasks, stop after investigation.',
      ].filter(Boolean).join('\n\n'),
    },
  };

  let currentPrompt = basePrompt;
  let lastResult: KodaXResult | undefined;
  for (let attempt = 1; attempt <= MANAGED_TASK_ROUTER_MAX_RETRIES; attempt += 1) {
    const result = await runDirectKodaX(scoutOptions, currentPrompt);
    lastResult = result;
    const sanitized = sanitizeScoutResult(result, { primaryTask: plan.decision.primaryTask });
    if (sanitized.directive) {
      return { result: sanitized.result, directive: sanitized.directive, scoutSessionId };
    }
    if (attempt < MANAGED_TASK_ROUTER_MAX_RETRIES) {
      const failureReason = sanitized.failureReason ?? `missing ${MANAGED_TASK_SCOUT_BLOCK}`;
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
        failureReason,
        buildProtocolRetryRoleSummary(
          scoutWorker,
          sanitized.result,
          attempt,
          failureReason,
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
      harnessRationale: 'Fallback scout directive used the current routing decision after structured retries were exhausted.',
      blockingEvidence: plan.decision.harnessProfile === 'H0_DIRECT'
        ? []
        : ['Structured scout output was incomplete, so managed execution must continue.'],
      // FEATURE_067: Fallback always sets 'no' — if Scout couldn't emit the managed protocol
      // block properly, we cannot assume the task is complete. For H0 tasks needing writes,
      // this triggers the H0 continuation path (re-run with write tools).
      directCompletionReady: 'no',
      userFacingText: sanitizeManagedUserFacingText(extractMessageText(lastResult) || ''),
    },
    scoutSessionId,
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
  result: Pick<KodaXResult, 'success' | 'lastText' | 'sessionId' | 'signal' | 'signalReason' | 'signalDebugReason'>,
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
        signalDebugReason: task.verdict.signalDebugReason ?? null,
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
  const degradedFallbackResult = task.runtime?.degradedVerification?.fallbackWorkerId
    ? workerResults.get(task.runtime.degradedVerification.fallbackWorkerId)
    : undefined;
  if (degradedFallbackResult) {
    const finalText = applyDegradedContinueNote(
      task,
      task.verdict.summary || extractMessageText(degradedFallbackResult) || degradedFallbackResult.lastText,
    );
    return mergeManagedTaskIntoResult(
        {
          ...degradedFallbackResult,
          success: task.verdict.status === 'completed',
          lastText: finalText,
          signal: task.verdict.signal ?? (task.verdict.status === 'blocked' ? 'BLOCKED' : degradedFallbackResult.signal),
          signalReason: task.verdict.signalReason ?? degradedFallbackResult.signalReason,
          signalDebugReason: task.verdict.signalDebugReason ?? degradedFallbackResult.signalDebugReason,
          messages: replaceLastAssistantMessage(degradedFallbackResult.messages, finalText),
        },
        task,
    );
  }

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
          signalDebugReason: task.verdict.signalDebugReason ?? terminalResult.signalDebugReason,
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
          signalDebugReason: task.verdict.signalDebugReason ?? fallbackResult.signalDebugReason,
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
      signalDebugReason: task.verdict.signalDebugReason,
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

// FEATURE_062: Simplified — no reserve budget, just update harness.
function consumeHarnessUpgradeBudget(
  controller: ManagedTaskBudgetController,
  fromHarness: KodaXTaskRoutingDecision['harnessProfile'],
  toHarness: KodaXTaskRoutingDecision['harnessProfile'],
): { granted: boolean; cost: number; reason?: string } {
  const cost = getHarnessUpgradeCost(fromHarness, toHarness);
  if (cost <= 0) {
    return { granted: false, cost: 0, reason: 'Requested harness is not stronger than the current harness.' };
  }
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
    ? `Do not stop until you either call "${MANAGED_PROTOCOL_TOOL_NAME}" with a valid planner payload or append a valid \`\`\`${MANAGED_TASK_CONTRACT_BLOCK}\`\`\` block.`
    : undefined;
  return [
    prompt,
    [
      '[Managed Task Protocol Retry]',
      `Previous ${worker.title} output could not be safely consumed: ${reason}`,
      `Re-run the same role, keep the user-facing content, and submit the required structured protocol payload via "${MANAGED_PROTOCOL_TOOL_NAME}". If tool calling is unavailable, append the required fallback closing block exactly once at the end.`,
      'Do not explain internal protocol tools, fenced blocks, MCP, capability runtimes, or extension runtimes in the user-facing answer.',
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
  const compacted = compactManagedProtocolFailureResult(result, worker, reason);
  return {
    ...compacted.result,
    protocolRawText: worker.role === 'evaluator'
      ? compacted.rawText
      : undefined,
  };
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
    const rawResult = attempts === 1
      ? await executeDefault()
      : await runDirectKodaX(preparedOptions, currentPrompt);
    const text = extractMessageText(rawResult) || rawResult.lastText;
    const hydratedProtocolPayload = hydrateManagedProtocolPayloadVisibleText(
      rawResult.managedProtocolPayload,
      text,
    );
    const fallbackProtocolPayload: Partial<KodaXManagedProtocolPayload> = worker.role === 'evaluator'
      ? (hydratedProtocolPayload?.verdict ? {} : { verdict: parseManagedTaskVerdictDirective(text) })
      : worker.role === 'planner'
        ? (hydratedProtocolPayload?.contract ? {} : { contract: parseManagedTaskContractDirective(text) })
        : worker.role === 'scout'
          ? (hydratedProtocolPayload?.scout ? {} : { scout: parseManagedTaskScoutDirective(text) })
          : worker.role === 'generator' && !worker.terminalAuthority
            ? (hydratedProtocolPayload?.handoff ? {} : { handoff: parseManagedTaskHandoffDirective(text) })
            : {};
    const protocolPayload = mergeManagedProtocolPayload(hydratedProtocolPayload, fallbackProtocolPayload);
    const result = protocolPayload
      ? withManagedProtocolPayload(rawResult, protocolPayload)
      : rawResult;
    lastResult = result;

    const requiredBlockReason =
      worker.role === 'evaluator'
        ? (!result.managedProtocolPayload?.verdict ? `missing ${MANAGED_TASK_VERDICT_BLOCK}` : undefined)
        : worker.role === 'planner'
          ? (!result.managedProtocolPayload?.contract ? `missing ${MANAGED_TASK_CONTRACT_BLOCK}` : undefined)
          : worker.role === 'scout'
            ? (!result.managedProtocolPayload?.scout ? `missing ${MANAGED_TASK_SCOUT_BLOCK}` : undefined)
            : worker.role === 'generator' && !worker.terminalAuthority
                ? (!result.managedProtocolPayload?.handoff ? `missing ${MANAGED_TASK_HANDOFF_BLOCK}` : undefined)
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
  recordLiveEvent?: (event: KodaXManagedLiveEvent) => void,
): OrchestrationRunEvents<ManagedTaskWorkerSpec, string> | undefined {
  if (!baseEvents?.onManagedTaskStatus) {
    return undefined;
  }

  const buildWorkerStartNote = (task: ManagedTaskWorkerSpec): string => (
    `${task.title} starting`
  );

  const buildWorkerProgressNote = (
    task: ManagedTaskWorkerSpec,
    message: string,
  ): { note: string; detailNote?: string } | undefined => {
    const trimmed = message.trim();
    if (!trimmed) {
      return undefined;
    }

    if (/^Launching\s+/i.test(trimmed)) {
      return undefined;
    }

    if (/^Worker finished successfully$/i.test(trimmed)) {
      return undefined;
    }

    const signalMatch = trimmed.match(/^Worker finished with signal=(\w+)(?:\s*\((.+)\))?$/i);
    if (signalMatch) {
      const [, signal, reason] = signalMatch;
      const detailReason = reason?.trim();
      return {
        note: detailReason
          ? `${task.title} finished with ${signal}: ${truncateText(detailReason, 180)}`
          : `${task.title} finished with ${signal}`,
        detailNote: detailReason
          ? `${task.title} finished with ${signal}: ${truncateText(detailReason, 2400)}`
          : `${task.title} finished with ${signal}`,
      };
    }

    return {
      note: `${task.title}: ${truncateText(trimmed, 180)}`,
      detailNote: `${task.title}: ${truncateText(trimmed, 2400)}`,
    };
  };

  const buildWorkerCompletionNote = (
    task: ManagedTaskWorkerSpec,
    completed: OrchestrationCompletedTask<ManagedTaskWorkerSpec, string>,
  ): { note: string; detailNote?: string } => {
    const fullSummary = (completed.result.summary ?? '').trim();
    const summary = truncateText(fullSummary, 220);
    return {
      note: summary
        ? `${task.title} ${completed.status}: ${summary}`
        : `${task.title} ${completed.status}`,
      detailNote: fullSummary
        ? `${task.title} ${completed.status}: ${truncateText(fullSummary, 4000)}`
        : `${task.title} ${completed.status}`,
    };
  };

  return {
    onTaskStart: async (task) => {
      const note = buildWorkerStartNote(task);
      const event = createManagedLiveEvent(
        `worker-${currentRound}-${task.id}-status`,
        'progress',
        note,
        {
          detail: note,
          presentation: 'status',
          phase: 'worker',
          worker: task,
          persistToHistory: false,
        },
      );
      recordLiveEvent?.(event);
      baseEvents.onManagedTaskStatus?.({
        agentMode,
        harnessProfile,
        activeWorkerId: task.id,
        activeWorkerTitle: task.title,
        currentRound,
        maxRounds,
        phase: 'worker',
        note,
        events: [event],
        persistToHistory: false,
        upgradeCeiling,
        ...buildManagedStatusBudgetFields(controller),
      });
    },
    onTaskMessage: async (task, message) => {
      const progress = buildWorkerProgressNote(task, message);
      if (!progress) {
        return;
      }
      const event = createManagedLiveEvent(
        `worker-${currentRound}-${task.id}-status`,
        'progress',
        progress.note,
        {
          detail: progress.detailNote ?? progress.note,
          presentation: 'status',
          phase: 'worker',
          worker: task,
          persistToHistory: false,
        },
      );
      recordLiveEvent?.(event);
      baseEvents.onManagedTaskStatus?.({
        agentMode,
        harnessProfile,
        activeWorkerId: task.id,
        activeWorkerTitle: task.title,
        currentRound,
        maxRounds,
        phase: 'worker',
        note: progress.note,
        detailNote: progress.detailNote,
        events: [event],
        persistToHistory: false,
        upgradeCeiling,
        ...buildManagedStatusBudgetFields(controller),
      });
    },
    onTaskComplete: async (task, completed) => {
      const completion = buildWorkerCompletionNote(task, completed);
      const event = createManagedLiveEvent(
        `worker-${currentRound}-${task.id}-status`,
        'completed',
        completion.note,
        {
          detail: completion.detailNote ?? completion.note,
          presentation: 'status',
          phase: 'worker',
          worker: task,
          persistToHistory: false,
        },
      );
      recordLiveEvent?.(event);
      baseEvents.onManagedTaskStatus?.({
        agentMode,
        harnessProfile,
        activeWorkerId: task.id,
        activeWorkerTitle: task.title,
        currentRound,
        maxRounds,
        phase: 'worker',
        note: completion.note,
        detailNote: completion.detailNote,
        events: [event],
        persistToHistory: false,
        upgradeCeiling,
        ...buildManagedStatusBudgetFields(controller),
      });
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
  scoutSessionId?: string,
  onWorkerCheckpoint?: (workerId: string) => Promise<void>,
): Promise<ManagedTaskRoundExecution> {
  let directive: ManagedTaskVerdictDirective | undefined;
  let budgetRequest: KodaXBudgetExtensionRequest | undefined;
  let budgetExtensionGranted: number | undefined;
  let budgetExtensionReason: string | undefined;
  let roundLiveEvents: KodaXManagedLiveEvent[] = task.runtime?.managedTimeline
    ? [...task.runtime.managedTimeline]
    : [];
  const workerResults = new Map<string, KodaXResult>();
  const contractDirectives = new Map<string, ManagedTaskContractDirective>();
  const handoffDirectives = new Map<string, ManagedTaskHandoffDirective>();
  let taskSnapshot = task;
  // FEATURE_067 v2: Mutable holder for write worktree paths from dispatch_child_task tool.
  // The callback is passed to each worker's context so the tool can register paths.
  const childWriteWorktreeHolder: { paths: Map<string, string> } = { paths: new Map() };
  const registerChildWriteWorktrees = (worktreePaths: ReadonlyMap<string, string>): void => {
    for (const [childId, path] of worktreePaths) {
      childWriteWorktreeHolder.paths.set(childId, path);
    }
    // Also store into taskSnapshot for orchestration bridge
    taskSnapshot = {
      ...taskSnapshot,
      runtime: {
        ...taskSnapshot.runtime,
        childWriteWorktreePaths: new Map(childWriteWorktreeHolder.paths),
      },
    };
  };
  const recordRoundLiveEvent = (event: KodaXManagedLiveEvent): void => {
    roundLiveEvents = appendManagedTimelineEvent(roundLiveEvents, event);
  };
  // FEATURE_061 Phase 3: First non-evaluator worker in round 1 continues the Scout session.
  const scoutContinuationWorkerId = round === 1 && scoutSessionId
    ? workerSet.workers.find((w) => w.role !== 'evaluator')?.id
    : undefined;
  const managedWorkerRunner = createKodaXTaskRunner<ManagedTaskWorkerSpec>({
    baseOptions: options,
    runAgent: runDirectKodaX,
    createOptions: (worker, _context, defaultOptions) => {
      const workerOpts = buildWorkerRunOptions(
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
        recordRoundLiveEvent,
        maxRounds,
        worker.id === scoutContinuationWorkerId ? scoutSessionId : undefined,
      );
      // FEATURE_067 v2: Inject registerChildWriteWorktrees for Generator (write fan-out via dispatch_child_task)
      if (worker.role === 'generator') {
        workerOpts.context = {
          ...workerOpts.context,
          registerChildWriteWorktrees,
        };
      }
      return workerOpts;
    },
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
      // FEATURE_067 v2: Child agents are now dispatched via dispatch_child_task tool during Generator's turn.
      // Read-only findings are already in the Generator's result.lastText (tool results).
      // Write fan-out: detect worktree paths from task runtime and inject diffs into Evaluator.
      let finalResult = sanitized.result;
      if (
        worker.role === 'generator'
        && task.contract.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
        && taskSnapshot.runtime?.childWriteWorktreePaths
      ) {
        const worktreeMap = taskSnapshot.runtime.childWriteWorktreePaths;
        if (worktreeMap.size > 0) {
          const { collectWriteChildDiffs, buildEvaluatorMergePrompt } = await import('./child-executor.js');
          // Build synthetic results from worktree paths stored during dispatch_child_task execution
          const syntheticResults = Array.from(worktreeMap.keys()).map((childId) => ({
            childId,
            fanoutClass: 'evidence-scan' as const,
            status: 'completed' as const,
            disposition: 'valid' as const,
            summary: '',
            evidenceRefs: [] as string[],
            contradictions: [] as string[],
          }));
          const syntheticBundles = Array.from(worktreeMap.keys()).map((childId) => ({
            id: childId,
            fanoutClass: 'evidence-scan' as const,
            objective: childId,
            readOnly: false,
            evidenceRefs: [] as string[],
            constraints: [] as string[],
          }));
          const writeDiffs = collectWriteChildDiffs(syntheticResults, syntheticBundles, worktreeMap);
          if (writeDiffs.length > 0) {
            const evalPrompt = buildEvaluatorMergePrompt(writeDiffs);
            taskSnapshot = {
              ...taskSnapshot,
              runtime: {
                ...taskSnapshot.runtime,
                childWriteReviewPrompt: evalPrompt,
                childWriteDiffCount: writeDiffs.length,
              },
            };
            const evaluatorWorker = workerSet.workers.find((w) => w.role === 'evaluator');
            if (evaluatorWorker) {
              evaluatorWorker.prompt = `${evaluatorWorker.prompt}\n\n${evalPrompt}`;
            }
          }
        }
      }
      workerResults.set(worker.id, finalResult);
      // FEATURE_071: Notify checkpoint callback after each worker completes.
      if (onWorkerCheckpoint) {
        await onWorkerCheckpoint(worker.id);
      }
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
          ?? sanitized.result.managedProtocolPayload?.contract;
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
      if (worker.role === 'generator' && !worker.terminalAuthority) {
        const handoffDirective = sanitized.directive as ManagedTaskHandoffDirective | undefined;
        if (handoffDirective) {
          handoffDirectives.set(worker.id, handoffDirective);
        }
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
      recordRoundLiveEvent,
    ),
  });

  if (!directive) {
    for (const worker of workerSet.workers) {
      const result = workerResults.get(worker.id);
      if (!result) {
        continue;
      }
      if (worker.role === 'planner') {
        const contractDirective = contractDirectives.get(worker.id);
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
        const handoff = handoffDirectives.get(worker.id);
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

  if (roundLiveEvents.length > 0) {
    taskSnapshot = {
      ...taskSnapshot,
      runtime: {
        ...taskSnapshot.runtime,
        managedTimeline: roundLiveEvents,
      },
    };
  }

  return {
    workerSet,
    workerResults,
    contractDirectives,
    handoffDirectives,
    orchestrationResult,
    taskSnapshot,
    workspaceDir,
    directive,
    budgetRequest,
    budgetExtensionGranted,
    budgetExtensionReason,
    // FEATURE_067 v2: Worktree paths for post-round cleanup
    childWriteWorktreePaths: childWriteWorktreeHolder.paths.size > 0
      ? new Map(childWriteWorktreeHolder.paths)
      : undefined,
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
          signalDebugReason: undefined,
        },
        runtime: {
          ...task.runtime,
          degradedVerification: undefined,
      },
    };
  }

  const signalReason = directive.reason || 'Evaluator requested another revision before acceptance.';
  const continuationSuggested = directive.continuationSuggested ?? (directive.status === 'revise');
  const disposition = continuationSuggested ? 'needs_continuation' : 'blocked';
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
        signalDebugReason: directive.debugReason ?? task.verdict.signalDebugReason,
        disposition,
        continuationSuggested,
      },
    runtime: {
      ...task.runtime,
      degradedVerification: directive.verificationDegraded
        ? {
            fallbackWorkerId: directive.preferredFallbackWorkerId,
            reason: signalReason,
            debugReason: directive.debugReason,
          }
        : task.runtime?.degradedVerification,
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

// FEATURE_071: Resume a managed task from a validated checkpoint.
async function resumeManagedTask(
  options: KodaXOptions,
  prompt: string,
  validated: ValidatedCheckpoint,
): Promise<KodaXResult> {
  const { checkpoint, workspaceDir, managedTask: savedTask } = validated;
  const agentMode = resolveManagedAgentMode(options);

  // Re-run routing to get the plan object (fast, deterministic).
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
  const managedOriginalTask = savedTask.contract.objective;
  let plan = applyAgentModeToPlan(managedPlanning.plan, agentMode);

  // Reconstruct Scout directive from saved runtime state.
  const savedScoutDecision = savedTask.runtime?.scoutDecision;
  if (savedScoutDecision) {
    const syntheticScoutDirective: ManagedTaskScoutDirective = {
      summary: savedScoutDecision.summary,
      scope: savedScoutDecision.scope ?? [],
      requiredEvidence: savedScoutDecision.requiredEvidence ?? [],
      reviewFilesOrAreas: savedScoutDecision.reviewFilesOrAreas,
      evidenceAcquisitionMode: savedScoutDecision.evidenceAcquisitionMode,
      confirmedHarness: savedScoutDecision.recommendedHarness,
      harnessRationale: savedScoutDecision.harnessRationale,
      blockingEvidence: savedScoutDecision.blockingEvidence,
      directCompletionReady: savedScoutDecision.directCompletionReady,
      skillMap: savedScoutDecision.skillSummary
        ? {
            skillSummary: savedScoutDecision.skillSummary,
            executionObligations: savedScoutDecision.executionObligations ?? [],
            verificationObligations: savedScoutDecision.verificationObligations ?? [],
            ambiguities: savedScoutDecision.ambiguities ?? [],
            projectionConfidence: savedScoutDecision.projectionConfidence,
          }
        : undefined,
    };
    plan = applyScoutDecisionToPlan(plan, syntheticScoutDirective);
  }

  const finalRoutingDecision: KodaXTaskRoutingDecision = savedTask.runtime?.finalRoutingDecision
    ?? plan.decision;
  const skillMap = savedTask.runtime?.skillMap;
  const budgetController = createManagedBudgetController(managedOptions, plan, agentMode);
  const sessionStorage = new ManagedWorkerSessionStorage();
  const qualityAssuranceMode = resolveManagedTaskQualityAssuranceMode(managedOptions, plan);

  // Emit resume status to REPL.
  managedOptions.events?.onManagedTaskStatus?.({
    agentMode,
    harnessProfile: savedTask.contract.harnessProfile,
    phase: 'round',
    note: `Resuming task from checkpoint (round ${checkpoint.currentRound})`,
    upgradeCeiling: savedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
    ...buildManagedStatusBudgetFields(budgetController),
  });

  // Resume the managed task, reusing the saved state.
  let managedTask = savedTask;
  let roundDirective: ManagedTaskVerdictDirective | undefined;
  let roundExecution: ManagedTaskRoundExecution | undefined;
  let maxRounds = resolveManagedTaskMaxRounds(managedOptions, plan, agentMode);
  const startRound = checkpoint.currentRound;

  // FEATURE_071: Checkpoint state for the resumed run.
  const checkpointGitCommit = checkpoint.gitCommit;
  let checkpointCompletedWorkerIds: string[] = [];
  let isFirstResumedRound = true;

  for (let round = startRound; round <= maxRounds; round += 1) {
    const roundPrompt = [
      buildManagedRoundPrompt(managedOriginalTask, round, roundDirective),
    ].filter(Boolean).join('\n\n');
    const roundDecision: KodaXTaskRoutingDecision = {
      ...finalRoutingDecision,
      harnessProfile: managedTask.contract.harnessProfile,
      upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
    };
    const workerSet = buildManagedTaskWorkers(
      roundPrompt,
      roundDecision,
      managedOptions.context?.taskMetadata,
      managedOptions.context?.taskVerification,
      qualityAssuranceMode,
      withManagedSkillArtifactPromptPaths({
        originalTask: managedOriginalTask,
        skillInvocation: managedOptions.context?.skillInvocation,
        skillMap: managedTask.runtime?.skillMap,
        previousRoleSummaries: managedTask.runtime?.roleRoundSummaries,
      }, workspaceDir),
      managedOptions.context?.repoIntelligenceMode,
      round === startRound ? 'initial' : 'refinement',
    );

    // FEATURE_071: On the first resumed round, filter out workers that already completed.
    let effectiveWorkerSet = workerSet;
    if (isFirstResumedRound && checkpoint.completedWorkerIds.length > 0) {
      const remainingWorkers = workerSet.workers.filter(
        (w) => !checkpoint.completedWorkerIds.includes(w.id),
      );
      // If terminal worker was filtered, pick the last remaining worker as terminal.
      const effectiveTerminal = checkpoint.completedWorkerIds.includes(workerSet.terminalWorkerId)
        ? (remainingWorkers.at(-1)?.id ?? workerSet.terminalWorkerId)
        : workerSet.terminalWorkerId;
      effectiveWorkerSet = { terminalWorkerId: effectiveTerminal, workers: remainingWorkers };
    }
    isFirstResumedRound = false;

    if (effectiveWorkerSet.workers.length === 0) {
      // All workers were completed — move to next round.
      continue;
    }

    const roundWorkspaceDir = path.join(workspaceDir, 'rounds', `round-${String(round).padStart(2, '0')}`);
    if (round > startRound) {
      managedOptions.events?.onTextDelta?.(`\n[Managed Task] starting refinement round ${round}\n`);
    }
    managedOptions.events?.onManagedTaskStatus?.({
      agentMode,
      harnessProfile: managedTask.contract.harnessProfile,
      currentRound: round,
      maxRounds,
      phase: 'round',
      note: round === startRound
        ? `Resuming round ${round} — skipped ${checkpoint.completedWorkerIds.length} completed worker(s)`
        : `Starting refinement round ${round}`,
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
    await writeManagedTaskSnapshotArtifacts(workspaceDir, managedTask);
    roundExecution = await executeManagedTaskRound(
      managedOptions,
      managedTask,
      effectiveWorkerSet,
      roundWorkspaceDir,
      `${managedTask.contract.taskId}-round-${round}`,
      plan.promptOverlay,
      qualityAssuranceMode,
      budgetController,
      agentMode,
      round,
      maxRounds,
      plan,
      sessionStorage,
      roundDirective,
      undefined, // No scoutSessionId on resume — session storage is fresh.
      // FEATURE_071: Checkpoint callback for resumed round.
      async (workerId: string) => {
        checkpointCompletedWorkerIds = [...checkpointCompletedWorkerIds, workerId];
        try {
          await writeCheckpoint(workspaceDir, {
            version: 1,
            taskId: managedTask.contract.taskId,
            createdAt: new Date().toISOString(),
            gitCommit: checkpointGitCommit,
            objective: truncateText(managedOriginalTask, 200),
            harnessProfile: managedTask.contract.harnessProfile,
            currentRound: round,
            completedWorkerIds: checkpointCompletedWorkerIds,
            scoutCompleted: true,
          });
        } catch {
          // Checkpoint write failure is non-fatal — task execution continues.
        }
      },
    );
    checkpointCompletedWorkerIds = [];
    managedTask = applyOrchestrationResultToTask(
      roundExecution.taskSnapshot,
      effectiveWorkerSet.terminalWorkerId,
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
            effectiveWorkerSet.workers
              .filter((worker) => worker.memoryStrategy)
              .map((worker) => [worker.id, worker.memoryStrategy as KodaXMemoryStrategy]),
          ),
        },
        memoryNotes: sessionStorage.snapshotMemoryNotes(),
      },
    };
    await writeManagedTaskSnapshotArtifacts(workspaceDir, managedTask);

    roundDirective = roundExecution.directive;
    if (roundDirective?.status === 'accept' || roundDirective?.status === 'blocked') {
      break;
    }
    if (roundDirective?.status === 'revise' && round < maxRounds) {
      managedOptions.events?.onTextDelta?.(
        `\n[Managed Task] evaluator requested another pass: ${roundDirective.reason ?? 'additional evidence required.'}\n`,
      );
      continue;
    }
    break;
  }

  // Finalize — same as normal path.
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
    roundExecution?.workerSet.terminalWorkerId ?? managedTask.verdict.decidedByAssignmentId,
  );

  await writeManagedTaskArtifacts(workspaceDir, managedTask, {
    success: result.success,
    lastText: result.lastText,
    sessionId: result.sessionId,
    signal: result.signal,
    signalReason: result.signalReason,
  }, roundDirective);

  // FEATURE_071: Delete checkpoint on successful completion.
  await deleteCheckpoint(workspaceDir);

  managedOptions.events?.onManagedTaskStatus?.({
    agentMode,
    harnessProfile: managedTask.contract.harnessProfile,
    currentRound: Math.min(maxRounds, buildManagedTaskRoundHistory(managedTask).at(-1)?.round ?? maxRounds),
    maxRounds,
    phase: 'completed',
    note: managedTask.verdict.summary,
    persistToHistory: true,
    events: [{
      key: 'managed-task-completed',
      kind: 'completed',
      summary: managedTask.verdict.disposition === 'complete'
        ? 'Task completed'
        : managedTask.verdict.disposition === 'needs_continuation'
          ? 'Task needs continuation'
          : `Task ended: ${managedTask.verdict.disposition ?? 'unknown'}`,
      detail: managedTask.verdict.summary,
      persistToHistory: true,
    }],
    upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
    ...buildManagedStatusBudgetFields(budgetController),
  });

  return mergeManagedTaskIntoResult(
    {
      ...result,
      routingDecision: result.routingDecision ?? finalRoutingDecision,
    },
    managedTask,
  );
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

  // FEATURE_071: Check for recoverable checkpoint before starting.
  if (options.events?.askUser) {
    const validCheckpoint = await findValidCheckpoint(options);
    if (validCheckpoint) {
      const useChinese = /[\u4e00-\u9fff]/.test(prompt);
      const { checkpoint } = validCheckpoint;
      const completedLabel = checkpoint.completedWorkerIds.length > 0
        ? checkpoint.completedWorkerIds.join(', ')
        : 'Scout';
      const answer = await options.events.askUser({
        question: useChinese
          ? `发现未完成的任务 (${formatHarnessProfileShort(checkpoint.harnessProfile)}, ${completedLabel} 已完成)`
          : `Found incomplete task (${formatHarnessProfileShort(checkpoint.harnessProfile)}, ${completedLabel} completed)`,
        options: [
          {
            label: useChinese ? '继续上次任务' : 'Continue',
            value: 'continue',
            description: useChinese ? '从中断处恢复执行' : 'Resume from where it stopped',
          },
          {
            label: useChinese ? '重新开始' : 'Restart',
            value: 'restart',
            description: useChinese ? '丢弃之前的进度，重新开始' : 'Discard previous progress and start fresh',
          },
        ],
        default: 'continue',
        intent: 'generic',
        scope: 'session',
        resumeBehavior: 'continue',
      });
      if (answer === 'continue') {
        return resumeManagedTask(options, prompt, validCheckpoint);
      }
      await deleteCheckpoint(validCheckpoint.workspaceDir);
    }
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

  const scoutInitialHarnessProfile = finalRoutingDecision.harnessProfile;
  managedOptions.events?.onManagedTaskStatus?.({
    agentMode,
    harnessProfile: finalRoutingDecision.harnessProfile,
    phase: 'routing',
    note: liveRoutingNote,
    upgradeCeiling: finalRoutingDecision.upgradeCeiling,
    ...buildManagedStatusBudgetFields(initialBudgetController),
  });

  // FEATURE_061 Phase 1: All AMA tasks go through Scout — no bypass.
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
  // FEATURE_061 Phase 3: Create session storage before Scout so its session can be continued by H1/H2 workers.
  const sharedSessionStorage = new ManagedWorkerSessionStorage();
  const scoutExecution = await runManagedScoutStage(managedOptions, prompt, plan, scoutBudgetController, sharedSessionStorage);
  plan = applyScoutDecisionToPlan(plan, scoutExecution.directive);
  const skillMap = buildSkillMap(managedOptions.context?.skillInvocation, scoutExecution.directive);
  const postScoutGuardrails = applyManagedHarnessGuardrailsToPlan(plan, managedPlanning.reviewTarget);
  plan = postScoutGuardrails.plan;
  if (postScoutGuardrails.routingOverrideReason) {
    routingOverrideReason = routingOverrideReason
      ? `${routingOverrideReason}; ${postScoutGuardrails.routingOverrideReason}`
      : postScoutGuardrails.routingOverrideReason;
  }
  finalRoutingDecision = cloneRoutingDecisionWithReviewTarget(
    plan.decision,
    managedPlanning.reviewTarget,
  );
  // H0 text-only completion: Scout completed the task directly (e.g., greeting, lookup, review, simple edit).
  if (
    finalRoutingDecision.harnessProfile === 'H0_DIRECT'
    && scoutExecution.directive.confirmedHarness === 'H0_DIRECT'
    && scoutExecution.result.success !== false
    && normalizeManagedDirectCompletionReady(scoutExecution.directive.directCompletionReady ?? 'no') === 'yes'
  ) {
    return completeScoutH0Task({
      options: managedOptions, originalTask: managedOriginalTask, plan,
      scoutExecution, scoutBudgetController,
      rawRoutingDecision, finalRoutingDecision, routingOverrideReason,
      skillMap, agentMode,
    });
  }

  // H0 continuation path: Scout confirmed H0 but directCompletionReady=no.
  // Re-run Scout with completion-focused prompt, continuing the same session.
  if (
    scoutExecution.directive.confirmedHarness === 'H0_DIRECT'
    && scoutExecution.result.success !== false
    && normalizeManagedDirectCompletionReady(scoutExecution.directive.directCompletionReady ?? 'no') !== 'yes'
  ) {
    // Grant full tool access for H0 continuation.
    // Wrap events through createWorkerEvents so text/tool output renders correctly
    // in the managed foreground transcript (with [Scout] prefix and tool group sync).
    const h0ContinuationWorker: ManagedTaskWorkerSpec = {
      id: 'scout',
      title: 'Scout',
      role: 'scout',
      terminalAuthority: true,
      execution: 'serial',
      agent: buildManagedWorkerAgent('scout', 'scout'),
      prompt: '',
      // No toolPolicy → full tool access for H0 continuation
    };
    const h0ContinuationEvents = createWorkerEvents(
      managedOptions.events, h0ContinuationWorker, true, scoutBudgetController, {
        emitContent: true,
        emitToolEvents: true,
        emitProgressEventsWhenHidden: false,
        emitIterationEvents: true,
        statusContext: {
          agentMode: managedOptions.agentMode ?? 'ama',
          harnessProfile: 'H0_DIRECT',
          currentRound: 1,
          maxRounds: 1,
          upgradeCeiling: finalRoutingDecision.upgradeCeiling,
        },
      },
    );
    const h0ContinuationOptions: KodaXOptions = {
      ...managedOptions,
      maxIter: resolveRemainingManagedWorkBudget(scoutBudgetController),
      session: scoutExecution.scoutSessionId && sharedSessionStorage
        ? {
            ...managedOptions.session,
            id: scoutExecution.scoutSessionId,
            scope: 'managed-task-worker',
            resume: true,
            autoResume: false,
            storage: sharedSessionStorage,
          }
        : managedOptions.session,
      events: h0ContinuationEvents
        ? { ...managedOptions.events, ...h0ContinuationEvents }
        : managedOptions.events,
      context: {
        ...managedOptions.context,
        // Disable managed protocol — continuation should just do the work, not emit Scout blocks.
        managedProtocolEmission: undefined,
        // No prompt overlay — avoid "Scout Phase" instructions confusing the continuation.
        promptOverlay: undefined,
      },
    };
    managedOptions.events?.onManagedTaskStatus?.({
      agentMode,
      harnessProfile: 'H0_DIRECT',
      activeWorkerId: 'scout',
      activeWorkerTitle: 'Scout',
      phase: 'worker',
      note: 'Scout confirmed H0 — continuing with write tools',
      upgradeCeiling: finalRoutingDecision.upgradeCeiling,
      ...buildManagedStatusBudgetFields(scoutBudgetController),
    });
    const continuationPrompt = [
      'You previously investigated the following task and confirmed it is simple enough to complete directly.',
      '',
      `Original task: ${prompt}`,
      '',
      scoutExecution.directive.summary
        ? `Your investigation summary: ${scoutExecution.directive.summary}`
        : undefined,
      'Write tools (edit, write, bash) are now available. Complete the task now.',
      'Do not re-investigate or re-read files you already read. Use your prior findings directly.',
    ].filter(Boolean).join('\n');
    const continuationResult = await runDirectKodaX(h0ContinuationOptions, continuationPrompt);
    // Merge Scout investigation + continuation into a single result
    const mergedExecution = {
      ...scoutExecution,
      result: continuationResult,
    };
    return completeScoutH0Task({
      options: managedOptions, originalTask: managedOriginalTask, plan,
      scoutExecution: mergedExecution, scoutBudgetController,
      rawRoutingDecision, finalRoutingDecision, routingOverrideReason,
      skillMap, agentMode,
    });
  }

  // Hard invariant (defensive): H0+directCompletionReady=no should be handled by the paths above.
  // This guard is intentionally unreachable — it catches regressions if future changes break the branching.
  if (
    scoutExecution.directive.confirmedHarness === 'H0_DIRECT'
    && normalizeManagedDirectCompletionReady(scoutExecution.directive.directCompletionReady ?? 'no') !== 'yes'
    && scoutExecution.result.success !== false
  ) {
    // H0 + directCompletionReady=no should have been caught by H0 continuation above.
    // Reaching here means the state machine has a gap. Treat as blocked rather than false-complete.
    managedOptions.events?.onManagedTaskStatus?.({
      agentMode,
      harnessProfile: 'H0_DIRECT',
      phase: 'completed',
      note: 'H0 task with directCompletionReady=no reached H1/H2 pipeline — state machine gap detected.',
    });
    return {
      ...scoutExecution.result,
      success: false,
      signal: 'BLOCKED',
      signalReason: 'H0 task with directCompletionReady=no was not handled by the H0 continuation path.',
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
  // FEATURE_061 Phase 3: Reuse shared session storage that already has Scout's session.
  const sessionStorage = sharedSessionStorage;
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
        // recommendedHarness reflects the Scout's own recommendation before guardrails;
        // it may differ from finalRoutingDecision.harnessProfile if guardrails override it.
        recommendedHarness: scoutExecution.directive.confirmedHarness ?? finalRoutingDecision.harnessProfile,
        readyForUpgrade: (scoutExecution.directive.confirmedHarness ?? finalRoutingDecision.harnessProfile) !== 'H0_DIRECT',
        scope: scoutExecution.directive.scope,
        requiredEvidence: scoutExecution.directive.requiredEvidence,
        reviewFilesOrAreas: scoutExecution.directive.reviewFilesOrAreas,
        evidenceAcquisitionMode: scoutExecution.directive.evidenceAcquisitionMode,
        harnessRationale: scoutExecution.directive.harnessRationale,
        blockingEvidence: scoutExecution.directive.blockingEvidence,
        directCompletionReady: scoutExecution.directive.directCompletionReady,
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

  // FEATURE_071: Write initial checkpoint after Scout completes, before round loop.
  const checkpointGitCommit = await getGitHeadCommit(managedOptions.context?.gitRoot);
  let checkpointCompletedWorkerIds: string[] = [];
  if (checkpointGitCommit) {
    await writeCheckpoint(shape.workspaceDir, {
      version: 1,
      taskId: managedTask.contract.taskId,
      createdAt: new Date().toISOString(),
      gitCommit: checkpointGitCommit,
      objective: truncateText(managedOriginalTask, 200),
      harnessProfile: managedTask.contract.harnessProfile,
      currentRound: 1,
      completedWorkerIds: [],
      scoutCompleted: true,
    });
  }

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
      scoutExecution.scoutSessionId,
      // FEATURE_071: Checkpoint callback — update checkpoint after each worker completes.
      checkpointGitCommit
        ? async (workerId: string) => {
            checkpointCompletedWorkerIds = [...checkpointCompletedWorkerIds, workerId];
            try {
              await writeCheckpoint(shape.workspaceDir, {
                version: 1,
                taskId: managedTask.contract.taskId,
                createdAt: new Date().toISOString(),
                gitCommit: checkpointGitCommit,
                objective: truncateText(managedOriginalTask, 200),
                harnessProfile: managedTask.contract.harnessProfile,
                currentRound: round,
                completedWorkerIds: checkpointCompletedWorkerIds,
                scoutCompleted: true,
              });
            } catch {
              // Checkpoint write failure is non-fatal — task execution continues.
            }
          }
        : undefined,
    );
    // FEATURE_071: Reset per-round completed workers for next round.
    checkpointCompletedWorkerIds = [];
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

    // FEATURE_067 v2: Clean up write worktrees after each round (Evaluator has already reviewed diffs).
    if (roundExecution.childWriteWorktreePaths && roundExecution.childWriteWorktreePaths.size > 0) {
      const { cleanupWorktrees } = await import('./child-executor.js');
      await cleanupWorktrees(
        roundExecution.childWriteWorktreePaths,
        {
          backups: new Map(),
          gitRoot: managedOptions.context?.gitRoot ?? undefined,
          executionCwd: managedOptions.context?.gitRoot ?? undefined,
        },
      );
    }

    roundDirective = roundExecution.directive;
    if (roundDirective) {
      let activeDirective = maybeBuildDegradedEvaluatorDirective(
        roundDirective,
        roundExecution.workerResults,
        roundExecution.workerSet,
      ) ?? roundDirective;
      if (
        managedTask.contract.harnessProfile === 'H1_EXECUTE_EVAL'
        && activeDirective.status === 'revise'
      ) {
        if (h1CheckedDirectRevisesUsed === 0) {
          h1CheckedDirectRevisesUsed += 1;
          maxRounds = Math.max(maxRounds, round + 1);
          activeDirective = {
            ...activeDirective,
            nextHarness: undefined,
            followups: [
              ...activeDirective.followups,
              'H1 checked-direct is taking one same-harness revise pass before final acceptance.',
            ],
          };
        } else {
          activeDirective = {
            ...activeDirective,
            status: 'blocked',
            nextHarness: undefined,
            reason: activeDirective.reason ?? 'Checked-direct review remained incomplete after one lightweight revise pass.',
            followups: [
              ...activeDirective.followups,
              'H1 is capped at a single same-harness revise pass. Return the best supported answer with clear limits instead of escalating to H2.',
            ],
            userFacingText: activeDirective.userFacingText || managedTask.verdict.summary,
          };
        }
      }
      roundDirective = await persistManagedTaskDirectiveArtifact(roundWorkspaceDir, activeDirective);
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
          maxRounds = Math.max(maxRounds, round + 1);
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
          originalTask: managedOriginalTask,
        },
      );
      if (budgetDecision === 'approved') {
        if (round >= maxRounds) {
          maxRounds += 1;
        }
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
          persistToHistory: true,
          events: [{
            key: 'managed-task-completed',
            kind: 'completed',
            summary: 'Task ended: blocked',
            detail: denialReason,
            persistToHistory: true,
          }],
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

  // FEATURE_071: Delete checkpoint on task completion — no longer needed.
  await deleteCheckpoint(shape.workspaceDir);

  managedOptions.events?.onManagedTaskStatus?.({
    agentMode,
    harnessProfile: managedTask.contract.harnessProfile,
    currentRound: Math.min(maxRounds, buildManagedTaskRoundHistory(managedTask).at(-1)?.round ?? maxRounds),
    maxRounds,
    phase: 'completed',
    note: managedTask.verdict.summary,
    persistToHistory: true,
    events: [{
      key: 'managed-task-completed',
      kind: 'completed',
      summary: managedTask.verdict.disposition === 'complete'
        ? 'Task completed'
        : managedTask.verdict.disposition === 'needs_continuation'
          ? 'Task needs continuation'
          : `Task ended: ${managedTask.verdict.disposition ?? 'unknown'}`,
      detail: managedTask.verdict.summary,
      persistToHistory: true,
    }],
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
