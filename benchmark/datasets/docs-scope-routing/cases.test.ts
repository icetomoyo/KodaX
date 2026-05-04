/**
 * Hermetic shape test for the docs-scope-routing dataset.
 * Does NOT call any LLM — that lives in tests/feature-112-docs-scope-routing.eval.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  DOCS_SCOPE_TASKS,
  buildJudges,
  buildPromptVariants,
  type DocsTaskClass,
  type DocsVariantId,
} from './cases.js';

describe('docs-scope-routing dataset shape', () => {
  it('exposes exactly 2 task cases (shallow + deep corners of the docs-only branch)', () => {
    expect(DOCS_SCOPE_TASKS.length).toBe(2);
  });

  it('all case ids are unique', () => {
    const ids = DOCS_SCOPE_TASKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every case has a non-empty userMessage and description', () => {
    for (const c of DOCS_SCOPE_TASKS) {
      expect(c.userMessage.length).toBeGreaterThan(20);
      expect(c.description.length).toBeGreaterThan(10);
    }
  });

  it('shallow case is the only H0 case', () => {
    const h0 = DOCS_SCOPE_TASKS.filter((c) => c.expectedHarness === 'H0_DIRECT');
    expect(h0.length).toBe(1);
    expect(h0[0]?.taskClass).toBe('docs-shallow');
  });

  it('deep case expects H1 (not H2 — docs-only never escalates to H2)', () => {
    const deep = DOCS_SCOPE_TASKS.filter((c) => c.taskClass === 'docs-deep');
    expect(deep.length).toBe(1);
    expect(deep[0]?.expectedHarness).toBe('H1_EXECUTE_EVAL');
    const ids = DOCS_SCOPE_TASKS.map((c) => c.expectedHarness);
    expect(ids).not.toContain('H2_PLAN_EXECUTE_EVAL');
  });

  it('every taskClass label appears exactly once', () => {
    const counts = new Map<DocsTaskClass, number>();
    for (const c of DOCS_SCOPE_TASKS) {
      counts.set(c.taskClass, (counts.get(c.taskClass) ?? 0) + 1);
    }
    for (const [, count] of counts) {
      expect(count).toBe(1);
    }
  });
});

describe('docs-scope-routing variants', () => {
  it('buildPromptVariants returns one PromptVariant per requested id', () => {
    const task = DOCS_SCOPE_TASKS[0]!;
    const variantIds: readonly DocsVariantId[] = ['current_v0733', 'feature_112_anchor'];
    const variants = buildPromptVariants(task, variantIds);
    expect(variants.length).toBe(2);
    expect(variants.map((v) => v.id)).toEqual(['current_v0733', 'feature_112_anchor']);
    for (const v of variants) {
      expect(v.systemPrompt.length).toBeGreaterThan(100);
      expect(v.userMessage).toBe(task.userMessage);
    }
  });

  it('feature_112_anchor variant carries the explicit Default-is-H0 anchor', () => {
    const task = DOCS_SCOPE_TASKS[0]!;
    const [, anchor] = buildPromptVariants(task, ['current_v0733', 'feature_112_anchor']);
    expect(anchor?.systemPrompt).toContain('Default harness is H0_DIRECT');
  });
});

describe('docs-scope-routing judges', () => {
  it('buildJudges returns format + correctness judges (2 total per task)', () => {
    const judges = buildJudges('H0_DIRECT');
    expect(judges.length).toBe(2);
    expect(judges[0]?.name).toBe('harness-format');
    expect(judges[0]?.category).toBe('format');
    expect(judges[1]?.name).toBe('harness-correct(H0_DIRECT)');
    expect(judges[1]?.category).toBe('correctness');
  });
});
