/**
 * dispatch_child_task — FEATURE_067 (v3: single-child async generator tool)
 *
 * Executes ONE child agent per tool call as an async generator.
 * Yields progress updates that appear in the REPL transcript in real-time.
 * The LLM dispatches multiple children by calling this tool multiple times
 * in parallel (multiple tool_use blocks in one response).
 */

import type {
  KodaXChildContextBundle,
  KodaXAmaFanoutClass,
  KodaXToolExecutionContext,
} from '../types.js';
import type { ToolProgress } from './types.js';
import { executeChildAgents, type ChildExecutorOptions } from '../child-executor.js';

/* ---------- Constants ---------- */

const DEFAULT_MAX_ITERATIONS_PER_CHILD = 200;
const MAX_FINDING_CHARS = 8000;
const TOOL_NAME = 'dispatch_child_task';

/* ---------- Tool handler (async generator) ---------- */

export async function* toolDispatchChildTask(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): AsyncGenerator<ToolProgress, string, void> {
  // --- Validate input ---
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
  const childId = id || `child-${Date.now()}`;

  if (!objective) {
    yield { stage: 'error', message: `Child "${childId}": missing objective` };
    return `[Tool Error] ${TOOL_NAME}: Missing required parameter: objective`;
  }

  const role = ctx.managedProtocolRole;
  if (role === 'planner' || role === 'evaluator') {
    return `[Tool Error] ${TOOL_NAME}: ${role} cannot dispatch child tasks. Only Scout and Generator may use this tool.`;
  }

  const readOnly = (input.read_only ?? input.readOnly) !== false;
  if (role === 'scout' && !readOnly) {
    return `[Tool Error] ${TOOL_NAME}: Scout can only dispatch read-only tasks. Write fan-out is available to Generator only.`;
  }
  const bundle: KodaXChildContextBundle = {
    id: childId,
    fanoutClass: 'evidence-scan' as KodaXAmaFanoutClass,
    objective,
    readOnly,
    scopeSummary: typeof input.scope_summary === 'string' ? input.scope_summary : undefined,
    evidenceRefs: Array.isArray(input.evidence_refs)
      ? input.evidence_refs.filter((r): r is string => typeof r === 'string')
      : [],
    constraints: Array.isArray(input.constraints)
      ? input.constraints.filter((c): c is string => typeof c === 'string')
      : [],
  };

  // --- Build executor options ---
  const parentConfig = ctx.parentAgentConfig;
  const options: ChildExecutorOptions = {
    maxParallel: 1,
    maxIterationsPerChild: DEFAULT_MAX_ITERATIONS_PER_CHILD,
    abortSignal: ctx.abortSignal,
    parentOptions: {
      provider: parentConfig?.provider,
      model: parentConfig?.model,
      reasoningMode: parentConfig?.reasoningMode,
      extensionRuntime: ctx.extensionRuntime,
    },
    parentRole: role ?? 'scout',
    parentHarness: 'tool-dispatch',
    // Progress from child executor (e.g. "[1/3] Running: ...") flows through
    // reportToolProgress → onToolProgress → REPL transcript/spinner.
    // Generator yields only cover start/done transitions; this callback covers
    // the entire child execution period in between.
    onProgress: (note: string) => {
      ctx.reportToolProgress?.(note);
    },
    // FEATURE_074: forward the parent-injected plan-mode predicate into the child
    // executor. The predicate is a live closure — it reads parent state at each
    // child tool call, so mid-run mode toggles propagate without respawn.
    planModeBlockCheck: ctx.planModeBlockCheck,
  };

  // --- Execute single child ---
  const result = await executeChildAgents([bundle], ctx, options);

  // --- Register write worktrees for Evaluator diff injection ---
  if (result.worktreePaths && result.worktreePaths.size > 0 && ctx.registerChildWriteWorktrees) {
    ctx.registerChildWriteWorktrees(result.worktreePaths);
  }

  // --- Yield completion progress ---
  const childResult = result.results[0];
  const status = childResult?.status ?? 'failed';
  yield { stage: 'done', message: `Child "${childId}" → ${status}` };

  // --- Return final result ---
  if (!childResult || childResult.status === 'failed') {
    return `Child task "${childId}" failed: ${childResult?.summary?.slice(0, 1000) ?? 'no result'}`;
  }

  const finding = result.mergedFindings[0];
  if (finding) {
    return finding.evidence.join('\n').slice(0, MAX_FINDING_CHARS);
  }
  return childResult.summary.slice(0, MAX_FINDING_CHARS);
}
