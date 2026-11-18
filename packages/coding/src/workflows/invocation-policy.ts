export type WorkflowInvocationSource = 'natural-language' | 'command';
export type WorkflowInvocationAction = 'none' | 'suggest';
export type WorkflowStartOutcome = 'started' | 'declined' | 'cancelled' | 'failed';

/**
 * Host-owned execution ceilings for a workflow run (FEATURE_229). These clamp
 * the run-manager / runner (maxAgents, concurrency, token budget); they do not
 * affect whether a workflow launches — that is decided by the source alone
 * (ADR-047).
 */
export interface WorkflowHostPolicy {
  readonly maxAgents?: number;
  readonly maxConcurrency?: number;
  readonly tokenBudget?: number;
}

export interface WorkflowInvocationPolicyInput {
  readonly source: WorkflowInvocationSource;
}

export interface WorkflowInvocationPolicyDecision {
  readonly action: WorkflowInvocationAction;
}

/**
 * Decide whether a natural-language turn should receive the model-callable
 * Workflow surface. This does not launch or generate anything: the Worker still
 * scouts and authors the protocol. Requiring the standalone product word keeps
 * ordinary parallel/review requests from acquiring `run_workflow`; the code
 * identifier `run_workflow` alone is deliberately not an activation signal.
 */
export function hasExplicitNaturalLanguageWorkflowIntent(input: string): boolean {
  return /\bworkflows?\b|工作流(?!程)|ワークフロー|워크플로우/iu.test(input);
}

/**
 * Decide whether the REPL host should launch a workflow before the agent runs.
 *
 * FEATURE_246 A5 (ADR-047): the host only launches workflows for an explicit
 * `/workflow` command (`'suggest'`). Natural language is never intercepted in
 * any mode (`'none'`) — in AMA/AMAW the Worker owns the decision through the
 * `run_workflow` tool, which scouts the codebase first and authors a script
 * from real findings (file paths, the actual sub-problems, a concrete
 * outputSchema). A blind host-side generator cannot investigate, so pre-empting
 * NL here produced shallow, disjointed workflows. Direct (non-AMA) runs have no workflow host.
 *
 * The decision is the source alone, so this takes no agent mode or input text:
 * the earlier NL detection (explicit/complexity/negation regexes) existed only
 * to gate the removed auto-start path — that judgment now belongs to the Worker
 * with full context, not a keyword match.
 */
export function decideWorkflowInvocation(
  input: WorkflowInvocationPolicyInput,
): WorkflowInvocationPolicyDecision {
  return { action: input.source === 'command' ? 'suggest' : 'none' };
}

export function workflowStartOutcomeConsumesTurn(input: {
  readonly outcome: WorkflowStartOutcome;
}): boolean {
  return input.outcome === 'started' || input.outcome === 'cancelled';
}
