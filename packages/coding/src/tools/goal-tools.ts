/**
 * FEATURE_192 v0.7.44 Phase C — 3 goal tools (get / create / update).
 *
 * Tool descriptions audited against ADR-033 5 principles:
 *  - Qualitative criteria (no "≥3 turns" hard-coded in user-facing
 *    sentences; the runtime counter enforces it instead)
 *  - Single-concept sentences (no compound do-X-AND-Y rules)
 *  - ✗ patterns include WHY (rejection cases explain the failure
 *    mode they prevent)
 *  - No enumerated taxonomies (use-case examples, not RULE A/B/C)
 *  - No version metadata in prompt body
 *
 * One quantitative anchor remains: `update_goal({blocked})` mentions
 * "3 consecutive turns" because the runtime counter is named that;
 * the user-facing semantic IS the integer 3 (ADR-033 §1 physical-
 * constraint exception).
 */

import type { KodaXToolExecutionContext } from '../types.js';
import { makeDisabledGoalToolsContext } from '../goal/tools-context.js';
import { isValidTokenBudget } from '../goal/state.js';

const NO_GOAL_MESSAGE =
  'No goal set for this session. Use `/goal <objective>` (slash command) or call `create_goal` (only when the user or system instructions explicitly request a goal).';

/**
 * Pull the goal-tools context from the execution context, or a
 * uniform-error fallback when not wired (sync-dispatch / isolated test
 * harness — REPL-driven sessions always provide it).
 */
function getCtx(ctx: KodaXToolExecutionContext) {
  return ctx.goalContext ?? makeDisabledGoalToolsContext();
}

/**
 * get_goal — read-only status snapshot. Returns a brief envelope so
 * the model can show / not-show goal info inline without re-asking.
 */
export async function toolGetGoal(
  _input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const goalCtx = getCtx(ctx);
  const goal = await goalCtx.readGoal();
  if (!goal) return NO_GOAL_MESSAGE;
  const lines: string[] = [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Tokens used: ${goal.tokensUsed}`,
  ];
  if (goal.tokenBudget !== null) {
    const remaining = Math.max(0, goal.tokenBudget - goal.tokensUsed);
    lines.push(`Token budget: ${goal.tokenBudget} (remaining: ${remaining})`);
  } else {
    lines.push('Token budget: none');
  }
  lines.push(`Elapsed: ${goal.timeUsedSeconds}s`);
  if (goal.status === 'blocked' && goal.lastBlockerKind) {
    lines.push(`Blocker: ${goal.lastBlockerKind}`);
  }
  return lines.join('\n');
}

export async function toolCreateGoal(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const goalCtx = getCtx(ctx);
  const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
  if (!objective) {
    return '[Tool Error] create_goal: missing required parameter `objective` (a non-empty string describing the long-running goal).';
  }
  const tokenBudgetRaw = input.token_budget ?? null;
  const tokenBudget = tokenBudgetRaw === null ? null : Number(tokenBudgetRaw);
  if (!isValidTokenBudget(tokenBudget)) {
    return '[Tool Error] create_goal: token_budget must be a positive integer or omitted. Set this only when the user explicitly requested a budget.';
  }
  try {
    const created = await goalCtx.createGoal({ objective, tokenBudget });
    const budgetLine =
      created.tokenBudget !== null
        ? ` (budget: ${created.tokenBudget} tokens)`
        : '';
    return `Goal created: "${created.objective}"${budgetLine}. The agent will pursue this objective until completion, blocked confirmation, or user clear.`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `[Tool Error] create_goal: ${message}`;
  }
}

export async function toolUpdateGoal(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const goalCtx = getCtx(ctx);
  const status = typeof input.status === 'string' ? input.status.trim() : '';
  if (status !== 'complete' && status !== 'blocked') {
    return '[Tool Error] update_goal: status must be exactly "complete" or "blocked". Other status transitions (paused, resumed, cleared, budget_limited) are controlled by the user or the runtime, not this tool.';
  }

  const goal = await goalCtx.readGoal();
  if (!goal) {
    return '[Tool Error] update_goal: no active goal to update. Use create_goal first (only when explicitly requested by the user / system).';
  }

  if (status === 'complete') {
    const control = ctx.actorControl;
    if (control) {
      const prefix = `${control.callerPath}/`;
      if (control.list().actors.some(actor => actor.path.startsWith(prefix) && actor.currentTurnId !== undefined)) {
        return '[Tool Error] update_goal: child work is still active. Inspect its results before completing the goal.';
      }
    }
    const result = await goalCtx.requestComplete();
    if (result.ok) {
      return `Goal marked complete: "${goal.objective}".`;
    }
    const fixHint = result.suggestedFix ? ` Suggested next step: ${result.suggestedFix}` : '';
    return `[Tool Error] update_goal: completion request was rejected. ${result.reason ?? 'unspecified reason.'}${fixHint} Keep working until the objective is achieved.`;
  }

  // status === 'blocked'
  const blockerKind = typeof input.blocker_kind === 'string' ? input.blocker_kind.trim() : '';
  if (!blockerKind) {
    return '[Tool Error] update_goal: status=blocked requires a non-empty `blocker_kind` describing what is preventing progress.';
  }
  const result = await goalCtx.requestBlocked(blockerKind);
  if (result.ok) {
    return `Goal marked blocked: ${result.statusMessage}`;
  }
  return `[Tool Error] update_goal: ${result.statusMessage}`;
}
