/**
 * Pure goal lifecycle policy shared by every goal writer (FEATURE_298 T32).
 * The third real caller (Host session commands) crossed the abstraction
 * threshold; the REPL command and the run-side wiring migrate onto this
 * planner as their tickets land.
 */
import {
  appendGoalEntry,
  readLatestGoalState,
  type KodaXGoalEventType,
  type KodaXGoalState,
  type KodaXSessionLineage,
} from '@kodax-ai/agent';
import { buildCreatedGoal, buildPausedGoal, buildResumedGoal } from './state.js';

export type GoalPlan =
  | {
      readonly ok: true;
      readonly goal: KodaXGoalState;
      readonly lineage: KodaXSessionLineage;
    }
  | {
      readonly ok: false;
      readonly code: 'conflict';
      readonly message: string;
    };

/** Create policy: refuse while a non-complete goal exists; keep the
 * complete → cleared → created transition explicit when overwriting. */
export function planGoalCreate(
  lineage: KodaXSessionLineage,
  objective: string,
  tokenBudget: number | null,
): GoalPlan {
  const existing = readLatestGoalState(lineage);
  if (existing !== null && existing.status !== 'complete') {
    return {
      ok: false,
      code: 'conflict',
      message: `A goal is already active (status: ${existing.status}); clear it before creating a new one.`,
    };
  }
  const goal = buildCreatedGoal(objective, tokenBudget);
  const withCleared = existing !== null
    ? appendGoalEntry(lineage, null, 'cleared')
    : lineage;
  return { ok: true, goal, lineage: appendGoalEntry(withCleared, goal, 'created') };
}

/** Status-transition policy for pause/resume: only defined from one status. */
export function planGoalTransition(
  lineage: KodaXSessionLineage,
  event: Extract<KodaXGoalEventType, 'paused' | 'resumed'>,
): GoalPlan {
  const existing = readLatestGoalState(lineage);
  if (existing === null) {
    return { ok: false, code: 'conflict', message: `No goal to ${event}.` };
  }
  if (event === 'paused') {
    if (existing.status !== 'active') {
      return {
        ok: false,
        code: 'conflict',
        message: `Cannot pause a goal with status '${existing.status}'; only 'active' goals are pausable.`,
      };
    }
    const goal = buildPausedGoal(existing);
    return { ok: true, goal, lineage: appendGoalEntry(lineage, goal, 'paused') };
  }
  if (existing.status !== 'paused') {
    return {
      ok: false,
      code: 'conflict',
      message: `Cannot resume a goal with status '${existing.status}'; only 'paused' goals are resumable.`,
    };
  }
  const goal = buildResumedGoal(existing);
  return { ok: true, goal, lineage: appendGoalEntry(lineage, goal, 'resumed') };
}
