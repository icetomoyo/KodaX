/**
 * FEATURE_074: exit_plan_mode tool.
 *
 * The LLM calls this after finalizing a plan while in plan mode. The REPL presents
 * the plan to the user for approval; on approval the session flips into
 * `accept-edits` so implementation can proceed.
 *
 * Parent-only: child agents are filtered out via CHILD_EXCLUDE_TOOLS_BASE in
 * child-executor.ts — the approval UI is wired only at the parent REPL.
 */

import type { KodaXToolExecutionContext } from '../types.js';

export async function toolExitPlanMode(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const plan = input.plan as string | undefined;

  if (!plan || typeof plan !== 'string' || plan.trim().length === 0) {
    return '[Tool Error] exit_plan_mode: Missing required parameter: plan (the finalized plan to present to the user for approval)';
  }

  if (!ctx.exitPlanMode) {
    return '[Tool Error] exit_plan_mode: Only available in interactive REPL sessions (no approval UI is wired for this run)';
  }

  const outcome = await ctx.exitPlanMode(plan);

  if (outcome === 'not-in-plan-mode') {
    return '[Tool Error] exit_plan_mode: Not currently in plan mode. This tool is only valid while the session is in plan mode. The session is already in implementation mode — proceed directly with the work.';
  }

  if (outcome === true) {
    return JSON.stringify({
      approved: true,
      note: 'User approved the plan. Permission mode is now accept-edits. Proceed with implementation.',
    });
  }

  return JSON.stringify({
    approved: false,
    note: 'User did not approve the plan. Remain in plan mode. Revise the plan based on user feedback and propose again.',
  });
}
