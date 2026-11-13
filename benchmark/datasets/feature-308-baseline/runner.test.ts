import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';

const runOneShotMock = vi.hoisted(() => vi.fn());

vi.mock('../../harness/harness.js', () => ({ runOneShot: runOneShotMock }));

import { FEATURE_308_WRITE_CASES } from './cases.js';
import {
  FEATURE_308_BUDGET,
  FEATURE_308_BUDGET_CONFIRMATION,
} from './experiment-contract.js';
import {
  assertLedgerAllows,
  deriveTokenBudget,
  ledgerState,
  pack,
  plannedCells,
  prepare,
  prepareCells,
  processWriteCell,
  readLedger,
  run,
  xArmFor,
  type LedgerEntry,
  type LedgerState,
  type PreparedCell,
} from './runner.js';

const TIMEOUT = 180_000;
const KEY_ENVS = [...new Set(['ark/v4flash', 'zhipu/glm52'].map((alias) => MODEL_ALIASES[alias as ModelAlias].apiKeyEnv))];

async function listFiles(root: string, dir = root): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(root, full) : [path.relative(root, full)];
  }));
  return nested.flat().sort();
}

async function readTree(root: string): Promise<Readonly<Record<string, string>>> {
  const files = await listFiles(root);
  const contents = await Promise.all(files.map((file) => readFile(path.join(root, file), 'utf8')));
  return Object.fromEntries(files.map((file, index) => [file, contents[index]!]));
}

const REVIEW_ACTION = {
  action: 'write_memdir',
  targetRefIds: [],
  summary: 'Tests run with make check-fast.',
  rationale: 'User corrected the test command.',
  confidence: 'high',
  risk: 'low',
  requiresApproval: true,
  proposedBody: 'Run `make check-fast`; bare npm test skips the integration setup.',
  claimKind: 'preference',
  claimKey: 'test-command',
};

function fakeResponse(input: { readonly userMessage: string; readonly forcedToolName?: string }): unknown {
  if (input.forcedToolName !== undefined) {
    const isW1 = input.userMessage.includes('make check-fast');
    return {
      text: '',
      toolCalls: [{
        name: input.forcedToolName,
        input: {
          memoryPlan: { actions: isW1 ? [REVIEW_ACTION] : [], warnings: [] },
          capabilityDecision: { disposition: 'discard', reasonCodes: ['no_reusable_learning'] },
        },
      }],
    };
  }
  return { text: '', toolCalls: [{ name: 'bash', input: { command: 'make check-fast' } }] };
}

