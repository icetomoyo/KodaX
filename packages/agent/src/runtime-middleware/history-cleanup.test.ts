import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';

import { validateAndFixToolHistory } from './history-cleanup.js';

// De-identified minimal topology of the compaction-split transcript: an
// internal managed context envelope landed between an assistant's tool calls
// and the user message that carries their results.
const assistantWithTwoCalls: KodaXMessage = {
  role: 'assistant',
  content: [
    { type: 'text', text: 'checking both files' },
    { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a.txt' } },
    { type: 'tool_use', id: 'call_b', name: 'read', input: { path: 'b.txt' } },
  ],
};
const managedContext: KodaXMessage = {
  role: 'user',
  content: 'managed task context',
  _synthetic: true,
  _source: 'managed-run-context',
};
const twoResults: KodaXMessage = {
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: 'call_a', content: 'alpha' },
    { type: 'tool_result', tool_use_id: 'call_b', content: 'beta' },
  ],
};

describe('validateAndFixToolHistory pairing scope', () => {
  it('keeps calls whose results are separated by an internal context message', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'inspect the files' },
      assistantWithTwoCalls,
      managedContext,
      twoResults,
    ];

    const fixed = validateAndFixToolHistory(messages);

    // Results move next to their calls; the context envelope follows them.
    expect(fixed).toEqual([
      messages[0],
      assistantWithTwoCalls,
      twoResults,
      managedContext,
    ]);
    expect(fixed[3]).toBe(managedContext);
  });

  it('leaves an adjacent call/result pair untouched', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'inspect the files' },
      assistantWithTwoCalls,
      twoResults,
      managedContext,
    ];

    expect(validateAndFixToolHistory(messages)).toEqual(messages);
  });

  it('keeps results split across several carriers in the same scope', () => {
    const resultA: KodaXMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'alpha' }],
    };
    const resultB: KodaXMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_b', content: 'beta' }],
    };
    const messages: KodaXMessage[] = [assistantWithTwoCalls, resultA, managedContext, resultB];

    expect(validateAndFixToolHistory(messages)).toEqual([
      assistantWithTwoCalls,
      resultA,
      resultB,
      managedContext,
    ]);
  });

  it('still strips calls and results that have no partner in their scope', () => {
    const messages: KodaXMessage[] = [
      assistantWithTwoCalls,
      managedContext,
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_a', content: 'alpha' },
          { type: 'tool_result', tool_use_id: 'call_foreign', content: 'stale' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_b', content: 'late' }],
      },
    ];

    const fixed = validateAndFixToolHistory(messages);

    expect(fixed).toEqual([
      {
        ...assistantWithTwoCalls,
        content: [
          { type: 'text', text: 'checking both files' },
          { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a.txt' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'alpha' }],
      },
      managedContext,
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      // A result belongs to the scope of the latest assistant; a later
      // assistant closes the earlier scope.
      { role: 'user', content: [{ type: 'text', text: '' }] },
    ]);
  });

  it('does not mutate its input', () => {
    const messages: KodaXMessage[] = [assistantWithTwoCalls, managedContext, twoResults];
    const snapshot = structuredClone(messages);

    validateAndFixToolHistory(messages);

    expect(messages).toEqual(snapshot);
  });
});
