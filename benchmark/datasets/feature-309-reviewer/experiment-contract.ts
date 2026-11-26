/**
 * Frozen experiment contract for the FEATURE_309 episode-reviewer A/B: the old
 * prompt and tool that also asked for a Skill decision (arm A) against the
 * Memory-only reviewer in production (arm B). The runner refuses to start if a
 * pinned hash or the budget confirmation no longer matches.
 */
import os from 'node:os';
import path from 'node:path';

import type { ModelAlias } from '../../harness/aliases.js';
import { hashOf } from '../feature-308-reflect/experiment-contract.js';
import { FEATURE_309_REVIEWER_CASES } from './cases.js';

export const REVIEWER_REVISION = 'f309-reviewer-r2' as const;
export const REVIEWER_CASES_SHA256 = '45d8737594b2fa1affd55dffd29c2399c222c9deaaab66e2b7adb65bbde2783e' as const;
/** Hash of arm-a.json, the reviewer prompt and tool shipped before FEATURE_309. */
export const REVIEWER_ARM_A_SHA256 = 'ec2b3180b9dab20fbf79e6098025c25f265c8b2da4c281c75ddcf302a6c2d072' as const;
/**
 * r1 piloted kimi and zhipu/glm53flash. kimi-for-coding always thinks and its adapter drops the forced
 * tool choice, so in 5 of 8 cells it wrote the review as text in both arms; r2 uses ds/flash instead.
 */
export const REVIEWER_ALIASES: readonly ModelAlias[] = Object.freeze(['zhipu/glm53flash', 'ds/flash']);
export const REVIEWER_RAW_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-309', REVIEWER_REVISION);

/** Pilot: the two method cases plus one save and one save-nothing case. */
export const PILOT_CASE_IDS: readonly string[] = Object.freeze(['m1', 'm2', 'w1', 'w3']);

const ARM_COUNT = 2;
const REPETITIONS = 2;
const PILOT_CALLS = PILOT_CASE_IDS.length * REVIEWER_ALIASES.length * ARM_COUNT;
const FULL_CALLS = FEATURE_309_REVIEWER_CASES.length * REVIEWER_ALIASES.length * ARM_COUNT * REPETITIONS;

export const REVIEWER_BUDGET = {
  repetitions: REPETITIONS,
  /** 4 cases x 2 aliases x 2 arms. */
  pilotCalls: PILOT_CALLS,
  /** 6 cases x 2 aliases x 2 arms x 2 repetitions. */
  fullCalls: FULL_CALLS,
  /** Pilot 16 plus full 48, plus 25% headroom for authorized infrastructure reruns. */
  maxProviderCalls: 80,
  /** No blind retry: a cell that already has a ledger entry is never called again. */
  maxCallsPerCell: 1,
  /** EVAL_GUIDELINES floor; production caps the reviewer at 1,200, which the floor covers. */
  maxOutputTokensPerCall: 8192,
  /** 80 calls x (about 3k input + 8,192 reserved output) is 0.9M; the cap bounds the reservation. */
  maxTotalTokens: 1_000_000,
  /** Both aliases price under $0.6 per million output tokens; worst case is well under $1. */
  maxExternalSpendUsd: 2,
  timeoutMs: 120_000,
} as const;

export const REVIEWER_BUDGET_CONFIRMATION =
  `${REVIEWER_REVISION}:calls=${REVIEWER_BUDGET.maxProviderCalls}:tokens=${REVIEWER_BUDGET.maxTotalTokens}:usd=${REVIEWER_BUDGET.maxExternalSpendUsd}` as const;

export function assertCasesPinned(): void {
  const actual = hashOf(FEATURE_309_REVIEWER_CASES);
  if (actual !== REVIEWER_CASES_SHA256) {
    throw new Error(`reviewer cases hash changed (${actual}); bump the experiment revision and pin the new hash.`);
  }
}

export function buildReviewerExperimentContract(): object {
  assertCasesPinned();
  return {
    schemaVersion: 1,
    featureId: 309,
    revision: REVIEWER_REVISION,
    question: 'With the Skill decision removed from the episode reviewer, does the reviewer still keep a reusable verified method, or a procedure the user asked to keep, as Memory, without saving more one-offs, derivable facts, secrets or injected instructions than the old reviewer?',
    arms: { A: 'frozen pre-FEATURE_309 reviewer prompt and tool, with the old input fields', B: 'production Memory-only reviewer' },
    caseHash: REVIEWER_CASES_SHA256,
    armAHash: REVIEWER_ARM_A_SHA256,
    caseIds: FEATURE_309_REVIEWER_CASES.map((item) => item.id),
    aliases: REVIEWER_ALIASES,
    pilot: { caseIds: PILOT_CASE_IDS, aliases: REVIEWER_ALIASES, repetitions: 1 },
    budget: REVIEWER_BUDGET,
    budgetConfirmation: REVIEWER_BUDGET_CONFIRMATION,
    concurrency: 'one in-flight request per alias; aliases run in parallel',
    noRetry: 'a cell with a ledger entry is never called again, including failed or timed-out cells',
    rawOutputRoot: REVIEWER_RAW_ROOT,
    reviewPolicy: 'main session reads a blinded pack of Memory actions only (X/Y per case, alias and repetition, side chosen by a seeded hash) and writes its judgement before opening the unblind map; the Skill decisions of arm A and the mechanical scores are diagnostics read afterwards',
    decisionRule: 'recommend-ship when B keeps the method as Memory on m1 and m2 about as often as A kept it as Memory or Skill, and B is not worse on w1 to w4; iterate when B drops methods the old reviewer kept; revert when B is worse on the save-nothing or secret cases',
    evaluationScope: 'one forced reviewer call per cell; the output is replayed through the production normalizer and governed apply in a throwaway store',
  };
}
