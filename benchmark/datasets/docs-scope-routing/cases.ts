/**
 * Docs-Scope Routing — dataset for FEATURE_112 (v0.7.34) docs-only coverage.
 *
 * Why a separate dataset rather than extending read-scope-routing:
 *   read-scope-routing was already shipped (Stage 1 + iteration rounds 1/2)
 *   with a stable shape test and 4-task surface. Adding docs cases would
 *   force changes to those shape assertions and re-anchor the historical
 *   eval baseline. A small, focused docs-only dataset keeps the existing
 *   read-only baseline untouched and isolates the docs-side question.
 *
 * Routing logic under test:
 *   `deriveTopologyCeiling` (packages/coding/src/reasoning.ts) merges
 *   `docs-only` and `read-only` into the same branch — H0 by default,
 *   H1 only when complexity ≥ complex OR explicit-check assurance fires.
 *   The 2 cases below probe the two corners of that branch.
 *
 * Variants reused verbatim from read-scope-routing — `current_v0733`
 * (FEATURE_112 baseline) and `feature_112_anchor` (the variant that
 * shipped to production in role-prompt.ts). We do not retest `feature_112`
 * or `feature_112_compact` — round 1+2 already determined anchor as the
 * production choice; this eval only verifies anchor's docs-only behavior.
 */

import type { KodaXMessage } from '@kodax/ai';

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';
import {
  CURRENT_V0733_VARIANT_SYSTEM_PROMPT,
  FEATURE_112_ANCHOR_VARIANT_SYSTEM_PROMPT,
  buildJudges as buildHarnessJudges,
  type HarnessId,
} from '../read-scope-routing/cases.js';

export type DocsTaskClass = 'docs-shallow' | 'docs-deep';
export type DocsTaskId = 'docs-shallow-fix' | 'docs-deep-consistency';

export interface DocsScopeTaskCase {
  readonly id: DocsTaskId;
  readonly taskClass: DocsTaskClass;
  readonly expectedHarness: HarnessId;
  readonly description: string;
  readonly userMessage: string;
}

export const DOCS_SCOPE_TASKS: readonly DocsScopeTaskCase[] = Object.freeze([
  {
    id: 'docs-shallow-fix',
    taskClass: 'docs-shallow',
    expectedHarness: 'H0_DIRECT',
    description:
      'Single-doc typo fix — should stay H0 (docs-only regression guard)',
    userMessage:
      'There is a typo in docs/PRD.md — the word "implmenetation" near the top of the '
      + 'document should be "implementation". Please fix just that one word, no other '
      + 'changes. This is a tiny one-line edit; please do not over-investigate.',
  },
  {
    id: 'docs-deep-consistency',
    taskClass: 'docs-deep',
    expectedHarness: 'H1_EXECUTE_EVAL',
    description:
      'Multi-doc consistency audit + rewrite plan — should escalate to H1 for evaluator audit',
    userMessage:
      'I noticed our documentation is inconsistent on how it describes the AMA harness '
      + 'profiles (H0_DIRECT / H1_EXECUTE_EVAL / H2_PLAN_EXECUTE_EVAL). Please audit '
      + 'docs/PRD.md, docs/ADR.md, docs/HLD.md, docs/DD.md, docs/FEATURE_LIST.md, and '
      + 'the per-version files in docs/features/ (v0.7.16 onwards) to find every place '
      + 'that defines or references the harness profiles. Then produce a consolidated '
      + 'rewrite plan that makes all of them use the same canonical definitions. The '
      + 'plan needs to be thorough enough — citing exact files and lines — that a '
      + 'contributor can execute it without re-doing the audit work.',
  },
]);

// ---------------------------------------------------------------------------
// Variant pivot — reuse the production anchor + baseline from read-scope-routing
// ---------------------------------------------------------------------------

export type DocsVariantId = 'current_v0733' | 'feature_112_anchor';

const VARIANT_PROMPTS: Readonly<Record<DocsVariantId, string>> = Object.freeze({
  current_v0733: CURRENT_V0733_VARIANT_SYSTEM_PROMPT,
  feature_112_anchor: FEATURE_112_ANCHOR_VARIANT_SYSTEM_PROMPT,
});

export function buildPromptVariants(
  task: DocsScopeTaskCase,
  variantIds: readonly DocsVariantId[],
  priorMessages?: readonly KodaXMessage[],
): readonly PromptVariant[] {
  return variantIds.map((variantId): PromptVariant => ({
    id: variantId,
    description: `${variantId} prompt × task=${task.id}`,
    systemPrompt: VARIANT_PROMPTS[variantId],
    userMessage: task.userMessage,
    priorMessages,
  }));
}

export function buildJudges(expected: HarnessId): readonly PromptJudge[] {
  return buildHarnessJudges(expected);
}

export type { HarnessId };
