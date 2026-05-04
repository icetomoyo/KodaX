/**
 * Hermetic self-test for the scout-h0-mini-planner dataset shape.
 * Does NOT call any LLM — that lives in tests/feature-097-h0-mini-planner-strength.eval.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  H0_MINI_PLANNER_TASKS,
  LIGHT_VARIANT_SYSTEM_PROMPT,
  HEAVY_VARIANT_SYSTEM_PROMPT,
  buildJudges,
  buildPromptVariants,
  parseObligations,
  type HarnessId,
  type TaskComplexity,
  type VariantId,
} from './cases.js';

describe('scout-h0-mini-planner dataset shape', () => {
  it('exposes exactly 4 task cases', () => {
    expect(H0_MINI_PLANNER_TASKS.length).toBe(4);
  });

  it('all case ids are unique', () => {
    const ids = H0_MINI_PLANNER_TASKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every case has a non-empty userMessage and description', () => {
    for (const c of H0_MINI_PLANNER_TASKS) {
      expect(c.userMessage.length).toBeGreaterThan(20);
      expect(c.description.length).toBeGreaterThan(10);
    }
  });

  it('expected harness reflects FEATURE_106 mutation rule (≤1 file → H0, ≥2 files → H1)', () => {
    const byComplexity = new Map<TaskComplexity, HarnessId>(
      H0_MINI_PLANNER_TASKS.map((c) => [c.complexity, c.expectedHarness]),
    );
    // Single-file (or zero-file) mutation tasks stay at H0_DIRECT.
    expect(byComplexity.get('simple-typo')).toBe('H0_DIRECT');
    expect(byComplexity.get('borderline-2step')).toBe('H0_DIRECT');
    // ≥2 files mutation correctly escalates to H1_EXECUTE_EVAL by FEATURE_106 rule.
    expect(byComplexity.get('multistep-rename')).toBe('H1_EXECUTE_EVAL');
    expect(byComplexity.get('complex-flag')).toBe('H1_EXECUTE_EVAL');
    // No H2 in this dataset (lives in ama-harness-selection).
    const harnesses: HarnessId[] = H0_MINI_PLANNER_TASKS.map((c) => c.expectedHarness);
    expect(harnesses).not.toContain('H2_PLAN_EXECUTE_EVAL');
  });

  it('every complexity label appears exactly once (deduplicated coverage)', () => {
    const counts = new Map<TaskComplexity, number>();
    for (const c of H0_MINI_PLANNER_TASKS) {
      counts.set(c.complexity, (counts.get(c.complexity) ?? 0) + 1);
    }
    for (const [_, count] of counts) {
      expect(count).toBe(1);
    }
    expect(counts.size).toBe(4);
  });

  it('expected obligation ranges are well-formed (min ≤ max, non-negative)', () => {
    for (const c of H0_MINI_PLANNER_TASKS) {
      expect(c.expectedObligationCount.min).toBeGreaterThanOrEqual(0);
      expect(c.expectedObligationCount.max).toBeGreaterThanOrEqual(
        c.expectedObligationCount.min,
      );
    }
  });

  it('simple-typo expects 0-1 obligations (over-formalization red line)', () => {
    const simple = H0_MINI_PLANNER_TASKS.find((c) => c.complexity === 'simple-typo');
    expect(simple).toBeDefined();
    expect(simple?.expectedObligationCount.min).toBe(0);
    expect(simple?.expectedObligationCount.max).toBe(1);
  });

  it('multistep + complex cases expect 3+ obligations (mini-planner sweet spot)', () => {
    const multistep = H0_MINI_PLANNER_TASKS.find(
      (c) => c.complexity === 'multistep-rename',
    );
    const complex = H0_MINI_PLANNER_TASKS.find((c) => c.complexity === 'complex-flag');
    expect(multistep?.expectedObligationCount.min).toBeGreaterThanOrEqual(3);
    expect(complex?.expectedObligationCount.min).toBeGreaterThanOrEqual(3);
  });
});

describe('scout-h0-mini-planner variants', () => {
  it('both variants share the FEATURE_112 anchor SCOPE COMMITMENT block (pinned base)', () => {
    expect(LIGHT_VARIANT_SYSTEM_PROMPT).toContain('Default harness is H0_DIRECT');
    expect(HEAVY_VARIANT_SYSTEM_PROMPT).toContain('Default harness is H0_DIRECT');
    expect(LIGHT_VARIANT_SYSTEM_PROMPT).toContain('write ≥2 files OR start a project');
    expect(HEAVY_VARIANT_SYSTEM_PROMPT).toContain('write ≥2 files OR start a project');
    expect(LIGHT_VARIANT_SYSTEM_PROMPT).toContain('read-only investigation reaches ≥5');
    expect(HEAVY_VARIANT_SYSTEM_PROMPT).toContain('read-only investigation reaches ≥5');
  });

  it('light variant has the 1-line mini-planner hint but NOT heavy examples', () => {
    expect(LIGHT_VARIANT_SYSTEM_PROMPT).toContain('≥ 2 distinct execution steps');
    // Heavy-only example markers must be absent.
    expect(LIGHT_VARIANT_SYSTEM_PROMPT).not.toContain('Examples of "distinct execution steps"');
    expect(LIGHT_VARIANT_SYSTEM_PROMPT).not.toContain('Examples of NOT distinct steps');
    expect(LIGHT_VARIANT_SYSTEM_PROMPT).not.toContain('todo_update at each transition');
  });

  it('heavy variant has positive + negative examples + emit_scout_verdict timing + todo_update step', () => {
    expect(HEAVY_VARIANT_SYSTEM_PROMPT).toContain('Examples of "distinct execution steps"');
    expect(HEAVY_VARIANT_SYSTEM_PROMPT).toContain('Examples of NOT distinct steps');
    expect(HEAVY_VARIANT_SYSTEM_PROMPT).toContain('BEFORE calling emit_scout_verdict');
    expect(HEAVY_VARIANT_SYSTEM_PROMPT).toContain('todo_update at each transition');
    expect(HEAVY_VARIANT_SYSTEM_PROMPT).toContain('Single-token typo fixes');
    expect(HEAVY_VARIANT_SYSTEM_PROMPT).toContain('preparation, not a step');
  });

  it('both variants share the IDENTICAL output format spec (no format-spec confound)', () => {
    const lightFormat = LIGHT_VARIANT_SYSTEM_PROMPT.match(
      /IMPORTANT — output format[\s\S]+$/,
    )?.[0];
    const heavyFormat = HEAVY_VARIANT_SYSTEM_PROMPT.match(
      /IMPORTANT — output format[\s\S]+$/,
    )?.[0];
    expect(lightFormat).toBeDefined();
    expect(heavyFormat).toBeDefined();
    expect(lightFormat).toBe(heavyFormat);
  });

  it('heavy variant is strictly longer than light (the differentiator is the planner block)', () => {
    expect(HEAVY_VARIANT_SYSTEM_PROMPT.length).toBeGreaterThan(
      LIGHT_VARIANT_SYSTEM_PROMPT.length,
    );
  });

  it('buildPromptVariants returns one PromptVariant per requested variantId', () => {
    const task = H0_MINI_PLANNER_TASKS[0]!;
    const variantIds: readonly VariantId[] = ['light', 'heavy'];
    const variants = buildPromptVariants(task, variantIds);
    expect(variants.length).toBe(2);
    expect(variants.map((v) => v.id)).toEqual(['light', 'heavy']);
    expect(variants[0]?.systemPrompt).toBe(LIGHT_VARIANT_SYSTEM_PROMPT);
    expect(variants[1]?.systemPrompt).toBe(HEAVY_VARIANT_SYSTEM_PROMPT);
    expect(variants[0]?.userMessage).toBe(task.userMessage);
  });
});

describe('scout-h0-mini-planner judges', () => {
  it('buildJudges returns 4 judges (format + correctness + count + coherence)', () => {
    const task = H0_MINI_PLANNER_TASKS[0]!;
    const judges = buildJudges(task);
    expect(judges.length).toBe(4);
    expect(judges[0]?.name).toBe('harness-format');
    expect(judges[0]?.category).toBe('format');
    expect(judges[1]?.name).toContain('harness-correct');
    expect(judges[2]?.name).toContain('obligation-count');
    expect(judges[3]?.name).toBe('obligation-coherence(no-filler)');
  });

  it('harness-format judge accepts both HARNESS: and confirmed_harness= phrasings', () => {
    const judges = buildJudges(H0_MINI_PLANNER_TASKS[0]!);
    const formatJudge = judges[0]!;
    expect(formatJudge.judge('HARNESS: H0_DIRECT\n').passed).toBe(true);
    expect(formatJudge.judge('confirmed_harness="H0_DIRECT"').passed).toBe(true);
    expect(formatJudge.judge('no harness here').passed).toBe(false);
  });

  it('harness-correct judge enforces the expected harness id', () => {
    const judges = buildJudges(H0_MINI_PLANNER_TASKS[0]!);
    const correctJudge = judges[1]!;
    expect(correctJudge.judge('HARNESS: H0_DIRECT').passed).toBe(true);
    expect(correctJudge.judge('HARNESS: H1_EXECUTE_EVAL').passed).toBe(false);
  });

  it('obligation-count judge enforces the expected range', () => {
    const simple = H0_MINI_PLANNER_TASKS.find((c) => c.complexity === 'simple-typo')!;
    const multistep = H0_MINI_PLANNER_TASKS.find(
      (c) => c.complexity === 'multistep-rename',
    )!;

    const simpleJudge = buildJudges(simple)[2]!;
    // 0 obligations → pass (within 0-1)
    expect(simpleJudge.judge('HARNESS: H0_DIRECT\nRATIONALE: trivial').passed).toBe(true);
    // 1 obligation → pass
    expect(
      simpleJudge.judge(
        'HARNESS: H0_DIRECT\nOBLIGATIONS:\n- Fix typo\nRATIONALE: trivial',
      ).passed,
    ).toBe(true);
    // 3 obligations → fail (over-formalization)
    expect(
      simpleJudge.judge(
        'HARNESS: H0_DIRECT\nOBLIGATIONS:\n- Read README\n- Fix typo\n- Verify',
      ).passed,
    ).toBe(false);

    const multistepJudge = buildJudges(multistep)[2]!;
    // 4 obligations → pass (within 3-6)
    expect(
      multistepJudge.judge(
        'HARNESS: H0_DIRECT\nOBLIGATIONS:\n- Rename in messaging.ts\n- Update caller a.ts\n- Update caller b.ts\n- Run typecheck',
      ).passed,
    ).toBe(true);
    // 1 obligation → fail (under-decomposed)
    expect(
      multistepJudge.judge('HARNESS: H0_DIRECT\nOBLIGATIONS:\n- Do the rename').passed,
    ).toBe(false);
  });

  it('obligation-coherence judge flags filler/preparation/reasoning steps', () => {
    const judges = buildJudges(H0_MINI_PLANNER_TASKS[2]!); // multistep-rename
    const coherenceJudge = judges[3]!;

    // Pure action steps → pass
    expect(
      coherenceJudge.judge(
        'OBLIGATIONS:\n- Rename emitMessage to publishMessage in messaging.ts\n- Update caller in a.ts\n- Run typecheck',
      ).passed,
    ).toBe(true);

    // Filler step ("Read messaging.ts to understand structure") → fail
    expect(
      coherenceJudge.judge(
        'OBLIGATIONS:\n- Read messaging.ts to understand structure\n- Rename function\n- Run tests',
      ).passed,
    ).toBe(false);

    // Empty obligations → pass (skipped)
    expect(coherenceJudge.judge('HARNESS: H0_DIRECT').passed).toBe(true);
  });
});

describe('parseObligations parser', () => {
  it('returns empty when no OBLIGATIONS section', () => {
    const out = parseObligations('HARNESS: H0_DIRECT\nRATIONALE: trivial');
    expect(out.hasSection).toBe(false);
    expect(out.items).toEqual([]);
  });

  it('parses dash-prefixed list', () => {
    const out = parseObligations(
      'HARNESS: H0_DIRECT\nOBLIGATIONS:\n- step a\n- step b\n- step c\nRATIONALE: ok',
    );
    expect(out.items).toEqual(['step a', 'step b', 'step c']);
    expect(out.hasSection).toBe(true);
  });

  it('parses asterisk-prefixed list', () => {
    const out = parseObligations('OBLIGATIONS:\n* step a\n* step b');
    expect(out.items).toEqual(['step a', 'step b']);
  });

  it('parses numbered list (1. format)', () => {
    const out = parseObligations('OBLIGATIONS:\n1. step a\n2. step b\n3. step c');
    expect(out.items).toEqual(['step a', 'step b', 'step c']);
  });

  it('parses numbered list (1) format)', () => {
    const out = parseObligations('OBLIGATIONS:\n1) step a\n2) step b');
    expect(out.items).toEqual(['step a', 'step b']);
  });

  it('stops at next ALL-CAPS section header', () => {
    const out = parseObligations(
      'OBLIGATIONS:\n- step a\n- step b\nRATIONALE: this should not be in the list',
    );
    expect(out.items).toEqual(['step a', 'step b']);
  });

  it('flags filler items (read, think, understand, examine)', () => {
    const out = parseObligations(
      'OBLIGATIONS:\n- Read README first\n- Fix the typo\n- Understand the impact',
    );
    expect(out.items.length).toBe(3);
    expect(out.fillerItems.length).toBe(2);
    expect(out.fillerItems[0]).toContain('Read');
    expect(out.fillerItems[1]).toContain('Understand');
  });

  it('does NOT flag legitimate action verbs starting with similar letters', () => {
    // "Replace" and "Refactor" should NOT trigger filler pattern.
    const out = parseObligations(
      'OBLIGATIONS:\n- Replace console.log with logger.info\n- Refactor handler\n- Run lint',
    );
    expect(out.items.length).toBe(3);
    expect(out.fillerItems.length).toBe(0);
  });

  it('handles obligations section in lowercase header', () => {
    const out = parseObligations('Obligations:\n- step a\n- step b');
    expect(out.items).toEqual(['step a', 'step b']);
  });

  it('skips empty list items', () => {
    const out = parseObligations('OBLIGATIONS:\n- step a\n-\n- step b');
    expect(out.items).toEqual(['step a', 'step b']);
  });

  it('does NOT mistake markdown bold close (**) for a list marker', () => {
    // Regression for parser bug surfaced in the FEATURE_097 pilot eval:
    // mmx/m27 wraps headers in **OBLIGATIONS:** style, and an old version
    // of the parser counted the trailing `**` as a `*` marker with content `*`.
    const out = parseObligations(
      '**OBLIGATIONS:**\n' +
      '- Replace console.log with logger.info in src/utils/log.ts\n' +
      '- Run npm run lint to verify\n' +
      '\n' +
      '**RATIONALE:** Single-file mutation.',
    );
    expect(out.items).toEqual([
      'Replace console.log with logger.info in src/utils/log.ts',
      'Run npm run lint to verify',
    ]);
  });

  it('parses **OBLIGATIONS:** (markdown-bold header) correctly', () => {
    const out = parseObligations('**OBLIGATIONS:**\n- step a\n- step b');
    expect(out.hasSection).toBe(true);
    expect(out.items).toEqual(['step a', 'step b']);
  });
});
