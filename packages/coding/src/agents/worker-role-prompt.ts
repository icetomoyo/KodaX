import { staticText } from '../prompts/static-text.js';


import type {
  KodaXTaskRoutingDecision,
  KodaXTaskVerificationContract,
} from '../types.js';
import { EXECUTION_GUIDANCE, PLAN_BATCH_GUIDANCE, TOOL_RECOVERY_GUIDANCE } from '../prompts/execution-guidance.js';
import type { KodaXPromptSectionTag } from '../prompts/sections.js';
// F270 keeps the prompt on the canonical Actor wait/completion vocabulary;
// the runner may still use its generic wake loop internally.

export const WORKER_AGENT_NAME = 'kodax-worker';

export const ULTRA_AGENT_POLICY =
  'Use sub-agents when parallel work would materially improve speed or quality.';

export const EXPLICIT_WORKFLOW_POLICY =
  staticText("worker.explicit-workflow-policy");

export interface WorkerActorCapacity {
  readonly maxConcurrentThreads: number;
  readonly activeNonRootTurns: number;
}

export function buildWorkerActorCapacityGuidance(
  actorCapacity: WorkerActorCapacity | undefined,
  availableToolNames?: readonly string[],
): readonly string[] {
  if (actorCapacity === undefined) return [];
  if (availableToolNames !== undefined && !availableToolNames.includes('spawn_agent')) return [];
  // State the free-slot count the spawn decision needs as a fact. Leaving the subtraction
  // to the model failed: without it, models in a partly busy tree started more children
  // than were free (eval d-1: 8 of 9 cells).
  const childLimit = Math.max(0, actorCapacity.maxConcurrentThreads - 1);
  if (childLimit === 0) {
    return ['- Only you run in this session, so `spawn_agent` calls are rejected. Do the work yourself.'];
  }
  const free = Math.max(0, childLimit - actorCapacity.activeNonRootTurns);
  return [
    `- This session runs at most ${childLimit} child Agent${childLimit === 1 ? '' : 's'} at a time.`,
    free === 0
      ? '- No child slot is free right now, so do the work yourself or wait for a running Agent to finish before starting another.'
      : `- Right now ${free} of ${childLimit} child slot${childLimit === 1 ? '' : 's'} ${free === 1 ? 'is' : 'are'} free.`,
    staticText("worker.capacity.rules"),
  ];
}

export function buildWorkerActorCapacityContract(
  actorCapacity: WorkerActorCapacity | undefined,
  availableToolNames?: readonly string[],
): string | undefined {
  const guidance = buildWorkerActorCapacityGuidance(actorCapacity, availableToolNames);
  return guidance.length === 0
    ? undefined
    : ['ACTOR CAPACITY:', ...guidance].join('\n');
}

export function buildWorkerReviewFanoutContract(
  decision: KodaXTaskRoutingDecision,
  availableToolNames?: readonly string[],
): string | undefined {
  const reviewTarget = decision.reviewTarget ?? 'general';
  const isDiffScopedReview = reviewTarget === 'current-worktree'
    || reviewTarget === 'compare-range';
  const isSystemicGeneralReview = reviewTarget === 'general'
    && decision.complexity === 'systemic';
  const hasBroadDiffScale = decision.reviewScale === 'large'
    || decision.reviewScale === 'massive';
  if (
    decision.primaryTask !== 'review'
    || (!isSystemicGeneralReview && !(isDiffScopedReview && hasBroadDiffScale))
  ) {
    return undefined;
  }
  // The gate reads keyword and diff-size signals, so the block states what it saw and leaves the
  // breadth to the requested scope: phrased as an authoritative quota it split one-file reviews.
  const observed = isDiffScopedReview
    ? `- The diff under review is ${decision.reviewScale}.`
    : '- The request reads as a repository-wide review.';
  const generalScope = isDiffScopedReview ? undefined : staticText("worker.review-breadth.scope");
  if (availableToolNames !== undefined && !availableToolNames.includes('spawn_agent')) {
    return [
      'REVIEW BREADTH:',
      observed,
      staticText("worker.review-breadth.local"),
      generalScope,
    ].filter((line): line is string => line !== undefined).join('\n');
  }
  const scopeAcquisition = availableToolNames === undefined || availableToolNames.includes('changed_scope')
    ? 'call `changed_scope` once' : 'establish it with the available tools';

  return [
    'REVIEW BREADTH:',
    observed,
    staticText("worker.review-breadth.fanout"),
    generalScope
      ?? `- When the exact diff scope is unknown, ${scopeAcquisition} and split the review from its file groups before reading every diff yourself, because the reviewers will read those diffs.`,
  ].filter((line): line is string => line !== undefined).join('\n');
}

