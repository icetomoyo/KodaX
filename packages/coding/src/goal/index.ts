/**
 * FEATURE_192 v0.7.44 — `/goal` Persistent Goal — coding-package barrel.
 *
 * Public surface for the coding layer. Aggregate of pure-data modules
 * (state / accounting / blocker-tracker) and the lifecycle composer.
 * Tools / sidecar binding (Phase C) and REPL UI (Phase D) consume from
 * here.
 */

export {
  goalTokenDelta,
  shouldFlipBudgetLimited,
  turnWallTimeDelta,
} from './accounting.js';

export {
  BLOCKER_REQUIRED_CONSECUTIVE_TURNS,
  recordBlockerAttempt,
  resetBlockerCounter,
} from './blocker-tracker.js';
export type { BlockerAttemptResult } from './blocker-tracker.js';

export {
  applyAccountingDelta,
  buildBlockedGoal,
  buildCompleteGoal,
  buildCreatedGoal,
  buildPausedGoal,
  buildResumedGoal,
  isValidTokenBudget,
} from './state.js';

export {
  withGoalBeforeNextTurn,
  withGoalStopHook,
} from './lifecycle.js';
export type { GoalLifecycleContext } from './lifecycle.js';

export { makeDisabledGoalToolsContext } from './tools-context.js';
export type {
  GoalBlockedResult,
  GoalCompleteResult,
  GoalCreateInput,
  GoalToolsContext,
} from './tools-context.js';

export { verifyGoalCompletion } from './sidecar-bind.js';
export type {
  GoalCompletionVerifier,
  VerifyGoalCompletionOptions,
} from './sidecar-bind.js';

export { buildGoalRuntimeBinding } from './runtime-wiring.js';
export type {
  GoalRuntimeBinding,
  GoalRuntimeBindingDeps,
} from './runtime-wiring.js';
export { planGoalCreate, planGoalTransition } from './policy.js';
export type { GoalPlan } from './policy.js';
