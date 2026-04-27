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
  type ABComparisonResult,
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
} from './prompt-eval/judges.js';

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
