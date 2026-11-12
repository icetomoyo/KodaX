import { shouldReflect } from '@kodax-ai/agent';
import { describe, expect, it } from 'vitest';

import { FEATURE_306_READ_CASES } from '../feature-306-baseline/cases.js';
import { buildSessionTwo, plannedChains, TWO_BUDGET } from './runner.js';
import { SESSION_ONE, TWO_SESSION_CASE_IDS } from './sessions.js';

const userText = (id: keyof typeof SESSION_ONE): string =>
  SESSION_ONE[id].filter((message) => message.role === 'user' && typeof message.content === 'string').map((message) => message.content as string).join('\n');

describe('feature-306 two-session cases', () => {
  it('has a read case and a reflection-worthy session one for every chain', () => {
    for (const id of TWO_SESSION_CASE_IDS) {
      expect(FEATURE_306_READ_CASES.some((item) => item.id === id), id).toBe(true);
      expect(shouldReflect(SESSION_ONE[id]), id).toBe(true);
    }
  });

  it('puts the decisive detail of each read case in the user\'s own words in session one', () => {
    for (const id of TWO_SESSION_CASE_IDS) {
      const detail = FEATURE_306_READ_CASES.find((item) => item.id === id)!.decisiveDetail;
      expect(userText(id), id).toContain(detail);
    }
  });

  it('plans every alias x case x repetition inside the frozen call cap', () => {
    expect(plannedChains()).toHaveLength(42);
    expect(TWO_BUDGET.plannedCalls).toBeLessThanOrEqual(TWO_BUDGET.maxProviderCalls);
  });

  it('shows session two the note the reflection wrote, and only after it was written', async () => {
    const quote = 'tests must be run with `make check-fast`';
    const ideal = { toolCalls: [{ name: 'memory_reflect', input: { operation: 'write', id: 'test-command', type: 'feedback', description: 'Run tests with make check-fast', body: 'Bare npm test skips the integration setup.', quote } }] };
    const withNote = await buildSessionTwo('c1', ideal);
    const without = await buildSessionTwo('c1', { toolCalls: [] });
    expect(withNote.notes.map((note) => note.status)).toEqual(['active']);
    expect(withNote.input.systemPrompt + JSON.stringify(withNote.input.priorMessages)).toContain('make check-fast');
    expect(without.input.systemPrompt + JSON.stringify(without.input.priorMessages)).not.toContain('make check-fast');
  });

  it('keeps the 40-note store but drops the hand-written target note for the scale cases', async () => {
    const built = await buildSessionTwo('c6', { toolCalls: [] });
    expect(built.notes).toHaveLength(0);
    expect(built.input.systemPrompt + JSON.stringify(built.input.priorMessages)).not.toContain('make check-fast');
  });
});