interface WorkerTools {
  /** Omitted means no capability snapshot; an explicit empty list is authoritative. */
  readonly names: readonly string[] | undefined;
  readonly has: (name: string) => boolean;
  readonly fullTodo: boolean;
  readonly fullCollaboration: boolean;
  /** Mixed blocks drop their guidance part themselves; whole guidance blocks are filtered by tag. */
  readonly omitGuidance: boolean;
}

/** One rendered block of the Worker stable instructions. */
export interface WorkerSection {
  readonly id: string;
  readonly tag: KodaXPromptSectionTag;
  readonly text: string;
}

interface WorkerSectionDefinition {
  readonly id: string;
  readonly tag: KodaXPromptSectionTag;
  /** Returns undefined when the block does not apply to this tool set. */
  readonly render: (tools: WorkerTools) => string | undefined;
}

function workerTools(names: readonly string[] | undefined, omitGuidance: boolean): WorkerTools {
  const has = (name: string): boolean => names === undefined || names.includes(name);
  return {
    names,
    has,
    fullTodo: ['todo_create', 'todo_update', 'todo_list', 'wait_agent'].every(has),
    fullCollaboration: ['spawn_agent', 'wait_agent', 'send_message', 'followup_task', 'list_agents', 'agent_output', 'interrupt_agent'].every(has),
    omitGuidance,
  };
}

function block(heading: string, items: readonly (string | undefined)[]): string {
  return [heading, ...items].filter((line): line is string => line !== undefined).join('\n');
}

// Runtime passes model-visible names: a surviving legacy reader may be needed
// because the list tool is absent or overridden by a different contract.
function todoReader(tools: WorkerTools): 'todo_get' | 'todo_list' | undefined {
  return tools.names?.includes('todo_get') ? 'todo_get'
    : tools.has('todo_list') ? 'todo_list' : undefined;
}

function renderPlanFirst(tools: WorkerTools): string {
  if (!tools.fullTodo) return renderLimitedPlan(tools);
  return block('PLAN-FIRST GUIDANCE:', [
    // Evidence/verification duties read as "inspect the machine first": weak models ran `dir`/`uname`
    // before answering how-to questions, and tied answers about other systems to the local host.
    `- ${staticText("worker.answer-directly")}`,
    staticText("worker.plan-first.rules"),
    `- ${PLAN_BATCH_GUIDANCE}`,
    staticText("worker.plan-first.replan"),
  ]);
}

function renderPlanListHygiene(tools: WorkerTools): string | undefined {
  if (!tools.fullTodo) return undefined;
  const todoReadCall = todoReader(tools) === 'todo_list' ? 'todo_list({id})' : 'todo_get(id)';
  // v0.7.42 — plan-list hygiene: staleness refresh + dedup. The two
  // checks below are explicit because production sessions show two
  // recurring failure modes when this discipline is implicit:
  //   - STALENESS: model emits `todo_update({id, status:"completed"})`
  //     after a long quiet stretch, but the runner-side accept verdict
  //     already flipped that item to completed several turns ago. The
  //     patch is a no-op but the model thinks it advanced state.
  //   - DEDUP: model emits `todo_create({subject:"Audit foo"})` even
  //     though `todo_2: Audit foo` already exists from the initial
  //     plan. Two parallel rows of the same work confuse the user's
  //     dashboard.
  // Mirrors claudecode V2's `TaskUpdate` / `TaskCreate` prompts which
  // teach the same "read latest before mutate" / "scan before insert"
  // discipline (see `c:/Works/claudecode/src/tools/TaskUpdateTool/`
  // and `TaskCreateTool/`).
  return block('PLAN-LIST HYGIENE (staleness + dedup):', [
    `- BEFORE \`todo_update\`, call \`${todoReadCall}\` only when another Actor/runtime event may actually have changed that item since you last saw it (for example after a wait/resume boundary). Ordinary consecutive model turns do not require a resynchronization ritual.`,
    staticText("worker.plan-hygiene"),
  ]);
}

