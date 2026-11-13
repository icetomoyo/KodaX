/**
 * Frozen experiment contract for FEATURE_306 Phase 1b (the NEW note memory).
 * Every number below carries its derivation; the runner refuses to start if a
 * pinned hash or the frozen revision no longer matches.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { ModelAlias } from '../../harness/aliases.js';
import { FEATURE_306_READ_CASES } from '../feature-306-baseline/cases.js';
import {
  FEATURE_306_RAW_ROOT as PHASE0_RAW_ROOT,
  FEATURE_306_READ_CASES_SHA256,
} from '../feature-306-baseline/experiment-contract.js';
import { FEATURE_306_PROBE_CASES } from './cases.js';

export const NOTES_REVISION = 'f306-phase1b-r2' as const;
export const NOTES_PROBE_CASES_SHA256 =
  'a50851b7768bc96c67b3bcfcc3c9276d4f1edc473b6d45c32b29d16e3889e7d7' as const;
/** Arm N runs on all three; Phase 0 arms A/B already exist for the first two (r2 raw dumps). */
export const NOTES_ALIASES: readonly ModelAlias[] =
  Object.freeze(['ark/v4flash', 'zhipu/glm52', 'ark/k27']);
/** Phase 0 never ran these; they get fresh A and B cells so every alias has all three arms. */
export const NEW_BASELINE_ALIASES: readonly ModelAlias[] = Object.freeze(['ark/k27']);
export const PHASE0_BASELINE_ALIASES: readonly ModelAlias[] = Object.freeze(['ark/v4flash', 'zhipu/glm52']);
export const PHASE0_ROOT = PHASE0_RAW_ROOT;
export const NOTES_RAW_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-306', NOTES_REVISION);

const REPETITIONS = 2;
const READ_CASES = FEATURE_306_READ_CASES.length;
const PROBES = FEATURE_306_PROBE_CASES.length;

export const NOTES_BUDGET = {
  repetitions: REPETITIONS,
  /** Arm N: (8 read + 8 probe) x 3 aliases x 2 reps = 96; k27 arms A and B: 8 x 2 x 2 = 32. */
  plannedCalls: (READ_CASES + PROBES) * NOTES_ALIASES.length * REPETITIONS
    + READ_CASES * 2 * NEW_BASELINE_ALIASES.length * REPETITIONS,
  /** Planned 128 plus ~17% headroom for authorized infrastructure reruns. */
  maxProviderCalls: 150,
  /** No blind retry: a cell that already has a ledger entry is never called again. */
  maxCallsPerCell: 1,
  /** One model call per cell; tool calls are recorded, never executed. */
  maxRoundsPerCell: 1,
  /** EVAL_GUIDELINES floor; reasoning models spend output tokens on thinking. */
  maxOutputTokensPerCall: 8192,
  /** Derived by `deriveTokenBudget`: 1.25 x (1.30M estimated input + 128 x 4096 expected output) = 2.29M, rounded up to 50k. */
  maxTotalTokens: 2_300_000,
  /** The catalog rates are coding-plan figures, so the token cap binds long before this does. */
  maxExternalSpendUsd: 8,
  timeoutMs: 120_000,
} as const;

export const NOTES_BUDGET_CONFIRMATION =
  `${NOTES_REVISION}:calls=${NOTES_BUDGET.maxProviderCalls}:tokens=${NOTES_BUDGET.maxTotalTokens}:usd=${NOTES_BUDGET.maxExternalSpendUsd}` as const;

export function buildNotesExperimentContract(): object {
  assertHash('read cases', FEATURE_306_READ_CASES, FEATURE_306_READ_CASES_SHA256);
  assertHash('probe cases', FEATURE_306_PROBE_CASES, NOTES_PROBE_CASES_SHA256);
  return {
    schemaVersion: 1,
    featureId: 306,
    phase: '1b',
    revision: NOTES_REVISION,
    question: 'Does the new note memory (index in the prompt + one `memory` tool with exact-quote authorization) help, harm or stay silent compared with no memory (A) and the old memory (B)?',
    arms: {
      A: 'Phase 0: production ordinary-root Worker prompt and tools without any memory',
      B: 'Phase 0: the same plus the old memdir memory (rules, hints, memory_recall, memory_intent)',
      N: 'the same plus the new note memory: KODAX_MEMORY_NOTES=1 section (rules + MEMORY.md indexes) and the `memory` tool',
    },
    caseHashes: { read: FEATURE_306_READ_CASES_SHA256, probes: NOTES_PROBE_CASES_SHA256 },
    caseIds: { read: FEATURE_306_READ_CASES.map((item) => item.id), probes: FEATURE_306_PROBE_CASES.map((item) => item.id) },
    aliases: NOTES_ALIASES,
    phase0BaselineAliases: PHASE0_BASELINE_ALIASES,
    budget: NOTES_BUDGET,
    budgetConfirmation: NOTES_BUDGET_CONFIRMATION,
    concurrency: 'one in-flight request per alias; aliases run in parallel (ark lanes are separate models)',
    noRetry: 'a cell with a ledger entry is never called again, including failed or timed-out cells',
    rawOutputRoot: NOTES_RAW_ROOT,
    phase0RawRoot: PHASE0_ROOT,
    reviewPolicy: 'main session reviews blinded X/Y/Z packs (A none / B old / N new); mechanical scores are diagnostics only',
    evaluationScope: 'next assistant action only (tools not executed); memory calls are replayed through the real operation in a throwaway store; no final-task-result claim',
  };
}

export function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function assertHash(label: string, value: unknown, expected: string): void {
  if (hashOf(value) !== expected) {
    throw new Error(`${label} hash changed; bump the experiment revision and pin the new hash.`);
  }
}
