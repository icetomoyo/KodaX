/**
 * Review-routing floor — 1:1 port of legacy
 * `task-engine.ts::applyCurrentDiffReviewRoutingFloor` + helpers
 * (`inferReviewTarget`, `isDiffDrivenReviewPrompt`).
 *
 * Restored in v0.7.26 (F3 parity) because the Runner-driven path
 * dropped the entire review-routing floor. Symptoms:
 *   - `decision.reviewTarget` / `decision.reviewScale` never populated
 *     from the prompt (only from the model router, which ignores them)
 *   - `buildRunnerRoutingNote` (H3) reads `decision.reviewTarget` but
 *     that field is always undefined, so the routing strip never shows
 *     review target / review scale detail
 *   - Diff-driven review prompts ("review the current changes") never
 *     trigger the `primaryTask: 'review'` floor or record their scope
 *     as a routing note for Scout's evidence strategy
 *
 * The floor is informational — it NEVER forces a heavier harness.
 * Scout remains the harness authority (FEATURE_061). The floor only
 * annotates the decision with review target/scale context and
 * reclassifies the task as `primaryTask: 'review'` when the prompt is
 * clearly diff-driven.
 */

import type { KodaXTaskRoutingDecision } from '../../../types.js';
import type { KodaXRepoRoutingSignals } from '@kodax/ai';
import type { ReasoningPlan } from '../../../reasoning.js';
import {
  buildAmaControllerDecision,
  buildPromptOverlay,
} from '../../../reasoning.js';

type ReviewTarget = NonNullable<KodaXTaskRoutingDecision['reviewTarget']>;

/**
 * Classify the prompt's review target: `compare-range` (between commits),
 * `current-worktree` (staged/unstaged), or `general`. Mirrors legacy
 * `inferReviewTarget`. Order matters: `compare-range` checks come first
 * because they're stricter.
 */
export function inferReviewTarget(prompt: string): ReviewTarget {
  const normalized = ` ${prompt.toLowerCase()} `;
  if (
    /\b(compare|range|between|since|from\s+\S+\s+to\s+\S+|commit-range|commit range|diff range)\b/.test(normalized)
    || /提交范围|提交区间|版本范围|对比.*提交|比较.*提交/.test(prompt)
  ) {
    return 'compare-range';
  }
  if (
    /\b(current|worktree|workspace|working tree|staged|unstaged|uncommitted|local changes?|current code changes?|current workspace changes?)\b/.test(normalized)
    || /当前(?:工作区|代码)?改动|当前代码改动|当前工作区改动|所有当前代码改动/.test(prompt)
  ) {
    return 'current-worktree';
  }
  return 'general';
}

/**
 * `true` when the prompt's surface markers clearly indicate a
 * diff-driven review (review / audit / code review, or explicit
 * reference to current changes / changed files). Mirrors legacy
 * `isDiffDrivenReviewPrompt`.
 */
export function isDiffDrivenReviewPrompt(prompt: string): boolean {
  const normalized = ` ${prompt.toLowerCase()} `;
  return (
    /\b(review|code review|audit|look at the changes|changed files|current code changes?|current workspace changes?)\b/.test(normalized)
    || /review一下|评审|审查|看下改动|代码改动/.test(prompt)
  );
}

/**
 * Thresholds ported from `reasoning.ts` (private there). Kept local so
 * this module can compute fallback review scale without reaching into
 * reasoning.ts internals. Values match legacy v22.
 */
const REVIEW_LARGE_FILE_THRESHOLD = 10;
const REVIEW_LARGE_LINE_THRESHOLD = 1200;
const REVIEW_LARGE_MODULE_THRESHOLD = 3;
const REVIEW_MASSIVE_FILE_THRESHOLD = 30;
const REVIEW_MASSIVE_LINE_THRESHOLD = 4000;
const REVIEW_MASSIVE_MODULE_THRESHOLD = 5;

