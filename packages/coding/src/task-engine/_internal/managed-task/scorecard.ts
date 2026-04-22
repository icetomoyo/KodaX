/**
 * Verification scorecard — per-criterion pass/fail scoring for the
 * managed task's verification contract.
 *
 * 1:1 port from legacy `task-engine.ts` (v0.7.22):
 *   - `clampNumber`
 *   - `inferVerificationRubricFamily`
 *   - `resolveVerificationCriteria`
 *   - `createVerificationScorecard`
 *
 * Restored in v0.7.26 to close the H2 parity gap — without this module
 * `scorecard.json` was persisted as `null` and `task.runtime.scorecard`
 * was never populated, so downstream consumers (review-scale UI,
 * session-storage replay, evaluator rubric families) lost structured
 * verdict context.
 */

import type {
  KodaXManagedTask,
  KodaXTaskRoutingDecision,
  KodaXTaskVerificationContract,
  KodaXTaskVerificationCriterion,
  KodaXVerificationScorecard,
} from '../../../types.js';

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Infer the rubric family from the verification contract + primary
 * task. Explicit `verification.rubricFamily` wins; otherwise:
 *   - capabilityHints mentioning agent-browser/playwright → 'frontend'
 *   - primaryTask 'review' → 'code-review'
 *   - primaryTask 'bugfix' → 'functionality'
 *   - default → 'code-quality'
 */
export function inferVerificationRubricFamily(
  verification: KodaXTaskVerificationContract | undefined,
  primaryTask: KodaXTaskRoutingDecision['primaryTask'] | undefined,
): NonNullable<KodaXTaskVerificationContract['rubricFamily']> | undefined {
  if (verification?.rubricFamily) {
    return verification.rubricFamily;
  }
  if (verification?.capabilityHints?.some((hint) => /agent-browser|playwright/i.test(hint.name))) {
    return 'frontend';
  }
  if (primaryTask === 'review') {
    return 'code-review';
  }
  if (primaryTask === 'bugfix') {
    return 'functionality';
  }
  return 'code-quality';
}

/**
 * Resolve the list of verification criteria. When the contract declares
 * explicit criteria, clamp threshold/weight to the valid range; otherwise
 * return the rubric-family-specific default set (frontend, code-review,
 * or the generic triple).
 */
export function resolveVerificationCriteria(
  verification: KodaXTaskVerificationContract | undefined,
  primaryTask: KodaXTaskRoutingDecision['primaryTask'] | undefined,
): KodaXTaskVerificationCriterion[] {
  if (verification?.criteria?.length) {
    return verification.criteria.map((criterion) => ({
      ...criterion,
      threshold: clampNumber(criterion.threshold, 0, 100),
      weight: clampNumber(criterion.weight, 0, 1),
    }));
  }

  const rubricFamily = inferVerificationRubricFamily(verification, primaryTask);
  const requiredEvidence = verification?.requiredEvidence ?? [];
  const requiredChecks = verification?.requiredChecks ?? [];
  if (rubricFamily === 'frontend') {
    return [
      {
        id: 'ui-flow',
        label: 'UI flow verification',
        description: 'Critical browser path completes without visible breakage.',
        threshold: 75,
        weight: 0.4,
        requiredEvidence,
      },
      {
        id: 'console-clean',
        label: 'Console and runtime health',
        description: 'Browser or app runtime should not show blocking errors.',
        threshold: 75,
        weight: 0.25,
        requiredEvidence,
      },
      {
        id: 'check-evidence',
        label: 'Deterministic checks',
        description: 'Required checks or tests must be explicitly reported.',
        threshold: 70,
        weight: 0.35,
        requiredEvidence: [...requiredEvidence, ...requiredChecks],
      },
    ];
  }
  if (rubricFamily === 'code-review') {
    return [
      {
        id: 'finding-accuracy',
        label: 'Finding accuracy',
        description: 'Reported issues should be grounded in concrete evidence.',
        threshold: 80,
        weight: 0.45,
        requiredEvidence,
      },
      {
        id: 'verification',
        label: 'Independent verification',
        description: 'Claims should be independently verified before acceptance.',
        threshold: 75,
        weight: 0.35,
        requiredEvidence: [...requiredEvidence, ...requiredChecks],
      },
      {
        id: 'completeness',
        label: 'Review completeness',
        description: 'High-risk changes should not truncate before the critical findings are delivered.',
        threshold: 70,
        weight: 0.2,
        requiredEvidence,
      },
    ];
  }
  return [
    {
      id: 'functionality',
      label: 'Functional correctness',
      description: 'The requested behavior is implemented and evidenced.',
      threshold: 75,
      weight: 0.5,
      requiredEvidence,
    },
    {
      id: 'checks',
      label: 'Check coverage',
      description: 'Relevant checks and validation evidence are reported.',
      threshold: 70,
      weight: 0.3,
      requiredEvidence: [...requiredEvidence, ...requiredChecks],
    },
    {
      id: 'quality',
      label: 'Quality and safety',
      description: 'The result does not leave obvious correctness or safety gaps behind.',
      threshold: 70,
      weight: 0.2,
      requiredEvidence,
    },
  ];
}

