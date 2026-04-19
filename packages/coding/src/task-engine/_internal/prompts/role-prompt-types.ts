/**
 * FEATURE_079 — Task Engine Phase 1 Pure Extraction (Slice 8)
 *
 * Role-prompt context types and scope inference helpers extracted from
 * task-engine.ts. Zero-behavior-change move. These types were previously
 * module-private in task-engine.ts; they travel together because the prompt
 * builder (`createRolePrompt`) and tool-policy builder
 * (`buildManagedWorkerToolPolicy`) both read them.
 */

import type {
  KodaXRoleRoundSummary,
  KodaXSkillInvocationContext,
  KodaXSkillMap,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
} from '../../../types.js';
import { isDocsLikePath } from '../text-utils.js';

export interface ScoutScopeHint {
  scope?: string[];
  reviewFilesOrAreas?: string[];
}

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
  scoutScope?: ScoutScopeHint;
}

export type ScoutMutationIntent = 'review-only' | 'docs-scoped' | 'open';

/**
 * Issue 119: Infer what kind of mutation the Scout-authorized run expects,
 * based on Scout's own structured outputs (scope + reviewFilesOrAreas +
 * primaryTask), not the pre-Scout regex heuristic on the original prompt.
 *
 * Returns three coarse buckets:
 * - 'review-only': review task with empty scope → Scout expects pure analysis
 * - 'docs-scoped': every path Scout flagged points at documentation
 * - 'open': default — trust Scout's scope + Evaluator tail-gate instead of
 *   hardcoding extra mutation constraints
 */
export function inferScoutMutationIntent(
  scoutScope: ScoutScopeHint | undefined,
  primaryTask: KodaXTaskRoutingDecision['primaryTask'] | undefined,
): ScoutMutationIntent {
  const scope = (scoutScope?.scope ?? []).filter((s) => s.trim().length > 0);
  const reviewFiles = (scoutScope?.reviewFilesOrAreas ?? []).filter((s) => s.trim().length > 0);
  const allPaths = [...scope, ...reviewFiles];

  if (primaryTask === 'review' && scope.length === 0) {
    return 'review-only';
  }

  if (allPaths.length > 0 && allPaths.every(isDocsLikePath)) {
    return 'docs-scoped';
  }

  return 'open';
}

/**
 * Simple predicate used by the role-prompt builder to decide whether a routing
 * decision should surface review-focused evidence guidance.
 */
export function isReviewEvidenceTask(decision: KodaXTaskRoutingDecision): boolean {
  return decision.primaryTask === 'review' || decision.recommendedMode === 'strict-audit';
}