function deriveFallbackReviewScale(
  _prompt: string,
  repoSignals?: KodaXRepoRoutingSignals,
): KodaXTaskRoutingDecision['reviewScale'] | undefined {
  if (repoSignals?.reviewScale) {
    return repoSignals.reviewScale;
  }
  const touchedModules = repoSignals?.touchedModuleCount ?? 0;
  const changedFiles = repoSignals?.changedFileCount ?? 0;
  const changedLines = repoSignals?.changedLineCount ?? 0;
  if (
    changedFiles >= REVIEW_MASSIVE_FILE_THRESHOLD
    || changedLines >= REVIEW_MASSIVE_LINE_THRESHOLD
    || touchedModules >= REVIEW_MASSIVE_MODULE_THRESHOLD
  ) {
    return 'massive';
  }
  if (
    changedFiles >= REVIEW_LARGE_FILE_THRESHOLD
    || changedLines >= REVIEW_LARGE_LINE_THRESHOLD
    || touchedModules >= REVIEW_LARGE_MODULE_THRESHOLD
  ) {
    return 'large';
  }
  return undefined;
}

/**
 * Apply the review-routing floor to a plan. Returns the (possibly
 * updated) plan + a snapshot of the pre-floor decision + the inferred
 * review target. When nothing changes (most non-review prompts), the
 * original plan is returned unchanged.
 *
 * Behavior matches legacy v22 exactly:
 *   - The prompt's review target is always recorded (even for general).
 *   - `reviewScale` is filled from repoSignals or prompt-derived
 *     thresholds.
 *   - When target !== 'general' AND (primaryTask === 'review' OR the
 *     prompt is diff-driven), `primaryTask` is floored to 'review' and
 *     a routing note is appended so Scout can shape its evidence
 *     strategy around the diff surface.
 *   - This does NOT force a heavier harness — Scout remains the
 *     harness authority (FEATURE_061).
 */
export function applyCurrentDiffReviewRoutingFloor(
  plan: ReasoningPlan,
  prompt: string,
  repoSignals?: KodaXRepoRoutingSignals,
): {
  plan: ReasoningPlan;
  rawDecision: KodaXTaskRoutingDecision;
  reviewTarget: ReviewTarget;
  routingOverrideReason?: string;
} {
  const reviewTarget = inferReviewTarget(prompt);
  const rawDecision: KodaXTaskRoutingDecision = {
    ...plan.decision,
    reviewTarget,
  };
  const reviewScale = rawDecision.reviewScale ?? deriveFallbackReviewScale(prompt, repoSignals);
  const diffDrivenReview = reviewTarget !== 'general' && (
    rawDecision.primaryTask === 'review'
    || isDiffDrivenReviewPrompt(prompt)
  );

  const finalDecision: KodaXTaskRoutingDecision = diffDrivenReview && reviewScale
    ? {
      ...rawDecision,
      primaryTask: 'review',
      reviewScale,
      routingNotes: [
        ...(rawDecision.routingNotes ?? []),
        `Diff-driven review surface was classified as ${reviewScale}; use it to shape evidence acquisition, not to force a heavier harness.`,
      ],
      reason: `${rawDecision.reason} Diff-driven review scope was recorded for evidence strategy without forcing a heavier harness.`,
    }
    : reviewScale
      ? { ...rawDecision, reviewScale }
      : rawDecision;

  if (finalDecision === plan.decision) {
    return { plan, rawDecision, reviewTarget };
  }

  const amaControllerDecision = buildAmaControllerDecision(finalDecision);
  return {
    plan: {
      ...plan,
      decision: finalDecision,
      amaControllerDecision,
      promptOverlay: buildPromptOverlay(
        finalDecision,
        plan.providerPolicy?.routingNotes,
        plan.providerPolicy,
        amaControllerDecision,
      ),
    },
    rawDecision,
    reviewTarget,
  };
}