/**
 * Directive subset used by the scorecard. Runner-driven path supplies
 * only `status` + `reason`; legacy's full directive carried more fields
 * but only these two affected scoring.
 */
export interface ScorecardVerdictDirective {
  readonly status?: 'accept' | 'revise' | 'blocked';
  readonly reason?: string;
}

/**
 * Build the structured verification scorecard from the task state +
 * final verdict. Returns `undefined` when no verification contract is
 * declared — matches legacy.
 *
 * Scoring follows legacy's mapping:
 *   - directive.status === 'accept'  → 100
 *   - directive.status === 'revise'  → 45
 *   - task.verdict.status === 'completed' → 90
 *   - task.verdict.status === 'blocked'   → 35
 *   - otherwise                           → 55
 *
 * Each criterion inherits the overall verdict score (legacy did not do
 * per-criterion independent scoring either — the runtime dispatch didn't
 * have the data to). Evidence is criterion's declared `requiredEvidence`
 * plus the last two completed evidence-entry summaries from the task.
 */
export function createVerificationScorecard(
  task: KodaXManagedTask,
  directive: ScorecardVerdictDirective | undefined,
): KodaXVerificationScorecard | undefined {
  const verification = task.contract.verification;
  if (!verification) {
    return undefined;
  }

  const criteria = resolveVerificationCriteria(verification, task.contract.primaryTask).map((criterion) => {
    const evidence = [
      ...(criterion.requiredEvidence ?? []),
      ...task.evidence.entries
        .filter((entry) => entry.status === 'completed' && entry.summary)
        .map((entry) => entry.summary as string)
        .slice(-2),
    ];
    const verdictScore = directive?.status === 'accept'
      ? 100
      : directive?.status === 'revise'
        ? 45
        : task.verdict.status === 'completed'
          ? 90
          : task.verdict.status === 'blocked'
            ? 35
            : 55;
    const score = clampNumber(verdictScore, 0, 100);
    return {
      id: criterion.id,
      label: criterion.label,
      threshold: criterion.threshold,
      score,
      passed: score >= criterion.threshold,
      weight: criterion.weight,
      requiredEvidence: criterion.requiredEvidence,
      evidence,
      reason: directive?.reason,
    };
  });

  const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weight, 0) || 1;
  const overallScore = clampNumber(
    Math.round(
      criteria.reduce((sum, criterion) => sum + criterion.score * criterion.weight, 0) / totalWeight,
    ),
    0,
    100,
  );
  const verdict: 'accept' | 'revise' | 'blocked' = criteria.every((criterion) => criterion.passed)
    ? 'accept'
    : directive?.status === 'blocked' || task.verdict.status === 'blocked'
      ? 'blocked'
      : 'revise';

  return {
    rubricFamily: inferVerificationRubricFamily(verification, task.contract.primaryTask),
    overallScore,
    verdict,
    criteria,
    trend: directive?.status === 'accept' ? 'improving' : directive?.status === 'revise' ? 'flat' : 'regressing',
    summary: directive?.reason ?? task.verdict.summary,
  };
}
