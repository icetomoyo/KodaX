/**
 * Self-test for the FEATURE_104 prompt-eval harness.
 *
 * This file lives outside `tests/*.eval.ts` because it tests the harness
 * itself (judges + alias resolution + comparison aggregation) and runs
 * with the default `npm test` (no LLM calls, fully deterministic).
 *
 * The actual provider call surface (`runOneShot`, `runABComparison`)
 * is exercised by real `*.eval.ts` files via `npm run test:eval`.
 */

import { describe, expect, it } from 'vitest';

import {
  availableAliases,
  ALL_MODEL_ALIASES,
  MODEL_ALIASES,
  resolveAlias,
  type ModelAlias,
} from './prompt-eval/aliases.js';
import {
  formatComparisonTable,
  speedScore,
  DEFAULT_BENCHMARK_RUNS,
  DEFAULT_SPEED_IDEAL_MS,
  DEFAULT_SPEED_CEILING_MS,
  DEFAULT_COMPOSITE_WEIGHTS,
  type ABComparisonResult,
  type BenchmarkResult,
  type BenchmarkCellSummary,
  type VariantOutcome,
} from './prompt-eval/harness.js';
import {
  lengthWithin,
  mustContainAll,
  mustContainAny,
  mustMatch,
  mustNotContain,
  mustNotMatch,
  parseAndAssert,
  runJudges,
  type PromptJudge,
} from './prompt-eval/judges.js';
import {
  renderBenchmarkReport,
  renderCompactSummary,
} from './prompt-eval/report.js';
import { readBenchmarkResult, writeBenchmarkReport } from './prompt-eval/persist.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// aliases.ts
// ---------------------------------------------------------------------------

