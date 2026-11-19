import { staticText } from '../prompts/static-text.js';


import type {
  KodaXTaskRoutingDecision,
  KodaXTaskVerificationContract,
} from '../types.js';
import { EXECUTION_GUIDANCE, PLAN_BATCH_GUIDANCE } from '../prompts/execution-guidance.js';
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

/**
 * Pure builder. Returns the system prompt the role-prompt entry point
 * splices in for the V2 Worker (the only active AMA role after
 * FEATURE_193). Intentionally context-light — the runner-driven path
 * layers workspace / capability / overlay sections around this on top.
 */
export function buildWorkerStableInstructions(availableToolNames?: readonly string[]): string {
  // Omitted means no capability snapshot; an explicit empty list is authoritative.
  const hasTool = (name: string): boolean => availableToolNames === undefined
    || availableToolNames.includes(name);
  const batchEditTool = hasTool('edit') ? 'edit' : 'multi_edit';
  const diffTool = hasTool('changed_diff') ? 'changed_diff'
    : hasTool('changed_diff_bundle') ? 'changed_diff_bundle' : undefined;
  // Runtime passes model-visible names: a surviving legacy reader may be needed
  // because the list tool is absent or overridden by a different contract.
  const todoReader = availableToolNames?.includes('todo_get') ? 'todo_get'
    : hasTool('todo_list') ? 'todo_list' : undefined;
  const todoReadCall = todoReader === 'todo_list' ? 'todo_list({id})' : 'todo_get(id)';
  const fullTodo = ['todo_create', 'todo_update', 'todo_list', 'wait_agent'].every(hasTool);
  const fullCollaboration = ['spawn_agent', 'wait_agent', 'send_message', 'followup_task', 'list_agents', 'agent_output', 'interrupt_agent'].every(hasTool);
  const managedRunContextTrust = [
    'MANAGED RUN CONTEXT TRUST:',
    staticText("worker.context-trust"),
  ].join('\n');
  const planFirstContract = [
    'PLAN-FIRST GUIDANCE:',
    // Evidence/verification duties read as "inspect the machine first": weak models ran `dir`/`uname`
    // before answering how-to questions, and tied answers about other systems to the local host.
    `- ${staticText("worker.answer-directly")}`,
    staticText("worker.plan-first.rules"),
    `- ${PLAN_BATCH_GUIDANCE}`,
    staticText("worker.plan-first.replan"),
  ].join('\n');

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
  const planListHygiene = [
    'PLAN-LIST HYGIENE (staleness + dedup):',
    `- BEFORE \`todo_update\`, call \`${todoReadCall}\` only when another Actor/runtime event may actually have changed that item since you last saw it (for example after a wait/resume boundary). Ordinary consecutive model turns do not require a resynchronization ritual.`,
    staticText("worker.plan-hygiene"),
  ].join('\n');

  const scopeCommitment = [
    'SCOPE COMMITMENT:',
    staticText("worker.scope.contract"),
    hasTool('todo_update')
      ? staticText("worker.scope.disproved-premise-todo")
      : staticText("worker.scope.disproved-premise"),
    staticText("worker.scope.reuse-and-review"),
  ].join('\n');

  const mutationDiscipline = [
    'MUTATION DISCIPLINE:',
    staticText("worker.mutation.read-and-edit"),
    `- For multiple edits to one file, batch with \`${batchEditTool}\` instead of separate calls — atomic, cheaper, structure-preserving.`,
    staticText("worker.mutation.write-and-scratch"),
  ].join('\n');

  const dispatchRules = [
    'AGENT COLLABORATION:',
    staticText("worker.collaboration.rules"),
    // FEATURE_169 v0.7.40 — dispatch objective quality (F0a + F0b). Suite 0
    // v2 audit VALID (bash disagreement 8.9%, pull-correct 3.3%): C bash=0%
    // (vs A=9% baseline-low ceiling-flatten), pull-correct mention 41→76%
    // (+35pp lift), 5/6 alias C ≥ 70%.
    staticText("worker.collaboration.objective-quality"),
    hasTool('run_workflow')
      ? staticText("worker.collaboration.objective-language-workflow")
      : staticText("worker.collaboration.objective-language"),
    staticText("worker.collaboration.pull-tools"),
    hasTool('list_dispatchable_agents')
      ? staticText("worker.collaboration.specialist-routing") : undefined,
  ].filter((line): line is string => line !== undefined).join('\n');

  const parallelFirstCollaboration = [
    staticText("worker.parallel-first"),
  ].join('\n');

  const childSteeringRules = [
    staticText("worker.agent-steering"),
  ].join('\n');

  // Keep first-choice guidance visible even when rich tool descriptions are deferred.
  // Capability snapshots come from the executable tool set, never task keywords.
  const lspTools = ['lsp_workspace_symbols', 'lsp_implementation', 'lsp_incoming_calls', 'lsp_outgoing_calls']
    .filter(hasTool);
  // Capsule and pull-tool fallback lines only make sense when a pull-tool is on the menu.
  const hasRepoPullTool = ['relationship_scan', 'module_context', 'symbol_context', 'impact_estimate',
    'process_context', 'repo_overview', 'changed_scope'].some(hasTool);
  const repoIntelligenceTools = [
    'REPO INTELLIGENCE TOOLS:',
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
  ].filter((line): line is string => line !== undefined).join('\n');

  // Static EXECUTION GUIDANCE (shared with the direct-engine path) replaces the
  // router-injected EXECUTION_MODE / HARNESS_PROFILE overlays — the Worker
  // self-judges the kind of work instead of being told by a keyword router.
  // See `prompts/execution-guidance.ts` + ADR-043.

  const handoffRules = [
    'TERMINATION:',
    staticText("worker.termination"),
  ].join('\n');

  const limitedPlanGuidance = [
    'PLAN-FIRST GUIDANCE (available capability):',
    staticText("worker.limited-plan.rules"),
    hasTool('todo_create')
      ? staticText("worker.limited-plan.todo-create") : undefined,
    hasTool('todo_update')
      ? staticText("worker.limited-plan.todo-update") : undefined,
    todoReader && hasTool('todo_update')
      ? `- Use \`${todoReader}\` with id before changing an item only when another Actor or runtime event may have changed it since last seen; ordinary consecutive turns need no refresh ritual.` : undefined,
    hasTool('todo_list')
      ? staticText("worker.limited-plan.todo-list") : undefined,
    todoReader && !hasTool('todo_update')
      ? `- Use \`${todoReader}\` with id when the state of an existing milestone is uncertain.` : undefined,
    staticText("worker.limited-plan.language"),
  ].filter((line): line is string => line !== undefined).join('\n');
  const limitedCollaboration = [
    'AGENT COLLABORATION (available capability):',
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
  ].filter((line): line is string => line !== undefined).join('\n');
  const limitedHandoff = [
    'TERMINATION:',
    staticText("worker.limited-termination.verify"),
    hasTool('todo_update')
      ? staticText("worker.limited-termination.todo-check") : undefined,
    staticText("worker.limited-termination.summary"),
  ].filter((line): line is string => line !== undefined).join('\n');

  return [
    managedRunContextTrust,
    hasTool('spawn_agent') ? parallelFirstCollaboration : staticText("worker.local-execution"),
    fullTodo ? planFirstContract : limitedPlanGuidance,
    fullTodo ? planListHygiene : undefined,
    scopeCommitment,
    mutationDiscipline,
    repoIntelligenceTools,
    fullCollaboration ? dispatchRules : limitedCollaboration,
    fullCollaboration ? childSteeringRules : undefined,
    EXECUTION_GUIDANCE,
    fullTodo && fullCollaboration ? handoffRules : limitedHandoff,
  ]
    .filter((part): part is string => Boolean(part?.length))
    .join('\n\n');
}

/**
 * Renders only classified routing facts. Unclassified placeholders carry no signal, and the
 * bare `requiresBrainstorm` flag (true for every low-confidence "unknown" request) lost its
 * explanation when the router overlay retired: next to the Skill catalog, models read
 * "Brainstorm required: yes" as a Skill to invoke. The flag still drives routing internally.
 */
export function buildWorkerRoutingContext(
  decision: KodaXTaskRoutingDecision,
): string {
  return [
    `You are the Worker — KodaX's single primary agent for this task. Routing decision summary:`,
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
