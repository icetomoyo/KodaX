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
  staticText("worker.EXPLICIT_WORKFLOW_POLICY.text");

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
  const availableStartSlots = Math.max(
    0,
    actorCapacity.maxConcurrentThreads - 1 - actorCapacity.activeNonRootTurns,
  );
  return [
    `- This Actor tree has ${actorCapacity.maxConcurrentThreads} total concurrency slots; the root occupies one reserved slot, so at most ${Math.max(0, actorCapacity.maxConcurrentThreads - 1)} non-root Agents can run at once.`,
    `- At this prompt snapshot, ${actorCapacity.activeNonRootTurns} non-root turns are active and ${availableStartSlots} child start slots are available.`,
    `- HARD RUNTIME LIMIT FOR THIS ASSISTANT RESPONSE: emit at most ${availableStartSlots} \`spawn_agent\` calls. Calls beyond this number will be rejected; do not attempt them.`,
    `- If the task has more independent tracks, select at most ${availableStartSlots} for the first wave. Keep the remaining tracks with the root or name them as a later refill wave after a terminal event.`,
    availableToolNames === undefined || availableToolNames.includes('list_agents')
      ? staticText("worker.buildWorkerActorCapacityGuidance.text")
      : staticText("worker.buildWorkerActorCapacityGuidance.text.1"),
  ];
}

export function buildWorkerActorCapacityContract(
  actorCapacity: WorkerActorCapacity | undefined,
  availableToolNames?: readonly string[],
): string | undefined {
  const guidance = buildWorkerActorCapacityGuidance(actorCapacity, availableToolNames);
  return guidance.length === 0
    ? undefined
    : ['ACTOR CAPACITY (authoritative runtime fact):', ...guidance].join('\n');
}