function renderScopeCommitment(tools: WorkerTools): string {
  return block('SCOPE COMMITMENT:', [
    staticText("worker.scope.contract"),
    tools.has('todo_update')
      ? staticText("worker.scope.disproved-premise-todo")
      : staticText("worker.scope.disproved-premise"),
    staticText("worker.scope.reuse-and-review"),
  ]);
}

function renderMutationDiscipline(tools: WorkerTools): string {
  const batchEditTool = tools.has('edit') ? 'edit' : 'multi_edit';
  return block('MUTATION DISCIPLINE:', [
    staticText("worker.mutation.read-and-edit"),
    `- For multiple edits to one file, batch with \`${batchEditTool}\` instead of separate calls — atomic, cheaper, structure-preserving.`,
    staticText("worker.mutation.write-and-scratch"),
  ]);
}

function renderCollaboration(tools: WorkerTools): string {
  if (!tools.fullCollaboration) return renderLimitedCollaboration(tools);
  return block('AGENT COLLABORATION:', [
    staticText("worker.collaboration.rules"),
    // FEATURE_169 v0.7.40 — dispatch objective quality (F0a + F0b). Suite 0
    // v2 audit VALID (bash disagreement 8.9%, pull-correct 3.3%): C bash=0%
    // (vs A=9% baseline-low ceiling-flatten), pull-correct mention 41→76%
    // (+35pp lift), 5/6 alias C ≥ 70%.
    staticText("worker.collaboration.objective-quality"),
    tools.has('run_workflow')
      ? staticText("worker.collaboration.objective-language-workflow")
      : staticText("worker.collaboration.objective-language"),
    staticText("worker.collaboration.pull-tools"),
    tools.has('list_dispatchable_agents')
      ? staticText("worker.collaboration.specialist-routing") : undefined,
  ]);
}

function renderRepoIntelligenceTools(tools: WorkerTools): string {
  const hasTool = tools.has;
  const diffTool = hasTool('changed_diff') ? 'changed_diff'
    : hasTool('changed_diff_bundle') ? 'changed_diff_bundle' : undefined;
  // Keep first-choice guidance visible even when rich tool descriptions are deferred.
  // Capability snapshots come from the executable tool set, never task keywords.
  const lspTools = ['lsp_workspace_symbols', 'lsp_implementation', 'lsp_incoming_calls', 'lsp_outgoing_calls']
    .filter(hasTool);
  // Capsule and pull-tool fallback lines only make sense when a pull-tool is on the menu.
  const hasRepoPullTool = ['relationship_scan', 'module_context', 'symbol_context', 'impact_estimate',
    'process_context', 'repo_overview', 'changed_scope'].some(hasTool);
  return block('REPO INTELLIGENCE TOOLS:', [
    // Stated where the procedures live: weak models followed the changed_scope / `bash git`
    // steps below instead of a matching review or Git Skill named only in the catalog.
    hasTool('skill')
      ? '- When a listed Skill matches the request, load it with `skill` before any tool below, because the Skill decides how these tools are used.' : undefined,
    hasTool('relationship_scan')
      ? staticText("worker.repo-tools.relationship-scan") : undefined,
    hasTool('module_context')
      ? staticText("worker.repo-tools.module-context") : undefined,
    hasTool('symbol_context')
      ? '- Use `symbol_context` before grepping for one symbol and its probable callers/callees.' : undefined,
    hasTool('impact_estimate')
      ? '- Before planning a rename/refactor, use `impact_estimate` to estimate the blast radius.' : undefined,
    hasTool('process_context')
      ? '- Use `process_context` to trace execution from an entry point.' : undefined,
    hasTool('repo_overview')
      ? staticText("worker.repo-tools.repo-overview") : undefined,
    hasTool('changed_scope')
      ? staticText("worker.repo-tools.changed-scope") : undefined,
    hasTool('spawn_agent')
      ? `- For change-set review, establish the requested scope, then fan out before ${diffTool ? '\`' + diffTool + '\` or ' : ''}reading every diff locally. The root reads its own lane and integrates the others.`
      : staticText("worker.repo-tools.local-review"),
    diffTool ? `- Use \`${diffTool}\` for paged diffs of explicit changed files.` : undefined,
    staticText("worker.repo-tools.audit-scope"),
    lspTools.length > 0
      ? `- For exact file positions or compiler-backed symbol/call hierarchy edges, use the available LSP tools: ${lspTools.map((name) => '\`' + name + '\`').join(', ')}.` : undefined,
    hasTool('grep') && hasTool('glob')
      ? '- Prefer grep/glob for local content/path lookup.' : undefined,
    hasTool('semantic_lookup')
      ? '- Use `semantic_lookup` for concepts rather than exact strings.' : undefined,
    hasRepoPullTool ? staticText("worker.repo-tools.pull-fallback") : undefined,
    hasTool('changed_diff_bundle') || hasTool('changed_diff')
      ? staticText("worker.repo-tools.structured-diff") : undefined,
  ]);
}

