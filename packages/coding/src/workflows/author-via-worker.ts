/**
 * FEATURE_246 — host-facing "author a workflow via the Worker" entrypoint.
 *
 * The REPL's `/workflow create <request>` does NOT call the context-blind
 * `generateWorkflowFromOptions`; it submits the request as an agent turn with
 * `agentMode:'ama'` plus explicit Workflow intent, so the Worker scouts the repo and then
 * authors + runs the workflow via `run_workflow` (ADR-047 scout-then-author).
 * That intent is REPL-internal glue (`workflowIntent` →
 * `handleCommandResult` → `runAgentRound`), so a non-REPL embedder host (e.g.
 * KodaX-Space) previously had no documented one-call way to reach it and fell
 * back to the blind generator.
 *
 * `authorWorkflowViaWorker` is that one call: it uses `agentMode:'ama'` for
 * the turn, prepends the same scout-then-author instruction the REPL uses (a
 * single shared constant, so both stay byte-identical), and starts the turn via
 * the existing `startKodaX` handle. The host observes progress through the
 * options it already passes (`events.onWorkflowProcessEvent`); the returned
 * `workflowRunId` promise resolves once the Worker actually launches a workflow
 * (or `undefined` if the turn ends without one — the Worker judged a workflow
 * unnecessary). It composes existing pieces only — no new session/runner/tool.
 */

import { startKodaX, type RunningSession } from '../running-session.js';
import type { KodaXOptions } from '../types.js';
import type { WorkflowProcessEvent } from '@kodax-ai/agent';

/**
 * The scout-then-author instruction lines handed to the Worker. Single source
 * of truth: the REPL `/workflow create` path imports these same lines so the
 * built-in command and this SDK entrypoint produce a byte-identical authoring
 * turn (guarded by a test). Keep in sync ONLY by editing here.
 */
export const SCOUT_THEN_AUTHOR_PROMPT_LINES: readonly string[] = [
  'Set up and run a multi-agent workflow for this task.',
  'First investigate the relevant files and sub-problems with your own tools, then author and run it with run_workflow — bake the concrete findings (exact paths, the specific dimensions to compare, a real outputSchema) into the child prompts rather than re-delegating the scouting.',
];

/** Build the full scout-then-author turn prompt for a free-text request. */
export function buildScoutThenAuthorPrompt(request: string): string {
  return [...SCOUT_THEN_AUTHOR_PROMPT_LINES, '', request].join('\n');
}

export interface AuthorWorkflowViaWorkerInput {
  /** The natural-language authoring request (what to build a workflow for). */
  readonly request: string;
  /**
   * Base session options. MUST include `workflowRunsBaseDir` — without it the
   * Worker's `run_workflow` tool does not wire and no workflow can be authored
   * (this call throws early rather than silently degrading). `agentMode` is
   * forced to `'ama'` for this turn regardless of what the base options carry.
   */
  readonly options: KodaXOptions;
}

export interface AuthorWorkflowViaWorkerHandle {
  /** The underlying run handle (result / abort / mid-turn mutators). */
  readonly session: RunningSession;
  /**
   * Resolves with the workflow run id once the Worker launches a workflow
   * during this turn, or `undefined` if the turn ends without starting one.
   * Backed by the FIRST `workflow_started` process event — the same runId a
   * host sees on `events.onWorkflowProcessEvent`.
   *
   * NOTE: reflects only the first workflow the Worker starts this turn. If the
   * Worker starts several (e.g. stops one and reruns another), `workflowRunId`
   * still resolves to the first; subscribe to `events.onWorkflowProcessEvent`
   * for the full set of runs.
   */
  readonly workflowRunId: Promise<string | undefined>;
}

/**
 * Route a natural-language authoring request into the Worker's scout-then-author
 * explicit Workflow path, returning a run handle plus the eventual workflow run id.
 */
export function authorWorkflowViaWorker(
  input: AuthorWorkflowViaWorkerInput,
): AuthorWorkflowViaWorkerHandle {
  if (!input.options.workflowRunsBaseDir) {
    throw new Error(
      'authorWorkflowViaWorker: options.workflowRunsBaseDir is required — without it the Worker cannot wire run_workflow (see public_docs/sdk/embedder-guide.md §11).',
    );
  }

  let resolveRunId!: (id: string | undefined) => void;
  const workflowRunId = new Promise<string | undefined>((resolve) => {
    resolveRunId = resolve;
  });
  let settled = false;
  const settle = (id: string | undefined): void => {
    if (settled) return;
    settled = true;
    resolveRunId(id);
  };

  const hostOnProcessEvent = input.options.events?.onWorkflowProcessEvent;
  const options: KodaXOptions = {
    ...input.options,
    agentMode: 'ama',
    context: {
      ...input.options.context,
      workflowIntent: 'explicit',
    },
    events: {
      ...input.options.events,
      onWorkflowProcessEvent: (event: WorkflowProcessEvent) => {
        if (event.type === 'workflow_started') settle(event.snapshot.runId);
        hostOnProcessEvent?.(event);
      },
    },
  };

  const session = startKodaX(options, buildScoutThenAuthorPrompt(input.request));
  // If the turn ends without ever launching a workflow, resolve `undefined` so
  // the host's `await workflowRunId` never hangs.
  void session.result.then(
    () => settle(undefined),
    () => settle(undefined),
  );

  return { session, workflowRunId };
}
