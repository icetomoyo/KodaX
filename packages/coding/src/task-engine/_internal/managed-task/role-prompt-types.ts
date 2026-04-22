/**
 * Role-prompt context types and scope inference helpers — restored from
 * v0.7.22 task-engine (FEATURE_079 Slice 8). Re-added v0.7.26 during
 * parity audit: `createRolePrompt` + downstream tool-policy builders both
 * read these, so they travel together as a single module.
 */

import type {
  KodaXRoleRoundSummary,
  KodaXSkillInvocationContext,
  KodaXSkillMap,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
} from '../../../types.js';

// Re-export single-source-of-truth mutation intent helpers (they live with
// the tool-policy module because the tool-policy builder also consumes them).
export {
  inferScoutMutationIntent,
  type ScoutMutationIntent,
  type ScoutScopeHint,
} from './tool-policy.js';

export interface ManagedRolePromptContext {
  originalTask: string;
  skillInvocation?: KodaXSkillInvocationContext;
  skillMap?: KodaXSkillMap;
  skillExecutionArtifactPath?: string;
  skillMapArtifactPath?: string;
  previousRoleSummaries?: Partial<Record<KodaXTaskRole, KodaXRoleRoundSummary>>;
  /** FEATURE_067: Evaluator review prompt for write fan-out diffs from Generator's child agents. */
  childWriteReviewPrompt?: string;
  /**
   * Issue 119: Scout's own scope hints. Downstream H1+ prompt/tool-policy logic
   * infers mutation intent from these instead of the stale pre-Scout
   * `plan.decision.mutationSurface` heuristic value.
   */
  scoutScope?: import('./tool-policy.js').ScoutScopeHint;
  /**
   * v0.7.26 NEW-1 — workspace environment the role should assume.
   * Without this the managed-worker system prompt never tells the LLM
   * where it is running; the SA path injects `Working Directory: ...`
   * via `buildSystemPrompt`, but the Runner-driven path bypassed that
   * builder entirely, causing Scout/Planner/Generator/Evaluator to
   * guess paths (e.g. bash-cd into invented directories).
   */
  workspace?: {
    executionCwd: string;
    gitRoot?: string;
    platform: NodeJS.Platform;
    osRelease?: string;
  };
}

/**
 * Simple predicate used by the role-prompt builder to decide whether a routing
 * decision should surface review-focused evidence guidance.
 */
export function isReviewEvidenceTask(decision: KodaXTaskRoutingDecision): boolean {
  return decision.primaryTask === 'review' || decision.recommendedMode === 'strict-audit';
}