function renderLimitedPlan(tools: WorkerTools): string {
  const hasTool = tools.has;
  const reader = todoReader(tools);
  return block('PLAN-FIRST GUIDANCE (available capability):', [
    staticText("worker.limited-plan.rules"),
    hasTool('todo_create')
      ? staticText("worker.limited-plan.todo-create") : undefined,
    hasTool('todo_update')
      ? staticText("worker.limited-plan.todo-update") : undefined,
    reader && hasTool('todo_update')
      ? `- Use \`${reader}\` with id before changing an item only when another Actor or runtime event may have changed it since last seen; ordinary consecutive turns need no refresh ritual.` : undefined,
    hasTool('todo_list')
      ? staticText("worker.limited-plan.todo-list") : undefined,
    reader && !hasTool('todo_update')
      ? `- Use \`${reader}\` with id when the state of an existing milestone is uncertain.` : undefined,
    staticText("worker.limited-plan.language"),
  ]);
}

function renderLimitedCollaboration(tools: WorkerTools): string {
  const hasTool = tools.has;
  return block('AGENT COLLABORATION (available capability):', [
    hasTool('spawn_agent')
      ? staticText("worker.limited-collaboration.spawn") : undefined,
    hasTool('spawn_agent') && hasTool('list_dispatchable_agents')
      ? '- Use a matching registered specialist\'s canonical agent_id from `list_dispatchable_agents`.' : undefined,
    hasTool('wait_agent')
      ? staticText("worker.limited-collaboration.wait") : undefined,
    hasTool('send_message')
      ? staticText("worker.limited-collaboration.send-message") : undefined,
    hasTool('followup_task')
      ? '- Use `followup_task` to start another turn on an idle actor or update a running actor\'s objective.' : undefined,
    hasTool('list_agents') ? '- Use `list_agents` for current tree and capacity state.' : undefined,
    hasTool('agent_output')
      ? staticText("worker.limited-collaboration.agent-output") : undefined,
    hasTool('interrupt_agent')
      ? staticText("worker.limited-collaboration.interrupt") : undefined,
    staticText("worker.limited-collaboration.integrate"),
  ]);
}

function renderTermination(tools: WorkerTools): string {
  return block('TERMINATION:', [
    staticText("worker.limited-termination.verify"),
    tools.has('todo_update')
      ? staticText("worker.limited-termination.todo-check") : undefined,
    staticText("worker.limited-termination.summary"),
  ]);
}

// The full tool set gets the dense contract: the tool descriptions already teach
// each Todo and Agent tool, so these blocks keep only decisions and lifecycle.
function renderTrustAndScope(tools: WorkerTools): string {
  const workflowPrompts = tools.has('run_workflow') ? ' (including run_workflow prompts)' : '';
  return block('TRUST AND SCOPE', [
    `${staticText("worker.full.trust-and-scope")}${workflowPrompts}. ${staticText("worker.full.source-language")}`,
  ]);
}

