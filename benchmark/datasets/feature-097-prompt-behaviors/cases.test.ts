/**
 * Hermetic shape tests for FEATURE_097 prompt-behavior dataset.
 * Zero LLM cost. Locks down dataset invariants the eval relies on.
 */
import { describe, expect, it } from 'vitest';

import {
  CASES,
  buildJudges,
  buildPromptVariants,
  type CaseId,
} from './cases.js';

const ALL_CASE_IDS: readonly CaseId[] = [
  'throttle_reminder_recovery',
  'unknown_id_recovery',
  'generator_step_progression',
  'planner_refinement',
];

describe('FEATURE_097 prompt-behaviors dataset shape', () => {
  it('exports exactly 4 cases — covers the 4 prompt eval triggers not handled by the H0 mini-planner eval', () => {
    expect(CASES.length).toBe(4);
    const ids = CASES.map((c) => c.id).sort();
    expect(ids).toEqual([...ALL_CASE_IDS].sort());
  });

  it('every case has a description and a behaviour spec', () => {
    for (const c of CASES) {
      expect(c.description.length).toBeGreaterThan(20);
      expect(c.behaviour.length).toBeGreaterThan(20);
    }
  });
});

describe('FEATURE_097 prompt-behaviors variants', () => {
  for (const caseId of ALL_CASE_IDS) {
    describe(caseId, () => {
      it('has exactly one variant labelled v0.7.34', () => {
        const variants = buildPromptVariants(caseId);
        expect(variants.length).toBe(1);
        expect(variants[0]?.id).toBe('v0.7.34');
      });

      it('system + user prompts are non-empty and well-formed', () => {
        const [variant] = buildPromptVariants(caseId);
        expect(variant?.systemPrompt.length).toBeGreaterThan(50);
        expect(variant?.userMessage.length).toBeGreaterThan(20);
      });
    });
  }
});

describe('FEATURE_097 prompt-behaviors — case-specific variant content', () => {
  it('throttle reminder includes the literal <system-reminder> wrapper used by buildTodoReminderText', () => {
    const [variant] = buildPromptVariants('throttle_reminder_recovery');
    expect(variant?.systemPrompt).toContain('<system-reminder>');
    expect(variant?.systemPrompt).toContain('</system-reminder>');
    expect(variant?.systemPrompt).toContain('You have not called todo_update in 8 iterations');
    // Pending items list must include both still-open ids so the judge
    // accepts either as the recovery target.
    expect(variant?.systemPrompt).toContain('todo_2');
    expect(variant?.systemPrompt).toContain('todo_3');
  });

  it('unknown id recovery shows the literal error reason from todo-update.ts', () => {
    const [variant] = buildPromptVariants('unknown_id_recovery');
    expect(variant?.userMessage).toContain('Unknown todo id');
    expect(variant?.userMessage).toContain('todo_99');
    expect(variant?.userMessage).toContain('Current valid ids: todo_1, todo_2, todo_3');
  });

  it('generator progression frames todo_2 as just-finished work', () => {
    const [variant] = buildPromptVariants('generator_step_progression');
    expect(variant?.userMessage.toLowerCase()).toContain('todo_2');
    expect(variant?.userMessage.toLowerCase()).toContain('finished');
  });

  it('planner refinement supplies 3 coarse obligations', () => {
    const [variant] = buildPromptVariants('planner_refinement');
    expect(variant?.systemPrompt).toContain('JWT');
    expect(variant?.systemPrompt).toContain('schema');
    expect(variant?.systemPrompt).toMatch(/integration\s+tests/i);
  });
});