describe('FEATURE_104 aliases', () => {
  it('exposes all 8 user-supplied coding-plan aliases', () => {
    expect([...ALL_MODEL_ALIASES].sort()).toEqual(
      [
        'ark/glm51',
        'ds/v4flash',
        'ds/v4pro',
        'kimi',
        'mimo/v25',
        'mimo/v25pro',
        'mmx/m27',
        'zhipu/glm51',
      ].sort(),
    );
  });

  it('every alias resolves to a frozen { provider, model, apiKeyEnv }', () => {
    for (const alias of ALL_MODEL_ALIASES) {
      const target = resolveAlias(alias);
      expect(target.provider).toBeTypeOf('string');
      expect(target.model).toBeTypeOf('string');
      expect(target.apiKeyEnv).toMatch(/_API_KEY$/);
    }
    expect(Object.isFrozen(MODEL_ALIASES)).toBe(true);
  });

  it('resolveAlias throws on unknown alias to surface typos at write time', () => {
    expect(() => resolveAlias('nonexistent/xx' as ModelAlias)).toThrow(/Unknown model alias/);
  });

  it('availableAliases() returns subset whose API key env var is set', () => {
    const before = process.env.ZHIPU_API_KEY;
    process.env.ZHIPU_API_KEY = 'test-key';
    try {
      const got = availableAliases('zhipu/glm51', 'kimi');
      expect(got).toContain('zhipu/glm51');
      // 'kimi' may or may not be set; assert at minimum zhipu is there.
    } finally {
      if (before === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = before;
    }
  });

  it('availableAliases() with no args defaults to all known aliases as candidates', () => {
    // Without setting env, this returns whatever is currently present.
    // Test that it's a subset of ALL_MODEL_ALIASES.
    const got = availableAliases();
    for (const alias of got) {
      expect(ALL_MODEL_ALIASES).toContain(alias);
    }
  });

  it('matches the user-supplied alias scheme verbatim', () => {
    expect(resolveAlias('zhipu/glm51')).toMatchObject({ provider: 'zhipu-coding', model: 'glm-5.1' });
    expect(resolveAlias('kimi')).toMatchObject({ provider: 'kimi-code', model: 'kimi-for-coding' });
    expect(resolveAlias('mimo/v25')).toMatchObject({ provider: 'mimo-coding', model: 'mimo-v2.5' });
    expect(resolveAlias('mimo/v25pro')).toMatchObject({ provider: 'mimo-coding', model: 'mimo-v2.5-pro' });
    expect(resolveAlias('mmx/m27')).toMatchObject({ provider: 'minimax-coding', model: 'MiniMax-M2.7' });
    expect(resolveAlias('ark/glm51')).toMatchObject({ provider: 'ark-coding', model: 'glm-5.1' });
    expect(resolveAlias('ds/v4pro')).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    expect(resolveAlias('ds/v4flash')).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash' });
  });
});

// ---------------------------------------------------------------------------
// judges.ts
// ---------------------------------------------------------------------------

describe('FEATURE_104 judges — mustContainAll', () => {
  it('passes when all phrases are present (case-insensitive)', () => {
    const j = mustContainAll('hello', 'world');
    expect(j.judge('hello, World!').passed).toBe(true);
  });

  it('fails when any phrase is missing, reports which', () => {
    const j = mustContainAll('alpha', 'beta', 'gamma');
    const r = j.judge('alpha and beta only');
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('gamma');
  });

  it('matches CJK chars without case folding artifacts', () => {
    const j = mustContainAll('智谱', 'GLM');
    expect(j.judge('智谱 GLM-5.1 模型').passed).toBe(true);
  });
});

describe('FEATURE_104 judges — mustContainAny', () => {
  it('passes when at least one phrase matches', () => {
    expect(mustContainAny('cat', 'dog').judge('I have a Cat').passed).toBe(true);
  });

  it('fails when none match', () => {
    expect(mustContainAny('cat', 'dog').judge('only birds here').passed).toBe(false);
  });
});

describe('FEATURE_104 judges — mustNotContain', () => {
  it('passes when no forbidden phrase is present', () => {
    expect(mustNotContain('Claude').judge("I am KodaX").passed).toBe(true);
  });

  it('fails when a forbidden phrase appears', () => {
    const r = mustNotContain('Claude', 'GPT').judge("I'm Claude.");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('Claude');
  });
});

describe('FEATURE_104 judges — mustMatch / mustNotMatch', () => {
  it('mustMatch passes when regex matches', () => {
    expect(mustMatch(/version \d+\.\d+/i).judge('Version 5.1').passed).toBe(true);
  });

  it('mustMatch fails when regex does not match, reason includes pattern', () => {
    const r = mustMatch(/^EXPECTED$/).judge('something else');
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('EXPECTED');
  });

  it('mustNotMatch passes when pattern absent', () => {
    expect(mustNotMatch(/I'?m (Claude|GPT)/i).judge('I am KodaX').passed).toBe(true);
  });

  it('mustNotMatch fails when pattern present', () => {
    expect(mustNotMatch(/I'?m Claude/i).judge("I'm Claude").passed).toBe(false);
  });
});

describe('FEATURE_104 judges — lengthWithin', () => {
  it('passes when length is in range', () => {
    expect(lengthWithin(5, 20).judge('hello world').passed).toBe(true);
  });

  it('fails when too short, with reason', () => {
    const r = lengthWithin(50, 100).judge('short');
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/too short/);
  });

  it('fails when too long, with reason', () => {
    const r = lengthWithin(0, 5).judge('this is way too long');
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/too long/);
  });
});

describe('FEATURE_104 judges — parseAndAssert', () => {
  it('passes when extract returns a value satisfying predicate', () => {
    const j = parseAndAssert<number>(
      (out) => Number(out) || null,
      (n) => n > 100,
      'gt-100',
    );
    expect(j.judge('200').passed).toBe(true);
  });

  it('fails when extraction returns null', () => {
    const j = parseAndAssert<number>(
      () => null,
      () => true,
    );
    const r = j.judge('anything');
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/extraction returned null/);
  });

  it('fails when predicate rejects', () => {
    const j = parseAndAssert<number>(
      (out) => Number(out),
      (n) => n > 100,
    );
    const r = j.judge('5');
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/predicate failed/);
  });
});

describe('FEATURE_104 judges — runJudges aggregation', () => {
  it('passed=true iff every judge passes', () => {
    const result = runJudges('hello world', [
      mustContainAll('hello'),
      mustNotContain('claude'),
      lengthWithin(1, 100),
    ]);
    expect(result.passed).toBe(true);
    expect(result.results.length).toBe(3);
    expect(result.results.every((r) => r.passed)).toBe(true);
  });

  it('passed=false when any judge fails; collects all results', () => {
    const result = runJudges('hello', [
      mustContainAll('missing'),
      lengthWithin(1, 100),
    ]);
    expect(result.passed).toBe(false);
    expect(result.results[0]?.passed).toBe(false);
    expect(result.results[1]?.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// harness.ts — comparison aggregation (without provider calls)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FEATURE_104 v2 — judge category + decomposed aggregation
// ---------------------------------------------------------------------------

describe('FEATURE_104 v2 — judges with category', () => {
  it('runJudges decomposes byCategory + reports format gate', () => {
    const j: PromptJudge[] = [
      { name: 'parses', category: 'format', judge: () => ({ passed: true }) },
      { name: 'has-X',  category: 'correctness', judge: () => ({ passed: true }) },
      { name: 'has-Y',  category: 'correctness', judge: () => ({ passed: false, reason: 'missing Y' }) },
      { name: 'no-claude', category: 'safety', judge: () => ({ passed: true }) },
    ];
    const r = runJudges('output', j);
    expect(r.passed).toBe(false);  // has-Y failed
    expect(r.formatPassed).toBe(true);
    expect(r.byCategory.format).toEqual({ passed: 1, total: 1 });
    expect(r.byCategory.correctness).toEqual({ passed: 1, total: 2 });
    expect(r.byCategory.safety).toEqual({ passed: 1, total: 1 });
  });

  it('runJudges defaults missing category to correctness', () => {
    const j: PromptJudge[] = [
      { name: 'a', judge: () => ({ passed: true }) },
      { name: 'b', judge: () => ({ passed: true }) },
    ];
    const r = runJudges('o', j);
    expect(r.byCategory.correctness).toEqual({ passed: 2, total: 2 });
    expect(r.byCategory.format).toBeUndefined();
  });

  it('runJudges marks formatPassed=false when format-category judge fails', () => {
    const j: PromptJudge[] = [
      { name: 'parses', category: 'format', judge: () => ({ passed: false, reason: 'bad shape' }) },
      { name: 'has-X', category: 'correctness', judge: () => ({ passed: true }) },
    ];
    const r = runJudges('o', j);
    expect(r.passed).toBe(false);
    expect(r.formatPassed).toBe(false);
    expect(r.byCategory.format).toEqual({ passed: 0, total: 1 });
  });
});

// ---------------------------------------------------------------------------
// FEATURE_104 v2 — speed scoring tolerance window
// ---------------------------------------------------------------------------

describe('FEATURE_104 v2 — speedScore (anti-pattern 1: not linear from 0)', () => {
  it('returns 100 when duration is within ideal window', () => {
    expect(speedScore(0, 30_000, 240_000)).toBe(100);
    expect(speedScore(15_000, 30_000, 240_000)).toBe(100);
    expect(speedScore(30_000, 30_000, 240_000)).toBe(100);
  });

  it('returns 0 when duration is at or past ceiling', () => {
    expect(speedScore(240_000, 30_000, 240_000)).toBe(0);
    expect(speedScore(300_000, 30_000, 240_000)).toBe(0);
    expect(speedScore(999_999, 30_000, 240_000)).toBe(0);
  });

  it('linearly interpolates between ideal and ceiling', () => {
    // Halfway between 30s (100) and 240s (0) → 50
    const halfway = (30_000 + 240_000) / 2;
    expect(speedScore(halfway, 30_000, 240_000)).toBe(50);
  });

  it('clamps to [0, 100]', () => {
    expect(speedScore(-1000, 30_000, 240_000)).toBe(100);
    expect(speedScore(1_000_000, 30_000, 240_000)).toBe(0);
  });

  it('handles degenerate ideal >= ceiling gracefully (binary)', () => {
    expect(speedScore(50, 100, 100)).toBe(100); // duration <= ideal
    expect(speedScore(150, 100, 100)).toBe(0);  // duration > ideal
  });

  it('default constants reflect interactive coding-CLI workload', () => {
    expect(DEFAULT_SPEED_IDEAL_MS).toBe(30_000);
    expect(DEFAULT_SPEED_CEILING_MS).toBe(240_000);
  });
});

// ---------------------------------------------------------------------------
// FEATURE_104 v2 — defaults match LiveCanvas recipe
// ---------------------------------------------------------------------------

describe('FEATURE_104 v2 — benchmark defaults', () => {
  it('default runs is 3 (anti-pattern 4: judging from a single lucky run)', () => {
    expect(DEFAULT_BENCHMARK_RUNS).toBe(3);
  });

  it('default composite weights favor quality 0.85 / speed 0.15', () => {
    expect(DEFAULT_COMPOSITE_WEIGHTS.quality).toBe(0.85);
    expect(DEFAULT_COMPOSITE_WEIGHTS.speed).toBe(0.15);
    expect(DEFAULT_COMPOSITE_WEIGHTS.quality + DEFAULT_COMPOSITE_WEIGHTS.speed).toBeCloseTo(1.0);
  });
});

// ---------------------------------------------------------------------------
// FEATURE_104 v2 — report rendering (without provider calls)
// ---------------------------------------------------------------------------

function fixtureBenchmarkResult(): BenchmarkResult {
  // Hand-built result mimicking what runBenchmark would produce.
  // Two variants × two models × 3 runs.
  const cell = (
    variantId: string,
    alias: 'zhipu/glm51' | 'ds/v4flash',
    quality: number,
    speed: number,
    composite: number,
    correctnessPassed = 2,
  ): BenchmarkCellSummary => ({
    variantId,
    alias,
    runs: 3,
    completed: 3,
    passRate: quality,
    passRateStdDev: 5,
    byCategory: {
      format: { passed: 3, total: 3 },
      correctness: { passed: correctnessPassed, total: 6 },
    } as BenchmarkCellSummary['byCategory'],
    qualityByCategory: {
      format: 100,
      correctness: (correctnessPassed / 6) * 100,
    } as BenchmarkCellSummary['qualityByCategory'],
    quality,
    speed,
    composite,
    duration: { min: 5000, median: 8000, mean: 9000, p95: 12000, max: 15000 },
    runsRaw: [
      {
        variantId,
        alias,
        runIndex: 0,
        text: `output for ${variantId}/${alias}#0`,
        toolCalls: [],
        durationMs: 8000,
        judges: [
          { name: 'parses', category: 'format', passed: true },
          { name: 'has-X', category: 'correctness', passed: true },
          {
            name: 'has-Y',
            category: 'correctness',
            passed: false,
            reason: 'Y missing — see prompt §channel-hookup',
          },
        ],
        judgeAggregate: {
          passed: false,
          results: [
            { name: 'parses', category: 'format', passed: true },
            { name: 'has-X', category: 'correctness', passed: true },
            {
              name: 'has-Y',
              category: 'correctness',
              passed: false,
              reason: 'Y missing — see prompt §channel-hookup',
            },
          ],
          byCategory: {
            format: { passed: 1, total: 1 },
            correctness: { passed: 1, total: 2 },
          } as Record<
            'format' | 'correctness' | 'style' | 'safety' | 'custom',
            { passed: number; total: number }
          >,
          formatPassed: true,
        },
        passed: false,
      },
    ],
  });

  return {
    variants: [
      { id: 'v1', systemPrompt: 'old prompt', userMessage: 'task' },
      { id: 'v2', systemPrompt: 'new prompt', userMessage: 'task' },
    ],
    models: ['zhipu/glm51', 'ds/v4flash'],
    cells: [
      cell('v1', 'zhipu/glm51', 33, 100, 36),
      cell('v1', 'ds/v4flash', 50, 100, 53),
      cell('v2', 'zhipu/glm51', 100, 100, 100, 6),
      cell('v2', 'ds/v4flash', 83, 100, 84, 5),
    ],
    byVariant: {
      v1: [],
      v2: [],
    },
    byModel: {
      'zhipu/glm51': [],
      'ds/v4flash': [],
    },
    variantsDominantOnEveryModel: ['v2'],
    totalSeconds: 120.5,
    config: {
      runs: 3,
      speedIdealMs: 30_000,
      speedCeilingMs: 240_000,
      compositeWeights: { quality: 0.85, speed: 0.15 },
    },
    startedAt: '2026-04-27T12:34:56.789Z',
  };
}

describe('FEATURE_104 v2 — renderBenchmarkReport', () => {
  it('emits all 9 sections', () => {
    const md = renderBenchmarkReport(fixtureBenchmarkResult());
    expect(md).toContain('# Prompt Benchmark Report');
    expect(md).toContain('## 1. Run summary');
    expect(md).toContain('## 2. Methodology');
    expect(md).toContain('## 3. Score matrix');
    expect(md).toContain('## 4. Quality sub-dimensions');
    expect(md).toContain('## 5. Time analysis');
    expect(md).toContain('## 6. Variance');
    expect(md).toContain('## 7. Variant ranking');
    expect(md).toContain('## 8. Assertion failure patterns');
    expect(md).toContain('## 9. Reproduction');
  });

  it('records the dominant variant in §7', () => {
    const md = renderBenchmarkReport(fixtureBenchmarkResult());
    expect(md).toContain('strictly ≥');
    expect(md).toContain('`v2`');
  });

  it('aggregates and ranks failure patterns in §8 by frequency', () => {
    const md = renderBenchmarkReport(fixtureBenchmarkResult());
    expect(md).toContain('has-Y');
    expect(md).toContain('Y missing');
    expect(md).toContain('Assertion failure patterns');
  });

  it('embeds the statistical-significance caveat in §7', () => {
    const md = renderBenchmarkReport(fixtureBenchmarkResult());
    expect(md).toContain('statistically indistinguishable');
  });

  it('decomposes per-category in §4', () => {
    const md = renderBenchmarkReport(fixtureBenchmarkResult());
    expect(md).toContain('### Variant `v1`');
    expect(md).toContain('### Variant `v2`');
    expect(md).toContain('format');
    expect(md).toContain('correctness');
  });
});

describe('FEATURE_104 v2 — renderCompactSummary', () => {
  it('produces a one-line summary with key numbers', () => {
    const fixture = fixtureBenchmarkResult();
    const cell = fixture.cells[0]!;
    const line = renderCompactSummary(cell);
    expect(line).toContain(cell.variantId);
    expect(line).toContain(cell.alias);
    expect(line).toContain('pass=');
    expect(line).toContain('q=');
    expect(line).toContain('comp=');
  });
});

describe('FEATURE_104 v2 — persistence (writeBenchmarkReport / readBenchmarkResult)', () => {
  it('writes results.json + REPORT.md + codes/ to a fresh tmpdir, then reads back', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-bench-'));
    try {
      const result = fixtureBenchmarkResult();
      const persisted = await writeBenchmarkReport(result, { outDir: tmp });

      // results.json
      expect(persisted.resultsJsonPath).toBe(path.join(tmp, 'results.json'));
      const json = await fs.readFile(persisted.resultsJsonPath, 'utf8');
      expect(JSON.parse(json).startedAt).toBe(result.startedAt);

      // REPORT.md
      expect(persisted.reportMdPath).toBe(path.join(tmp, 'REPORT.md'));
      const md = await fs.readFile(persisted.reportMdPath, 'utf8');
      expect(md).toContain('# Prompt Benchmark Report');

      // codes/
      expect(persisted.codesDir).toBe(path.join(tmp, 'codes'));
      const codes = await fs.readdir(persisted.codesDir!);
      expect(codes.length).toBeGreaterThan(0);

      // codes-index.json
      expect(persisted.codesIndexPath).toBe(path.join(tmp, 'codes-index.json'));
      const indexJson = JSON.parse(
        await fs.readFile(persisted.codesIndexPath!, 'utf8'),
      ) as Record<string, string>;
      expect(Object.keys(indexJson).length).toBeGreaterThan(0);

      // round-trip via readBenchmarkResult
      const reloaded = await readBenchmarkResult(tmp);
      expect(reloaded.startedAt).toBe(result.startedAt);
      expect(reloaded.cells.length).toBe(result.cells.length);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('skipRawOutputs=true omits codes/ + codes-index.json', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-bench-'));
    try {
      const persisted = await writeBenchmarkReport(fixtureBenchmarkResult(), {
        outDir: tmp,
        skipRawOutputs: true,
      });
      expect(persisted.codesDir).toBeUndefined();
      expect(persisted.codesIndexPath).toBeUndefined();
      // codes/ directory shouldn't exist
      let exists = false;
      try {
        await fs.access(path.join(tmp, 'codes'));
        exists = true;
      } catch {}
      expect(exists).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('FEATURE_104 harness — formatComparisonTable', () => {
  it('renders empty table when no outcomes', () => {
    const result: ABComparisonResult = {
      outcomes: [],
      byVariant: {},
      byModel: {},
      variantsPassingEveryModel: [],
    };
    expect(formatComparisonTable(result)).toBe('(empty comparison)');
  });

  it('renders pass/fail cells with first failing-judge reason', () => {
    const outcomes: VariantOutcome[] = [
      {
        variantId: 'v1',
        alias: 'zhipu/glm51',
        text: 'ok',
        toolCalls: [],
        judges: [{ name: 'mustContain', passed: true }],
        passed: true,
      },
      {
        variantId: 'v1',
        alias: 'ds/v4flash',
        text: 'no',
        toolCalls: [],
        judges: [
          { name: 'mustContain', passed: false, reason: 'missing keyword' },
        ],
        passed: false,
      },
      {
        variantId: 'v2',
        alias: 'zhipu/glm51',
        text: 'ok2',
        toolCalls: [],
        judges: [{ name: 'mustContain', passed: true }],
        passed: true,
      },
      {
        variantId: 'v2',
        alias: 'ds/v4flash',
        text: 'ok2',
        toolCalls: [],
        judges: [{ name: 'mustContain', passed: true }],
        passed: true,
      },
    ];
    const result: ABComparisonResult = {
      outcomes,
      byVariant: {
        v1: [outcomes[0]!, outcomes[1]!],
        v2: [outcomes[2]!, outcomes[3]!],
      },
      byModel: {
        'zhipu/glm51': [outcomes[0]!, outcomes[2]!],
        'ds/v4flash': [outcomes[1]!, outcomes[3]!],
      },
      variantsPassingEveryModel: ['v2'],
    };
    const table = formatComparisonTable(result);
    expect(table).toContain('v1');
    expect(table).toContain('v2');
    expect(table).toContain('zhipu/glm51');
    expect(table).toContain('ds/v4flash');
    expect(table).toContain('PASS');
    expect(table).toContain('FAIL');
    expect(table).toContain('missing keyword');
  });
});