function renderTaskAndPlan(tools: WorkerTools): string {
  const reader = todoReader(tools) === 'todo_get' ? 'todo_get(id)' : 'todo_list({id})';
  return block('TASK AND PLAN', [
    staticText("worker.answer-directly"),
    `${staticText("worker.full.plan.milestones")} ${PLAN_BATCH_GUIDANCE}`,
    `${staticText("worker.full.plan.dedup")} ${reader} ${staticText("worker.full.plan.replanning")}`,
  ]);
}

// Dispatch is KodaX working style; the Agent lifecycle rules stay with an application persona.
function renderParallelWork(tools: WorkerTools): string {
  return tools.omitGuidance
    ? block('AGENT COLLABORATION', [staticText("worker.full.collaboration")])
    : block('PARALLEL WORK', [staticText("worker.full.dispatch"), staticText("worker.full.collaboration")]);
}

function renderExecutionAndDelivery(tools: WorkerTools): string {
  return tools.omitGuidance
    ? block('RECOVERY AND DELIVERY', [TOOL_RECOVERY_GUIDANCE, staticText("worker.full.delivery")])
    : block('EXECUTION, RECOVERY AND DELIVERY', [
      renderMutationDiscipline(tools),
      staticText("worker.full.verification"),
      TOOL_RECOVERY_GUIDANCE,
      staticText("worker.full.delivery"),
    ]);
}

const FULL_WORKER_SECTIONS: readonly WorkerSectionDefinition[] = [
  { id: 'trust-and-scope', tag: 'contract', render: renderTrustAndScope },
  { id: 'task-and-plan', tag: 'guidance', render: renderTaskAndPlan },
  { id: 'parallel-work', tag: 'capability', render: renderParallelWork },
  { id: 'specialist-routing', tag: 'capability', render: tools => tools.has('list_dispatchable_agents')
    ? 'When a registered specialist matches the task domain, use its canonical agent_id from list_dispatchable_agents.' : undefined },
  { id: 'repo-intelligence-tools', tag: 'capability', render: renderRepoIntelligenceTools },
  { id: 'execution-and-delivery', tag: 'contract', render: renderExecutionAndDelivery },
];

// Order is the rendered order. Tags say what each block is for; see KodaXPromptSectionTag.
// Plan, scope and mutation blocks are guidance: the tool descriptions still teach each tool.
// A limited tool set gets these blocks, worded for the tools it actually has.
const WORKER_SECTIONS: readonly WorkerSectionDefinition[] = [
  { id: 'context-trust', tag: 'contract', render: () => block('MANAGED RUN CONTEXT TRUST:', [staticText("worker.context-trust")]) },
  { id: 'parallel-work', tag: 'guidance', render: tools => tools.has('spawn_agent') ? staticText("worker.parallel-first") : staticText("worker.local-execution") },
  { id: 'plan-first', tag: 'guidance', render: renderPlanFirst },
  { id: 'plan-list-hygiene', tag: 'guidance', render: renderPlanListHygiene },
  { id: 'scope-commitment', tag: 'guidance', render: renderScopeCommitment },
  { id: 'mutation-discipline', tag: 'guidance', render: renderMutationDiscipline },
  { id: 'repo-intelligence-tools', tag: 'capability', render: renderRepoIntelligenceTools },
  { id: 'agent-collaboration', tag: 'capability', render: renderCollaboration },
  { id: 'agent-steering', tag: 'capability', render: tools => tools.fullCollaboration ? staticText("worker.agent-steering") : undefined },
  // Static EXECUTION GUIDANCE (shared with agentProfile leaf runs) replaces the
  // router-injected EXECUTION_MODE / HARNESS_PROFILE overlays — the Worker
  // self-judges the kind of work instead of being told by a keyword router.
  // See `prompts/execution-guidance.ts` + ADR-043.
  { id: 'execution-guidance', tag: 'guidance', render: () => EXECUTION_GUIDANCE },
  { id: 'termination', tag: 'contract', render: renderTermination },
];

