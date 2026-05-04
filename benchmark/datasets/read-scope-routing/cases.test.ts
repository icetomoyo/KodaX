/**
 * Hermetic self-test for the read-scope-routing dataset shape.
 * Does NOT call any LLM — that lives in tests/feature-112-read-scope-routing.eval.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  READ_SCOPE_TASKS,
  CURRENT_V0733_VARIANT_SYSTEM_PROMPT,
  FEATURE_112_VARIANT_SYSTEM_PROMPT,
  FEATURE_112_COMPACT_VARIANT_SYSTEM_PROMPT,
  FEATURE_112_ANCHOR_VARIANT_SYSTEM_PROMPT,
  buildJudges,
  buildPromptVariants,
  type HarnessId,
  type TaskClass,
  type VariantId,
} from './cases.js';

describe('read-scope-routing dataset shape', () => {
  it('exposes exactly 4 task cases (12-cell target = 4 tasks × 3 alias)', () => {
    expect(READ_SCOPE_TASKS.length).toBe(4);
  });

  it('all case ids are unique', () => {
    const ids = READ_SCOPE_TASKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every case has a non-empty userMessage and description', () => {
    for (const c of READ_SCOPE_TASKS) {
      expect(c.userMessage.length).toBeGreaterThan(20);
      expect(c.description.length).toBeGreaterThan(10);
    }
  });

  it('expected harness covers H0 + H1 (no H2 — H2 lives in ama-harness-selection)', () => {
    const ids: HarnessId[] = READ_SCOPE_TASKS.map((c) => c.expectedHarness);
    expect(ids).toContain('H0_DIRECT');
    expect(ids).toContain('H1_EXECUTE_EVAL');
    expect(ids).not.toContain('H2_PLAN_EXECUTE_EVAL');
  });

  it('shallow-qa is the only H0 case (regression guard)', () => {
    const h0Cases = READ_SCOPE_TASKS.filter((c) => c.expectedHarness === 'H0_DIRECT');
    expect(h0Cases.length).toBe(1);
    expect(h0Cases[0]?.taskClass).toBe('shallow-qa');
  });

  it('three deep classes (deep-systemic / multithread / unknown-heavy) all expect H1', () => {
    const deepCases = READ_SCOPE_TASKS.filter(
      (c) =>
        c.taskClass === 'deep-systemic'
        || c.taskClass === 'multithread'
        || c.taskClass === 'unknown-heavy',
    );
    expect(deepCases.length).toBe(3);
    for (const c of deepCases) {
      expect(c.expectedHarness).toBe('H1_EXECUTE_EVAL');
    }
  });

  it('every taskClass label appears exactly once (deduplicated cell coverage)', () => {
    const counts = new Map<TaskClass, number>();
    for (const c of READ_SCOPE_TASKS) {
      counts.set(c.taskClass, (counts.get(c.taskClass) ?? 0) + 1);
    }
    for (const [taskClass, count] of counts) {
      expect(count).toBe(1);
      expect(['shallow-qa', 'deep-systemic', 'multithread', 'unknown-heavy']).toContain(taskClass);
    }
  });
});

describe('read-scope-routing variants', () => {
  it('current_v0733 contains FEATURE_106 SCOPE COMMITMENT but not FEATURE_112 investigation-scope rule', () => {
    expect(CURRENT_V0733_VARIANT_SYSTEM_PROMPT).toContain('SCOPE COMMITMENT');
    // The FEATURE_106 mutation rule wording — must be present in baseline
    expect(CURRENT_V0733_VARIANT_SYSTEM_PROMPT).toContain('write ≥2 files OR start a project');
    // The FEATURE_112 read-scope wording — must NOT be in baseline
    expect(CURRENT_V0733_VARIANT_SYSTEM_PROMPT).not.toContain('read-only investigation reaches ≥5');
    expect(CURRENT_V0733_VARIANT_SYSTEM_PROMPT).not.toContain('Multi-thread early decision');
  });

  it('feature_112 carries both the mutation rule (preserved) and the new investigation/multi-thread rules', () => {
    expect(FEATURE_112_VARIANT_SYSTEM_PROMPT).toContain('SCOPE COMMITMENT');
    // Mutation rule preserved
    expect(FEATURE_112_VARIANT_SYSTEM_PROMPT).toContain('write ≥2 files OR start a project');
    // Investigation rule (new)
    expect(FEATURE_112_VARIANT_SYSTEM_PROMPT).toContain('read-only investigation reaches ≥5');
    expect(FEATURE_112_VARIANT_SYSTEM_PROMPT).toContain('H1_EXECUTE_EVAL');
    // Multi-thread rule (new)
    expect(FEATURE_112_VARIANT_SYSTEM_PROMPT).toContain('Multi-thread early decision');
  });

  it('buildPromptVariants returns one PromptVariant per requested variantId', () => {
    const task = READ_SCOPE_TASKS[0]!;
    const variantIds: readonly VariantId[] = [
      'current_v0733',
      'feature_112',
      'feature_112_compact',
      'feature_112_anchor',
    ];
    const variants = buildPromptVariants(task, variantIds);
    expect(variants.length).toBe(4);
    expect(variants.map((v) => v.id)).toEqual([
      'current_v0733',
      'feature_112',
      'feature_112_compact',
      'feature_112_anchor',
    ]);
    expect(variants[0]?.systemPrompt).toBe(CURRENT_V0733_VARIANT_SYSTEM_PROMPT);
    expect(variants[1]?.systemPrompt).toBe(FEATURE_112_VARIANT_SYSTEM_PROMPT);
    expect(variants[2]?.systemPrompt).toBe(FEATURE_112_COMPACT_VARIANT_SYSTEM_PROMPT);
    expect(variants[3]?.systemPrompt).toBe(FEATURE_112_ANCHOR_VARIANT_SYSTEM_PROMPT);
  });

  it('feature_112_compact strictly shorter than feature_112 (length-stability hypothesis)', () => {
    expect(FEATURE_112_COMPACT_VARIANT_SYSTEM_PROMPT.length).toBeLessThan(
      FEATURE_112_VARIANT_SYSTEM_PROMPT.length,
    );
    // The compact variant title carries the implicit H0 anchor.
    expect(FEATURE_112_COMPACT_VARIANT_SYSTEM_PROMPT).toContain('default is H0');
  });

  it('feature_112_anchor carries explicit Default-is-H0 reverse anchor while keeping verbose rules', () => {
    expect(FEATURE_112_ANCHOR_VARIANT_SYSTEM_PROMPT).toContain('Default harness is H0_DIRECT');
    // Verbose rules preserved (same wording as feature_112 below the anchor).
    expect(FEATURE_112_ANCHOR_VARIANT_SYSTEM_PROMPT).toContain('Continuing solo past this threshold loses');
  });
});

describe('read-scope-routing judges', () => {
  it('buildJudges returns format + correctness judges (2 total per task)', () => {
    const judges = buildJudges('H1_EXECUTE_EVAL');
    expect(judges.length).toBe(2);
    expect(judges[0]?.name).toBe('harness-format');
    expect(judges[0]?.category).toBe('format');
    expect(judges[1]?.name).toBe('harness-correct(H1_EXECUTE_EVAL)');
    expect(judges[1]?.category).toBe('correctness');
  });

  it('harness-correct judge accepts both HARNESS: and confirmed_harness= phrasings', () => {
    const judges = buildJudges('H1_EXECUTE_EVAL');
    const correctJudge = judges[1]!;
    if (!correctJudge.judge) throw new Error('expected judge function');

    expect(correctJudge.judge('Some analysis...\nHARNESS: H1_EXECUTE_EVAL\nrationale...').passed).toBe(true);
    expect(correctJudge.judge('confirmed_harness="H1_EXECUTE_EVAL"').passed).toBe(true);
    expect(correctJudge.judge('confirmed_harness=H1_EXECUTE_EVAL').passed).toBe(true);
    expect(correctJudge.judge('HARNESS: H0_DIRECT').passed).toBe(false);
    expect(correctJudge.judge('no harness here').passed).toBe(false);
  });

  it('harness-correct judge is case-insensitive on the harness id', () => {
    const judges = buildJudges('H0_DIRECT');
    const correctJudge = judges[1]!;
    if (!correctJudge.judge) throw new Error('expected judge function');

    expect(correctJudge.judge('HARNESS: h0_direct').passed).toBe(true);
    expect(correctJudge.judge('HARNESS: H0_DIRECT').passed).toBe(true);
  });
});