describe('FEATURE_308 runner', () => {
  const roots: string[] = [];
  const previousKeys = new Map<string, string | undefined>();

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-f306-runner-'));
    roots.push(root);
    return root;
  }

  beforeEach(() => {
    for (const name of KEY_ENVS) {
      previousKeys.set(name, process.env[name]);
      process.env[name] = 'fake-key-for-unit-test';
    }
    runOneShotMock.mockImplementation(async (alias: ModelAlias, input: { userMessage: string; forcedToolName?: string }) => ({
      alias,
      target: MODEL_ALIASES[alias],
      ...(fakeResponse(input) as object),
      usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
      durationMs: 1,
    }));
  });

  afterEach(async () => {
    for (const [name, value] of previousKeys) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    runOneShotMock.mockReset();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  describe('prepare', () => {
    it('makes zero provider calls, is byte-deterministic, and stays inside the frozen token cap', async () => {
      const first = await tempRoot();
      const second = await tempRoot();
      const summary = await prepare(first);
      await prepare(second);

      expect(runOneShotMock).not.toHaveBeenCalled();
      expect(await readTree(first)).toEqual(await readTree(second));
      expect(summary.cells).toBe(FEATURE_308_BUDGET.plannedCalls);
      // If production prompt bytes drift enough to need more tokens, bump the revision and the cap.
      expect(summary.frozenCoversDerived).toBe(true);
      // c6/c7 are the 40-note scale cases: the current ranking does not surface the decisive note (r2 observation).
      expect(summary.layer1.every((item) => item.surfaced && item.decisiveDetailInHook === !(['c6', 'c7'].includes(item.caseId)))).toBe(true);
    }, TIMEOUT);

    it('writes a blinded skeleton: no arm labels, a persisted unblind map covering both orders', async () => {
      const root = await tempRoot();
      await prepare(root);
      const dir = path.join(root, 'main-session-review');
      const skeleton = await readFile(path.join(dir, 'evidence-skeleton.json'), 'utf8');
      const map = JSON.parse(await readFile(path.join(dir, 'unblind-map.json'), 'utf8')) as Record<string, { X: string; Y: string }>;

      expect(skeleton).not.toContain('"arm"');
      expect(skeleton).not.toMatch(/"(?:A|B)"/);
      expect(Object.keys(map)).toHaveLength(32);
      for (const entry of Object.values(map)) expect(new Set([entry.X, entry.Y])).toEqual(new Set(['A', 'B']));
      expect(new Set(Object.values(map).map((entry) => entry.X))).toEqual(new Set(['A', 'B']));
      for (const [id, entry] of Object.entries(map)) expect(entry.X).toBe(xArmFor(id));
    }, TIMEOUT);

    it('builds identical inputs across aliases and repetitions for the same case and arm', async () => {
      const cells = await prepareCells();
      const c1b = cells.filter((cell) => cell.caseId === 'c1' && cell.arm === 'B');
      expect(c1b).toHaveLength(FEATURE_308_BUDGET.repetitions * 2);
      expect(new Set(c1b.map((cell) => cell.inputHash)).size).toBe(1);
      const armA = cells.find((cell) => cell.caseId === 'c1' && cell.arm === 'A')!;
      expect(armA.inputHash).not.toBe(c1b[0]!.inputHash);
    }, TIMEOUT);

    it('derives the token budget from the estimate', async () => {
      const cells = await prepareCells();
      const derived = deriveTokenBudget(cells);
      expect(derived.derivedMaxTotalTokens % 50_000).toBe(0);
      expect(derived.derivedMaxTotalTokens).toBeGreaterThanOrEqual(
        (derived.estimatedInputTokens + derived.expectedOutputTokens),
      );
    }, TIMEOUT);
  });

  describe('ledger', () => {
    const cell = { key: 'k', alias: 'ark/v4flash', estimatedInputTokens: 10_000 } as PreparedCell;
    const empty: LedgerState = { calls: 0, committedTokens: 0, committedUsd: 0, requestedCells: new Set() };

    it('allows a call that fits every cap', () => {
      expect(() => assertLedgerAllows(empty, cell)).not.toThrow();
    });

    it('refuses a call over the provider call cap', () => {
      expect(() => assertLedgerAllows({ ...empty, calls: FEATURE_308_BUDGET.maxProviderCalls }, cell))
        .toThrow('call cap');
    });

    it('refuses a second call for the same cell', () => {
      expect(() => assertLedgerAllows({ ...empty, requestedCells: new Set(['k']) }, cell)).toThrow('per-cell');
    });

    it('refuses a call whose worst case exceeds the token cap', () => {
      const nearCap = { ...empty, committedTokens: FEATURE_308_BUDGET.maxTotalTokens - 10_000 - 8191 };
      expect(() => assertLedgerAllows(nearCap, cell)).toThrow('token cap');
      expect(() => assertLedgerAllows({ ...nearCap, committedTokens: nearCap.committedTokens - 1 }, cell)).not.toThrow();
    });

    it('refuses a call that exceeds the spend cap', () => {
      expect(() => assertLedgerAllows({ ...empty, committedUsd: FEATURE_308_BUDGET.maxExternalSpendUsd }, cell))
        .toThrow('spend cap');
    });

    it('counts a requested-but-unfinished call at its worst case and a completed call at actual usage', () => {
      const entries: LedgerEntry[] = [
        { event: 'requested', cellKey: 'a', alias: 'ark/v4flash', estimatedInputTokens: 1000, reservedOutputTokens: 8192 },
        { event: 'completed', cellKey: 'a', alias: 'ark/v4flash', usage: { inputTokens: 900, outputTokens: 50, totalTokens: 950 }, estimatedCostUsd: 0 },
        { event: 'requested', cellKey: 'b', alias: 'ark/v4flash', estimatedInputTokens: 2000, reservedOutputTokens: 8192 },
        { event: 'failed', cellKey: 'b', alias: 'ark/v4flash', error: 'timeout' },
      ];
      const state = ledgerState(entries);
      expect(state.calls).toBe(2);
      expect(state.committedTokens).toBe(950 + 2000 + 8192);
      expect([...state.requestedCells]).toEqual(['a', 'b']);
    });
  });

  describe('run', () => {
    it('refuses without the exact budget confirmation, before any call', async () => {
      const root = await tempRoot();
      await expect(run({ confirmBudget: '', rawRoot: root })).rejects.toThrow('--confirm-budget');
      await expect(run({ confirmBudget: 'yes', rawRoot: root })).rejects.toThrow('--confirm-budget');
      expect(runOneShotMock).not.toHaveBeenCalled();
    });

    it('refuses when an API key is missing, before any call', async () => {
      const root = await tempRoot();
      delete process.env[KEY_ENVS[0]!];
      await expect(run({ confirmBudget: FEATURE_308_BUDGET_CONFIRMATION, rawRoot: root })).rejects.toThrow('missing API key');
      expect(runOneShotMock).not.toHaveBeenCalled();
    });

    it('runs every cell sequentially under the frozen caps, dumps raw tool calls, resumes, and packs blinded', async () => {
      const root = await tempRoot();
      let inFlight = 0;
      let maxInFlight = 0;
      const base = runOneShotMock.getMockImplementation()!;
      runOneShotMock.mockImplementation(async (...args: unknown[]) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try { return await base(...args); } finally { inFlight--; }
      });

      const summary = await run({ confirmBudget: FEATURE_308_BUDGET_CONFIRMATION, rawRoot: root });
      expect(summary).toMatchObject({ externalCallsThisRun: 80, completedCells: 80, plannedCells: 80, skippedAfterFailure: [] });
      expect(maxInFlight).toBe(1);
      expect(runOneShotMock.mock.calls.every(([, input]) => input.maxOutputTokens === FEATURE_308_BUDGET.maxOutputTokensPerCall)).toBe(true);
      const ledger = readLedger(root);
      expect(ledger.filter((entry) => entry.event === 'requested')).toHaveLength(80);
      expect(ledger.filter((entry) => entry.event === 'completed')).toHaveLength(80);

      const firstCell = plannedCells()[0]!;
      const raw = JSON.parse(await readFile(path.join(root, 'cells', firstCell.alias.replace('/', '_'), `${firstCell.key}.json`), 'utf8'));
      expect(raw.runsRaw[0].toolCalls[0]).toEqual({ name: 'bash', input: { command: 'make check-fast' } });
      expect(raw.mechanical.verdict).toBe('pass');

      runOneShotMock.mockClear();
      const resumed = await run({ confirmBudget: FEATURE_308_BUDGET_CONFIRMATION, rawRoot: root });
      expect(resumed.externalCallsThisRun).toBe(0);
      expect(runOneShotMock).not.toHaveBeenCalled();

      const packed = await pack(root);
      expect(packed).toEqual({ readPacks: 32, writeEntries: 16, missingCells: [] });
      const evidence = await readFile(path.join(root, 'main-session-review', 'evidence.json'), 'utf8');
      expect(evidence).not.toContain('"arm"');
      expect(evidence).not.toContain('mechanical');
      const writeSide = JSON.parse(await readFile(path.join(root, 'main-session-review', 'write-side.json'), 'utf8')) as {
        caseId: string;
        processing: { status: string; actions: unknown[] };
      }[];
      const w1 = writeSide.find((entry) => entry.caseId === 'w1')!;
      expect(w1.processing.status).toBe('normalized');
      expect(w1.processing.actions).toHaveLength(1);
      expect(writeSide.find((entry) => entry.caseId === 'w2')!.processing.actions).toHaveLength(0);
    }, TIMEOUT * 2);

    it('fails fast on a provider error, records it, and never retries that cell', async () => {
      const root = await tempRoot();
      const base = runOneShotMock.getMockImplementation()!;
      let count = 0;
      runOneShotMock.mockImplementation(async (...args: unknown[]) => {
        count++;
        if (count === 3) throw new Error('provider exploded');
        return base(...args);
      });

      await expect(run({ confirmBudget: FEATURE_308_BUDGET_CONFIRMATION, rawRoot: root })).rejects.toThrow('provider exploded');
      expect(runOneShotMock).toHaveBeenCalledTimes(3);
      const failedKey = plannedCells()[2]!.key;
      expect(readLedger(root).some((entry) => entry.event === 'failed' && entry.cellKey === failedKey)).toBe(true);

      runOneShotMock.mockReset();
      runOneShotMock.mockImplementation(base);
      const resumed = await run({ confirmBudget: FEATURE_308_BUDGET_CONFIRMATION, rawRoot: root });
      expect(resumed.skippedAfterFailure).toEqual([failedKey]);
      expect(resumed.externalCallsThisRun).toBe(77);
      expect(runOneShotMock.mock.calls.some(([, input]) => input === undefined)).toBe(false);
    }, TIMEOUT * 2);
  });

  describe('write-side offline processing', () => {
    const w1 = FEATURE_308_WRITE_CASES[0]!;

    it('reports a proposal that needs approval and nothing auto-applied for a plain preference', async () => {
      const processed = await processWriteCell(w1, {
        memoryPlan: { actions: [REVIEW_ACTION], warnings: [] },
        capabilityDecision: { disposition: 'discard', reasonCodes: ['no_reusable_learning'] },
      }, 'unit-w1');
      expect(processed.status).toBe('normalized');
      expect(processed.actions[0]).toMatchObject({ action: 'write_memdir', claimKey: 'test-command' });
      expect(processed.decisions.length).toBeGreaterThan(0);
      expect(processed.autoAppliedCount).toBeLessThanOrEqual(processed.proposalCount);
    }, TIMEOUT);

    it('marks a malformed plan as rejected and a missing call as no-review-call', async () => {
      const rejected = await processWriteCell(w1, { memoryPlan: { actions: 'nope' } }, 'unit-bad');
      expect(rejected.status).toBe('rejected');
      expect(rejected.error).toContain('invalid Memory plan');
      expect((await processWriteCell(w1, undefined)).status).toBe('no-review-call');
    }, TIMEOUT);
  });
});