export function buildWorkerReviewFanoutContract(
  decision: KodaXTaskRoutingDecision,
  actorCapacity: WorkerActorCapacity | undefined,
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
  if (availableToolNames !== undefined && !availableToolNames.includes('spawn_agent')) {
    return [
      'BROAD REVIEW (available capability):',
      staticText("worker.buildWorkerReviewFanoutContract.text"),
      staticText("worker.buildWorkerReviewFanoutContract.text.1"),
    ].join('\n');
  }
  const availableStartSlots = actorCapacity === undefined
    ? undefined
    : Math.max(
        0,
        actorCapacity.maxConcurrentThreads - 1 - actorCapacity.activeNonRootTurns,
      );
  const launchRule = availableStartSlots === undefined
    ? staticText("worker.launchRule.text")
    : availableStartSlots >= 2
      ? '- Current capacity permits a review wave: start at least 2 distinct read-only review Agents.'
      : availableStartSlots === 1
        ? '- Start 1 read-only review Agent and keep a separate review lane with the root.'
        : staticText("worker.launchRule.text.1");
  const scopeAcquisition = availableToolNames === undefined || availableToolNames.includes('changed_scope')
    ? 'call `changed_scope` once' : 'establish the requested scope with available tools';
  const diffTool = availableToolNames === undefined || availableToolNames.includes('changed_diff')
    ? 'changed_diff' : availableToolNames.includes('changed_diff_bundle') ? 'changed_diff_bundle' : undefined;
  const diffReading = diffTool ? `\`${diffTool}\` or before ` : '';
  const scopeRule = isDiffScopedReview
    ? `- If the exact diff scope is unknown, ${scopeAcquisition}, then fan out before ${diffReading}the root reads every diff.`
    : staticText("worker.scopeRule.text");

  return [
    'BROAD REVIEW FAN-OUT (authoritative task policy):',
    `- Review scale: ${decision.reviewScale ?? 'systemic-scope'}`,
    `- Review target: ${decision.reviewTarget ?? 'general'}`,
    `- Independent QA needed: ${decision.needsIndependentQA ? 'yes' : 'no'}`,
    launchRule,
    scopeRule,
    staticText("worker.buildWorkerReviewFanoutContract.text.2"),
    staticText("worker.buildWorkerReviewFanoutContract.text.3"),
  ].join('\n');
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
    staticText("worker.managedRunContextTrust.text"),
    staticText("worker.managedRunContextTrust.text.1"),
    staticText("worker.managedRunContextTrust.text.2"),
    staticText("worker.managedRunContextTrust.text.3"),
    staticText("worker.managedRunContextTrust.text.4"),
    staticText("worker.managedRunContextTrust.text.5"),
    staticText("worker.managedRunContextTrust.text.6"),
  ].join('\n');
  const planFirstContract = [
    'PLAN-FIRST GUIDANCE:',
    staticText("worker.planFirstContract.text"),
    staticText("worker.planFirstContract.text.1"),
    staticText("worker.planFirstContract.text.2"),
    staticText("worker.planFirstContract.text.3"),
    staticText("worker.planFirstContract.text.4"),
    staticText("worker.planFirstContract.text.5"),
    staticText("worker.planFirstContract.text.6"),
    staticText("worker.planFirstContract.text.7"),
    staticText("worker.planFirstContract.text.8"),
    `- ${PLAN_BATCH_GUIDANCE}`,
    staticText("worker.planFirstContract.text.9"),
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
    staticText("worker.planListHygiene.text"),
    staticText("worker.planListHygiene.text.1"),
    staticText("worker.planListHygiene.text.2"),
  ].join('\n');

  const scopeCommitment = [
    'SCOPE COMMITMENT:',
    staticText("worker.scopeCommitment.text"),
    hasTool('todo_update')
      ? staticText("worker.scopeCommitment.text.1")
      : staticText("worker.scopeCommitment.text.2"),
    staticText("worker.scopeCommitment.text.3"),
    staticText("worker.scopeCommitment.text.4"),
  ].join('\n');

  const mutationDiscipline = [
    'MUTATION DISCIPLINE:',
    staticText("worker.mutationDiscipline.text"),
    staticText("worker.mutationDiscipline.text.1"),
    `- For multiple edits to one file, batch with \`${batchEditTool}\` instead of separate calls — atomic, cheaper, structure-preserving.`,
    staticText("worker.mutationDiscipline.text.2"),
    staticText("worker.mutationDiscipline.text.3"),
  ].join('\n');

  const dispatchRules = [
    'AGENT COLLABORATION:',
    staticText("worker.dispatchRules.text"),
    staticText("worker.dispatchRules.text.1"),
    staticText("worker.dispatchRules.text.2"),
    staticText("worker.dispatchRules.text.3"),
    staticText("worker.dispatchRules.text.4"),
    staticText("worker.dispatchRules.text.5"),
    staticText("worker.dispatchRules.text.6"),
    staticText("worker.dispatchRules.text.7"),
    staticText("worker.dispatchRules.text.8"),
    staticText("worker.dispatchRules.text.9"),
    staticText("worker.dispatchRules.text.10"),
    staticText("worker.dispatchRules.text.11"),
    // FEATURE_169 v0.7.40 — dispatch objective quality (F0a + F0b). Suite 0
    // v2 audit VALID (bash disagreement 8.9%, pull-correct 3.3%): C bash=0%
    // (vs A=9% baseline-low ceiling-flatten), pull-correct mention 41→76%
    // (+35pp lift), 5/6 alias C ≥ 70%.
    staticText("worker.dispatchRules.text.12"),
    hasTool('run_workflow')
      ? staticText("worker.dispatchRules.text.13")
      : staticText("worker.dispatchRules.text.14"),
    staticText("worker.dispatchRules.text.15"),
    hasTool('list_dispatchable_agents')
      ? staticText("worker.dispatchRules.text.16") : undefined,
  ].filter((line): line is string => line !== undefined).join('\n');

  const parallelFirstCollaboration = [
    'PARALLEL-FIRST COLLABORATION:',
    staticText("worker.parallelFirstCollaboration.text"),
    staticText("worker.parallelFirstCollaboration.text.1"),
    staticText("worker.parallelFirstCollaboration.text.2"),
    staticText("worker.parallelFirstCollaboration.text.3"),
    staticText("worker.parallelFirstCollaboration.text.4"),
    staticText("worker.parallelFirstCollaboration.text.5"),
    staticText("worker.parallelFirstCollaboration.text.6"),
    staticText("worker.parallelFirstCollaboration.text.7"),
    staticText("worker.parallelFirstCollaboration.text.8"),
    staticText("worker.parallelFirstCollaboration.text.9"),
  ].join('\n');

  const childSteeringRules = [
    'AGENT STEERING:',
    'WHEN TO `send_message`:',
    staticText("worker.childSteeringRules.text"),
    staticText("worker.childSteeringRules.text.1"),
    staticText("worker.childSteeringRules.text.2"),
    '',
    'WHEN TO `interrupt_agent`:',
    staticText("worker.childSteeringRules.text.3"),
    '- The user cancelled the parent task that justified this child.',
    '- The child is pathologically slow with no progress signal AND a faster path exists.',
    '- Do not interrupt a child just because it is slow but progressing; wait for a relevant event.',
  ].join('\n');

  // Keep first-choice guidance visible even when rich tool descriptions are deferred.
  // Capability snapshots come from the executable tool set, never task keywords.
  const lspTools = ['lsp_workspace_symbols', 'lsp_implementation', 'lsp_incoming_calls', 'lsp_outgoing_calls']
    .filter(hasTool);
  const repoIntelligenceTools = [
    'REPO INTELLIGENCE TOOLS:',
    hasTool('relationship_scan')
      ? staticText("worker.repoIntelligenceTools.text") : undefined,
    hasTool('module_context')
      ? staticText("worker.repoIntelligenceTools.text.1") : undefined,
    hasTool('symbol_context')
      ? '- Use `symbol_context` before grepping for one symbol and its probable callers/callees.' : undefined,
    hasTool('impact_estimate')
      ? '- Before planning a rename/refactor, use `impact_estimate` to estimate the blast radius.' : undefined,
    hasTool('process_context')
      ? '- Use `process_context` to trace execution from an entry point.' : undefined,
    hasTool('repo_overview')
      ? staticText("worker.repoIntelligenceTools.text.2") : undefined,
    hasTool('changed_scope')
      ? staticText("worker.repoIntelligenceTools.text.3") : undefined,
    hasTool('spawn_agent')
      ? `- For change-set review, establish the requested scope, then fan out before ${diffTool ? '\`' + diffTool + '\` or ' : ''}reading every diff locally. The root reads its own lane and integrates the others.`
      : staticText("worker.repoIntelligenceTools.text.4"),
    diffTool ? `- Use \`${diffTool}\` for paged diffs of explicit changed files.` : undefined,
    staticText("worker.repoIntelligenceTools.text.5"),
    lspTools.length > 0
      ? `- For exact file positions or compiler-backed symbol/call hierarchy edges, use the available LSP tools: ${lspTools.map((name) => '\`' + name + '\`').join(', ')}.` : undefined,
    hasTool('grep') && hasTool('glob')
      ? '- Prefer grep/glob for local content/path lookup.' : undefined,
    hasTool('semantic_lookup')
      ? '- Use `semantic_lookup` for concepts rather than exact strings.' : undefined,
    staticText("worker.repoIntelligenceTools.text.6"),
    staticText("worker.repoIntelligenceTools.text.7"),
    hasTool('changed_diff_bundle') || hasTool('changed_diff')
      ? staticText("worker.repoIntelligenceTools.text.8") : undefined,
  ].filter((line): line is string => line !== undefined).join('\n');

  // Static EXECUTION GUIDANCE (shared with the SA path) replaces the
  // router-injected EXECUTION_MODE / HARNESS_PROFILE overlays — the Worker
  // self-judges the kind of work instead of being told by a keyword router.
  // See `prompts/execution-guidance.ts` + ADR-043.

  const handoffRules = [
    'TERMINATION:',
    staticText("worker.handoffRules.text"),
    staticText("worker.handoffRules.text.1"),
    staticText("worker.handoffRules.text.2"),
    staticText("worker.handoffRules.text.3"),
    staticText("worker.handoffRules.text.4"),
  ].join('\n');

  const limitedPlanGuidance = [
    'PLAN-FIRST GUIDANCE (available capability):',
    staticText("worker.limitedPlanGuidance.text"),
    staticText("worker.limitedPlanGuidance.text.1"),
    staticText("worker.limitedPlanGuidance.text.2"),
    hasTool('todo_create')
      ? staticText("worker.limitedPlanGuidance.text.3") : undefined,
    hasTool('todo_update')
      ? staticText("worker.limitedPlanGuidance.text.4") : undefined,
    todoReader && hasTool('todo_update')
      ? `- Use \`${todoReader}\` with id before changing an item only when another Actor or runtime event may have changed it since last seen; ordinary consecutive turns need no refresh ritual.` : undefined,
    hasTool('todo_list')
      ? staticText("worker.limitedPlanGuidance.text.5") : undefined,
    todoReader && !hasTool('todo_update')
      ? `- Use \`${todoReader}\` with id when the state of an existing milestone is uncertain.` : undefined,
    staticText("worker.limitedPlanGuidance.text.6"),
  ].filter((line): line is string => line !== undefined).join('\n');
  const limitedCollaboration = [
    'AGENT COLLABORATION (available capability):',
    hasTool('spawn_agent')
      ? staticText("worker.limitedCollaboration.text") : undefined,
    hasTool('spawn_agent')
      ? staticText("worker.limitedCollaboration.text.1") : undefined,
    hasTool('spawn_agent') && hasTool('list_dispatchable_agents')
      ? '- Use a matching registered specialist\'s canonical agent_id from `list_dispatchable_agents`.' : undefined,
    hasTool('wait_agent')
      ? staticText("worker.limitedCollaboration.text.2") : undefined,
    hasTool('send_message')
      ? staticText("worker.limitedCollaboration.text.3") : undefined,
    hasTool('followup_task')
      ? '- Use `followup_task` to start another turn on an idle actor or update a running actor\'s objective.' : undefined,
    hasTool('list_agents') ? '- Use `list_agents` for current tree and capacity state.' : undefined,
    hasTool('agent_output')
      ? staticText("worker.limitedCollaboration.text.4") : undefined,
    hasTool('interrupt_agent')
      ? staticText("worker.limitedCollaboration.text.5") : undefined,
    staticText("worker.limitedCollaboration.text.6"),
    staticText("worker.limitedCollaboration.text.7"),
  ].filter((line): line is string => line !== undefined).join('\n');
  const limitedHandoff = [
    'TERMINATION:',
    staticText("worker.limitedHandoff.text"),
    hasTool('todo_update')
      ? staticText("worker.limitedHandoff.text.1") : undefined,
    staticText("worker.limitedHandoff.text.2"),
  ].filter((line): line is string => line !== undefined).join('\n');

  return [
    managedRunContextTrust,
    hasTool('spawn_agent') ? parallelFirstCollaboration : staticText("worker.buildWorkerStableInstructions.text"),
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

export function buildWorkerRoutingContext(
  decision: KodaXTaskRoutingDecision,
): string {
  return [
    `You are the Worker — KodaX's single primary agent for this task. Routing decision summary:`,
    `- Primary task: ${decision.primaryTask}`,
    `- Assurance intent: ${decision.assuranceIntent ?? 'default'}`,
    `- Work intent: ${decision.workIntent}`,
    `- Risk: ${decision.riskLevel}`,
    `- Complexity: ${decision.complexity}`,
    `- Review scale: ${decision.reviewScale ?? 'not classified'}`,
    `- Review target: ${decision.reviewTarget ?? 'general'}`,
    `- Independent QA needed: ${decision.needsIndependentQA ? 'yes' : 'no'}`,
    `- Brainstorm required: ${decision.requiresBrainstorm ? 'yes' : 'no'}`,
  ].join('\n');
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
  const reviewFanoutContract = buildWorkerReviewFanoutContract(decision, actorCapacity, availableToolNames);

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