/** The Worker stable blocks that apply to this tool set, in rendered order. */
export function buildWorkerStableSections(
  availableToolNames?: readonly string[],
  omitGuidance = false,
): readonly WorkerSection[] {
  const tools = workerTools(availableToolNames, omitGuidance);
  const sections = tools.fullTodo && tools.fullCollaboration ? FULL_WORKER_SECTIONS : WORKER_SECTIONS;
  return sections.flatMap(({ id, tag, render }) => {
    const text = render(tools);
    return text ? [{ id, tag, text }] : [];
  });
}

/**
 * Pure builder. Returns the system prompt the role-prompt entry point
 * splices in for the V2 Worker (the only active AMA role after
 * FEATURE_193). Intentionally context-light — the runner-driven path
 * layers workspace / capability / overlay sections around this on top.
 */
export function buildWorkerStableInstructions(availableToolNames?: readonly string[], omitGuidance = false): string {
  return buildWorkerStableSections(availableToolNames, omitGuidance)
    .filter(section => !omitGuidance || section.tag !== 'guidance')
    .map(section => section.text).join('\n\n');
}

/**
 * Renders only classified routing facts. Unclassified placeholders carry no signal, and the
 * bare `requiresBrainstorm` flag (true for every low-confidence "unknown" request) lost its
 * explanation when the router overlay retired: next to the Skill catalog, models read
 * "Brainstorm required: yes" as a Skill to invoke. The flag still drives routing internally.
 * `neutralIdentity` drops the KodaX self-description so an application persona stands alone.
 */
export function buildWorkerRoutingContext(
  decision: KodaXTaskRoutingDecision,
  neutralIdentity = false,
): string {
  return [
    neutralIdentity
      ? 'Routing decision summary for this task:'
      : `You are the Worker — KodaX's single primary agent for this task. Routing decision summary:`,
    // Heuristic labels (reasoning.ts, review-routing.ts): stated as fact, a wrong guess ("refactor", "Risk: high"
    // for a process question) steered ordinary requests. Kept as hints because review focus benefits from them.
    '- These labels are a heuristic guess from the request wording and the worktree state. When one disagrees with what the user asked, follow the request.',
    decision.primaryTask !== 'unknown' ? `- Primary task: ${decision.primaryTask}` : undefined,
    `- Assurance intent: ${decision.assuranceIntent ?? 'default'}`,
    `- Work intent: ${decision.workIntent}`,
    `- Risk: ${decision.riskLevel}`,
    `- Complexity: ${decision.complexity}`,
    // Review scale measures the dirty worktree; for a general review that is not what the user asked about.
    decision.reviewScale && decision.reviewTarget !== 'general' ? `- Review scale: ${decision.reviewScale}` : undefined,
    decision.reviewTarget ? `- Review target: ${decision.reviewTarget}` : undefined,
    `- Independent QA needed: ${decision.needsIndependentQA ? 'yes' : 'no'}`,
  ].filter((line): line is string => line !== undefined).join('\n');
}

export function buildWorkerInstructions(
  decision: KodaXTaskRoutingDecision,
  verification: KodaXTaskVerificationContract | undefined,
  isResumeAfterReviseFailure: boolean,
  actorCapacity?: WorkerActorCapacity,
  availableToolNames?: readonly string[],
): string {
  void verification; // kept on the signature for parity with legacy roles
  void isResumeAfterReviseFailure;

  const actorCapacityContract = buildWorkerActorCapacityContract(actorCapacity, availableToolNames);
  const reviewFanoutContract = buildWorkerReviewFanoutContract(decision, availableToolNames);

  return [
    buildWorkerRoutingContext(decision),
    actorCapacityContract,
    reviewFanoutContract,
    buildWorkerStableInstructions(availableToolNames),
  ]
    .filter((part): part is string => Boolean(part?.length))
    .join('\n\n');
}

// FEATURE_193 v0.7.43: `isHarnessV2Enabled()` deleted — V1 chain retired.
// `KODAX_HARNESS_V2=false` env override no longer routes through V1; the
// env var is silently ignored (won't break user shell configs).
