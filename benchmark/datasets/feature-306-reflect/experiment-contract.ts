/**
 * Frozen experiment contract for FEATURE_306 Phase 2b (the reflection job).
 * Every number below carries its derivation; the runner refuses to start if the
 * pinned case hash or the confirmation string no longer matches.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { ModelAlias } from '../../harness/aliases.js';
import { FEATURE_306_REFLECT_CASES } from './cases.js';

export const REFLECT_REVISION = 'f306-phase4d-r3' as const;
export const REFLECT_CASES_SHA256 = 'f97dacb58e2776b5ace44605f7389a519044265a663e4749174fe2da604fde65' as const;
export const REFLECT_ALIASES: readonly ModelAlias[] = Object.freeze(['ark/v4flash', 'zhipu/glm52', 'ark/k27']);
export const REFLECT_RAW_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-306', REFLECT_REVISION);

const REPETITIONS = 2;

export const REFLECT_BUDGET = {
  repetitions: REPETITIONS,
  /** 13 cases x 3 aliases x 2 repetitions. */
  plannedCalls: FEATURE_306_REFLECT_CASES.length * REFLECT_ALIASES.length * REPETITIONS,
  /** Planned 78 plus 20% headroom for authorized infrastructure reruns. */
  maxProviderCalls: 94,
  /** No blind retry: a cell that already has a ledger entry is never called again. */
  maxCallsPerCell: 1,
  /** One model call per cell; a real job loops, but all changes in this probe fit one response. */
  maxRoundsPerCell: 1,
  /** EVAL_GUIDELINES floor; reasoning models spend output tokens on thinking. */
  maxOutputTokensPerCall: 8192,
  /** `deriveTokenBudget` gives 650k (190k estimated input + 78 x 4096 expected output, x1.25); the rest covers the pre-request output reservation. */
  maxTotalTokens: 780_000,
  maxExternalSpendUsd: 4,
  timeoutMs: 120_000,
} as const;

export const REFLECT_BUDGET_CONFIRMATION =
  `${REFLECT_REVISION}:calls=${REFLECT_BUDGET.maxProviderCalls}:tokens=${REFLECT_BUDGET.maxTotalTokens}:usd=${REFLECT_BUDGET.maxExternalSpendUsd}` as const;

export function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function buildReflectExperimentContract(): object {
  const actual = hashOf(FEATURE_306_REFLECT_CASES);
  if (actual !== REFLECT_CASES_SHA256) {
    throw new Error(`reflect cases hash changed (${actual}); bump the experiment revision and pin the new hash.`);
  }
  return {
    schemaVersion: 1,
    featureId: 306,
    phase: '4d',
    revision: REFLECT_REVISION,
    question: 'Given a finished session and the current notes, does the reflection prompt write what the next session needs, leave correct notes alone, propose a skill only for a hard confirmed procedure, and refuse secrets and injected instructions?',
    caseHash: REFLECT_CASES_SHA256,
    caseIds: FEATURE_306_REFLECT_CASES.map((item) => item.id),
    aliases: REFLECT_ALIASES,
    budget: REFLECT_BUDGET,
    budgetConfirmation: REFLECT_BUDGET_CONFIRMATION,
    concurrency: 'one in-flight request per alias; aliases run in parallel',
    noRetry: 'a cell with a ledger entry is never called again, including failed or timed-out cells',
    rawOutputRoot: REFLECT_RAW_ROOT,
    reviewPolicy: 'main session reads the pack (transcript, notes before and after, calls, replay trace); mechanical scores are diagnostics only',
    evaluationScope: 'one response per case; memory_reflect and skill_propose calls are recorded, never executed, and replayed through the real operation in a throwaway store; a real job may loop over several rounds',
  };
}