describe('FEATURE_097 prompt-behaviors judges', () => {
  for (const caseId of ALL_CASE_IDS) {
    it(`${caseId} returns at least one judge`, () => {
      const judges = buildJudges(caseId);
      expect(judges.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('throttle reminder judges accept "I will call todo_update for todo_3"', () => {
    const judges = buildJudges('throttle_reminder_recovery');
    const sample = 'Got it — I will call todo_update({id:"todo_3", status:"in_progress"}) now.';
    for (const j of judges) {
      const r = j.judge(sample);
      expect(r.passed, `${j.name} reason=${r.reason}`).toBe(true);
    }
  });

  it('throttle reminder judges reject "I will keep working" (no todo_update mention)', () => {
    const judges = buildJudges('throttle_reminder_recovery');
    const sample = 'I will keep working on the next file.';
    const allPassed = judges.every((j) => j.judge(sample).passed);
    expect(allPassed).toBe(false);
  });

  it('unknown-id judges accept retry with todo_1', () => {
    const judges = buildJudges('unknown_id_recovery');
    const sample =
      'Retrying: todo_update({id:"todo_1", status:"completed"}) — todo_99 was wrong.';
    // The avoid-hallucinated-id judge fires on todo_99 mention; the sample
    // does mention todo_99 in the explanation. Verify which judges still
    // pass and which fail.
    const passes = judges.map((j) => ({ name: j.name, ...j.judge(sample) }));
    const validIdJudge = passes.find((p) => p.name === 'picks_valid_id');
    expect(validIdJudge?.passed).toBe(true);
    const mentionsToolJudge = passes.find((p) => p.name === 'mentions_todo_update');
    expect(mentionsToolJudge?.passed).toBe(true);
    // The "avoids hallucinated id" judge correctly fails — model's
    // explanation re-mentions todo_99. This is OK behavior; the judge
    // catches "regurgitates without recognizing it was wrong".
    const avoidsJudge = passes.find((p) => p.name === 'avoids_hallucinated_id');
    expect(avoidsJudge?.passed).toBe(false);
  });

  it('unknown-id judges fully accept clean retry without re-mentioning todo_99', () => {
    const judges = buildJudges('unknown_id_recovery');
    const sample =
      'Calling todo_update({id:"todo_2", status:"completed"}) instead.';
    for (const j of judges) {
      const r = j.judge(sample);
      expect(r.passed, `${j.name} reason=${r.reason}`).toBe(true);
    }
  });

  it('generator progression judges accept "marking todo_2 completed"', () => {
    const judges = buildJudges('generator_step_progression');
    const sample =
      'I will call todo_update with id=todo_2 and status=completed since the migration tests pass.';
    for (const j of judges) {
      const r = j.judge(sample);
      expect(r.passed, `${j.name} reason=${r.reason}`).toBe(true);
    }
  });

  it('generator progression judges accept "starting todo_3 in_progress"', () => {
    const judges = buildJudges('generator_step_progression');
    const sample =
      'Calling todo_update({id:"todo_3", status:"in_progress"}) to start the type definitions step.';
    for (const j of judges) {
      const r = j.judge(sample);
      expect(r.passed, `${j.name} reason=${r.reason}`).toBe(true);
    }
  });

  it('planner refinement judges accept a numbered 5-step plan', () => {
    const judges = buildJudges('planner_refinement');
    const sample = [
      '1. Implement JWT signing helper with HS256 and 24h TTL',
      '2. Add `tokenVersion` column to user schema',
      '3. Wire JWT verify middleware to /api/* routes',
      '4. Add migration for the tokenVersion column',
      '5. Write integration tests for auth + token refresh flows',
    ].join('\n');
    for (const j of judges) {
      const r = j.judge(sample);
      expect(r.passed, `${j.name} reason=${r.reason}`).toBe(true);
    }
  });

  it('planner refinement judges accept a successCriteria block', () => {
    const judges = buildJudges('planner_refinement');
    const sample = [
      'successCriteria:',
      '- JWT auth signs and verifies tokens correctly with HS256.',
      '- User schema includes the new tokenVersion column with a migration.',
      '- Integration tests cover successful login, expired token rejection.',
    ].join('\n');
    for (const j of judges) {
      const r = j.judge(sample);
      expect(r.passed, `${j.name} reason=${r.reason}`).toBe(true);
    }
  });

  it('planner refinement judges reject a vague paragraph', () => {
    const judges = buildJudges('planner_refinement');
    const sample =
      'Sure — we can add JWT auth. It involves writing some code.';
    const allPassed = judges.every((j) => j.judge(sample).passed);
    expect(allPassed).toBe(false);
  });
});
