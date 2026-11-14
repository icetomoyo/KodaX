/**
 * Frozen experiment contract for the FEATURE_308 note-line A/B (reflection prompt
 * and memory_reflect description). Every number carries its derivation; the runner
 * refuses to start if a pinned hash or the confirmation string no longer matches.
 */
import os from 'node:os';
import path from 'node:path';

import type { ModelAlias } from '../../harness/aliases.js';
import { hashOf } from '../feature-308-reflect/experiment-contract.js';
import { NOTELINE_CASES } from './cases.js';
import { ARMS } from './inputs.js';

/**
 * r1: pilot only. Arm B's absence sentence ("an error message is weak evidence")
 * left the misread "node is not installed" in all four pilot cells, so r2 says
 * what a not-found error does show. Arms, cases and budget are unchanged.
 * r2: full run. B fixed the misread but wrote the held-out "use python3" lesson in
 * 1 of 6 pairs against A's 4, so r3 says that a tool found under another name or
 * path is the note. h-python3 shaped that wording, so r3 adds two fresh held-out
 * cases (h-compose-v2, h-npx-tsc) and pilots the cases the change touches.
 * r4: regression check for a later change. Arm A is the text shipped after r3; arm B
 * adds when a candidate holds (the holistic run confirmed candidates on a repeated
 * situation). The pilot covers the cases with notes in the store plus two lessons.
 */
export const NOTELINE_REVISION = 'f308-notelines-r4' as const;
export const NOTELINE_CASES_SHA256 = 'ae18665539611b5eb159422d40f36e54b5446a40c658a70f920bdfba3ebab085' as const;
/** Hash of every arm-A input. Arm A's two texts equal the production texts shipped after r3. */
export const NOTELINE_ARM_A_SHA256 = 'e5dd091cc3dcb9037dae64217d6fd8256dd8ab3c327bc8e3059939feee58bdd5' as const;
export const NOTELINE_ALIASES: readonly ModelAlias[] = Object.freeze(['ark/v4flash', 'zhipu/glm52', 'ark/k27']);
export const NOTELINE_RAW_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-308', NOTELINE_REVISION);

/** Pilot: the cases the change touches, two aliases, one repetition, both arms. */
export const PILOT_CASE_IDS: readonly string[] = Object.freeze(['r9', 'r7', 'm-node-not-installed', 'h-python3']);
export const PILOT_ALIASES: readonly ModelAlias[] = Object.freeze(['ark/v4flash', 'zhipu/glm52']);

const REPETITIONS = 2;
const PILOT_CALLS = PILOT_CASE_IDS.length * PILOT_ALIASES.length * ARMS.length;
const FULL_CALLS = NOTELINE_CASES.length * NOTELINE_ALIASES.length * ARMS.length * REPETITIONS;

export const NOTELINE_BUDGET = {
  repetitions: REPETITIONS,
  /** 4 cases x 2 aliases x 2 arms. */
  pilotCalls: PILOT_CALLS,
  /** 27 cases x 3 aliases x 2 arms x 2 repetitions. */
  fullCalls: FULL_CALLS,
  /** Pilot 16 plus full 324, plus 20% headroom for authorized infrastructure reruns. */
  maxProviderCalls: 410,
  /** No blind retry: a cell that already has a ledger entry is never called again. */
  maxCallsPerCell: 1,
  /** EVAL_GUIDELINES floor; reasoning models spend output tokens on thinking. */
  maxOutputTokensPerCall: 8192,
  /** r2's 3.2M scaled by 340/316 calls; r2 spent 684k, so the cap is far above use and only bounds the output reservation. */
  maxTotalTokens: 3_500_000,
  /** prepare prices the worst case (every call at the output cap) at $0.13; the cap leaves room for pricing-table gaps. */
  maxExternalSpendUsd: 3,
  timeoutMs: 120_000,
} as const;

export const NOTELINE_BUDGET_CONFIRMATION =
  `${NOTELINE_REVISION}:calls=${NOTELINE_BUDGET.maxProviderCalls}:tokens=${NOTELINE_BUDGET.maxTotalTokens}:usd=${NOTELINE_BUDGET.maxExternalSpendUsd}` as const;

export function assertCasesPinned(): void {
  const actual = hashOf(NOTELINE_CASES);
  if (actual !== NOTELINE_CASES_SHA256) {
    throw new Error(`note-line cases hash changed (${actual}); bump the experiment revision and pin the new hash.`);
  }
}

export function buildNoteLineExperimentContract(): object {
  assertCasesPinned();
  return {
    schemaVersion: 1,
    featureId: 308,
    revision: NOTELINE_REVISION,
    question: 'Does the revised reflection guidance make new index lines say what to do, keep the way that worked rather than the failure, and leave one-off workarounds and unconfirmed absence claims out, without losing the notes the current prompt already writes well?',
    arms: { A: 'frozen pre-change reflection prompt and memory_reflect description', B: 'production after the change' },
    caseHash: NOTELINE_CASES_SHA256,
    armAInputHash: NOTELINE_ARM_A_SHA256,
    caseIds: NOTELINE_CASES.map((item) => item.id),
    aliases: NOTELINE_ALIASES,
    pilot: { caseIds: PILOT_CASE_IDS, aliases: PILOT_ALIASES, repetitions: 1 },
    budget: NOTELINE_BUDGET,
    budgetConfirmation: NOTELINE_BUDGET_CONFIRMATION,
    concurrency: 'one in-flight request per alias; aliases run in parallel',
    noRetry: 'a cell with a ledger entry is never called again, including failed or timed-out cells',
    rawOutputRoot: NOTELINE_RAW_ROOT,
    reviewPolicy: 'main session reads a blinded pack (X/Y per case and alias, order shuffled with a fixed seed) and writes its judgement before opening the unblind map; mechanical scores are diagnostics only',
    decisionRule: 'recommend-ship when B is better or equal on the index-line and failure-handling cases and no reflect regression case gets worse; iterate when B helps but regresses a case; revert when B is not better',
    evaluationScope: 'one response per case; memory_reflect and skill_propose calls are recorded, never executed, and replayed through the real operation in a throwaway store',
  };
}
