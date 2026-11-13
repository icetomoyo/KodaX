/**
 * Frozen experiment contract for FEATURE_308 Phase 0 (baseline of the CURRENT
 * memory system). Every number below carries its derivation; the runner refuses
 * to start if a pinned hash or the frozen revision no longer matches.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { ModelAlias } from '../../harness/aliases.js';
import { FEATURE_308_READ_CASES, FEATURE_308_WRITE_CASES } from './cases.js';

/** r2 = r1 cases c1-c5 + c6/c7 (40-note store) + c8 (edit observable); write cases unchanged. */
export const FEATURE_308_REVISION = 'f306-phase0-r2' as const;
export const FEATURE_308_READ_CASES_SHA256 =
  'eed9d0a949c952297a381e9d751b4e98f59f2152c0a77c374608c3d35a4751f3' as const;
export const FEATURE_308_WRITE_CASES_SHA256 =
  '1f8d221bbfc808b11cc76aaa748bc16e571b8f772991bbec87b7509b9af2729c' as const;
export const FEATURE_308_ALIASES: readonly ModelAlias[] =
  Object.freeze(['ark/v4flash', 'zhipu/glm52']);
// Raw dumps keep the pre-renumber `feature-306` directory so recorded runs stay together.
export const FEATURE_308_RAW_ROOT = path.join(
  os.tmpdir(),
  'kodax-eval-dumps',
  'feature-306',
  FEATURE_308_REVISION,
);

/** Read cells run arms A and B; each write case runs the single production reviewer. */
const CALLS_PER_ALIAS_REPETITION =
  FEATURE_308_READ_CASES.length * 2 + FEATURE_308_WRITE_CASES.length;

const REPETITIONS = 2;

export const FEATURE_308_BUDGET = {
  /** Pilot is 1-2 samples per arm (plan 5.4); 2 gives a first same-cell noise read. */
  repetitions: REPETITIONS,
  /** (8 read cases x 2 arms + 4 write cases) x 2 aliases x 2 repetitions = 80. */
  plannedCalls: CALLS_PER_ALIAS_REPETITION * FEATURE_308_ALIASES.length * REPETITIONS,
  /** Planned 80 plus ~35% headroom for authorized infrastructure reruns. */
  maxProviderCalls: 108,
  /** No blind retry: a cell that already has a ledger entry is never called again. */
  maxCallsPerCell: 1,
  /** One model call per cell; tool calls are recorded, never executed. */
  maxRoundsPerCell: 1,
  /** EVAL_GUIDELINES floor; reasoning models spend output tokens on thinking. */
  maxOutputTokensPerCall: 8192,
  /**
   * Derived by `deriveTokenBudget` in runner.ts from the `prepare` estimate:
   * 1.25 x (sum of estimated input tokens + plannedCalls x 4096 expected output),
   * rounded up to 50k. r2 estimate: 640k input + 328k output over 80 cells =
   * 968k x 1.25 = 1.21M, rounded to 1.25M. A changed production prompt can push the
   * estimate above this; the runner test then fails, forcing a new revision.
   */
  maxTotalTokens: 1_250_000,
  /** Lead-specified. The catalog rates for both aliases are coding-plan figures
   *  (<= $0.1 per 1M), so the token cap binds long before this does. */
  maxExternalSpendUsd: 8,
  timeoutMs: 120_000,
} as const;

/** The lead must pass this exact string to `run`, which forces reading the frozen numbers. */
export const FEATURE_308_BUDGET_CONFIRMATION =
  `${FEATURE_308_REVISION}:calls=${FEATURE_308_BUDGET.maxProviderCalls}:tokens=${FEATURE_308_BUDGET.maxTotalTokens}:usd=${FEATURE_308_BUDGET.maxExternalSpendUsd}` as const;

export function buildFeature308ExperimentContract(): object {
  assertHash('read cases', FEATURE_308_READ_CASES, FEATURE_308_READ_CASES_SHA256);
  assertHash('write cases', FEATURE_308_WRITE_CASES, FEATURE_308_WRITE_CASES_SHA256);
  return {
    schemaVersion: 1,
    featureId: 306,
    phase: 0,
    revision: FEATURE_308_REVISION,
    question: 'How does the CURRENT KodaX memory behave: read-side lift/harm (arm A no memory vs arm B current memory) and write-side yield of the production reviewer.',
    arms: {
      A: 'production ordinary-root Worker prompt and tools without memory-rules, project-memory hints, memory_recall, memory_intent',
      B: 'the same bytes plus current memory built from a really seeded memdir store (memory-rules block, hint section, memory tools)',
      reviewer: 'production learning reviewer prompt, tool schema and sanitized input on a fixed episode digest',
    },
    caseHashes: {
      read: FEATURE_308_READ_CASES_SHA256,
      write: FEATURE_308_WRITE_CASES_SHA256,
    },
    caseIds: {
      read: FEATURE_308_READ_CASES.map((item) => item.id),
      write: FEATURE_308_WRITE_CASES.map((item) => item.id),
    },
    aliases: FEATURE_308_ALIASES,
    budget: FEATURE_308_BUDGET,
    budgetConfirmation: FEATURE_308_BUDGET_CONFIRMATION,
    concurrency: 'cells run sequentially: one in-flight request in total, hence one per provider',
    noRetry: 'a cell with a ledger entry is never called again, including failed or timed-out cells',
    rawOutputRoot: FEATURE_308_RAW_ROOT,
    reviewPolicy: 'main session reviews blinded Arm X/Arm Y packs; mechanical scores are diagnostics only',
    evaluationScope: 'next assistant action only (tools not executed); no final-task-result claim',
  };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function assertHash(label: string, value: unknown, expected: string): void {
  if (hash(value) !== expected) {
    throw new Error(`${label} hash changed; bump the experiment revision and pin the new hash.`);
  }
}
