

import type { KodaXGoalState } from '@kodax-ai/agent';

export interface GoalCompleteResult {
  readonly ok: boolean;
  /** Present iff `!ok` — explains why complete was rejected. */
  readonly reason?: string;
  /** Optional one-line how-to-fix from the verifier. */
  readonly suggestedFix?: string;
}

export interface GoalBlockedResult {
  readonly ok: boolean;
  /** Status message: success summary or rejection reason. Always set. */
  readonly statusMessage: string;
  /** Counter snapshot for transparency / debugging. */
  readonly counter: { readonly current: number; readonly required: number };
}

export interface GoalCreateInput {
  readonly objective: string;
  readonly tokenBudget?: number | null;
}

export interface GoalToolsContext {
  /** Read current goal state from the session lineage. */
  readonly readGoal: () => Promise<KodaXGoalState | null>;
  /** Create a new goal. Throws if an active goal already exists. */
  readonly createGoal: (input: GoalCreateInput) => Promise<KodaXGoalState>;
  /**
   * Request transition to `complete`. Implementation runs the Sidecar
   * Verifier and returns `{ok:false, reason}` on non-accept. On accept
   * the lineage gets a new goal entry with `status: 'complete'`.
   */
  readonly requestComplete: () => Promise<GoalCompleteResult>;
  /**
   * Request transition to `blocked`. Implementation applies the
   * 3-turn rule via `recordBlockerAttempt` and persists the updated
   * counter regardless of whether the transition was allowed.
   */
  readonly requestBlocked: (blockerKind: string) => Promise<GoalBlockedResult>;
}

/**
 * Module-scoped fallback: when the tool runs without a goal context
 * wired (e.g. dispatched from a non-REPL test harness), each method
 * returns a uniform "feature disabled" error so the model gets a
 * clear signal rather than a silent failure.
 */
export function makeDisabledGoalToolsContext(): GoalToolsContext {
  const disabled = '[Tool Error] /goal feature is not wired in this session (no host adapter — likely an isolated test harness or sync-dispatch context). Goal tools require a REPL session with lineage persistence.';
  return {
    readGoal: async () => null,
    createGoal: async () => {
      throw new Error(disabled);
    },
    requestComplete: async () => ({ ok: false, reason: disabled }),
    requestBlocked: async () => ({
      ok: false,
      statusMessage: disabled,
      counter: { current: 0, required: 3 },
    }),
  };
}
