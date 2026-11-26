import { buildEvidence, renderEvidence, shouldReflect } from '@kodax-ai/agent';
import { describe, expect, it } from 'vitest';

import { REFLECT_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';
import { CAPTURE_CASES, caseOf } from './cases.js';
import { orderOf, reflectInput, score, storeCalls } from './runner.js';

describe('skill learning capture cases', () => {
  it.each(CAPTURE_CASES)('$id passes the reflection gate and shows every fact to the job', (item) => {
    expect(shouldReflect(item.session)).toBe(true);
    const evidence = renderEvidence(buildEvidence(item.session));
    for (const fact of item.facts) expect(evidence, fact.label).toMatch(fact.pattern);
    for (const trap of item.traps) expect(evidence, trap.label).toMatch(trap.pattern);
  });

  it('gives both arms the same evidence and arm N only memory_reflect', () => {
    const item = CAPTURE_CASES[0]!;
    expect(reflectInput(item, 'N').userMessage).toBe(reflectInput(item, 'S').userMessage);
    expect(reflectInput(item, 'N').tools.map((tool) => tool.name)).toEqual([REFLECT_TOOL_NAME]);
    expect(reflectInput(item, 'N').systemPrompt).not.toContain('skill_propose');
  });

  it('reads order from one stored text', () => {
    const item = { ...caseOf('k1'), order: [/alpha/, /beta/] };
    expect(orderOf(item, ['alpha then beta'])).toBe('ordered');
    expect(orderOf(item, ['beta then alpha'])).toBe('misordered');
    expect(orderOf(item, ['skips beta and alpha; real order: alpha, then beta'])).toBe('ordered');
    expect(orderOf(item, ['alpha', 'beta'])).toBe('incomplete');
  });

  it('keeps a note only through the host guards, and scores what was kept', async () => {
    const item = caseOf('k6');
    const stored = await storeCalls(item, 'N', [
      { name: REFLECT_TOOL_NAME, input: { operation: 'write', id: 'layout', type: 'project', description: 'Feature code lives in src', why: 'seen in the session' } },
      { name: REFLECT_TOOL_NAME, input: { operation: 'write', id: 'made-up', type: 'project', description: 'x', quote: 'words nobody said in this session' } },
      { name: 'skill_propose', input: { name: 'x' } },
    ], 'unit-test');
    expect(stored.notes).toHaveLength(1);
    expect(stored.trace.filter((line) => line.startsWith('REJECTED'))).toHaveLength(2);
    expect(score(item, stored)).toMatchObject({ noteCount: 1, activeNotes: 0, skillCount: 0 });
  });
});
