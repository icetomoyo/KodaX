import { expect, it } from 'vitest';
import { compactTeachingInput, controlledResults, semanticProbeEvidence } from './compact-teaching-eval-support.js';
import type { FrozenInput } from './first-turn-eval-support.js';

const input: FrozenInput = {
  system: 'host\nORIGINAL\nskills',
  tools: [{ name: 'read', description: 'Exact production contract stays here', input_schema: { type: 'object', properties: {} } }],
  messages: [{ role: 'user', content: 'Keep ORIGINAL in the task unchanged' }],
};

it('changes exactly the intended stable prompt, retaining tools and history byte for byte', () => {
  const result = compactTeachingInput(input, 'ORIGINAL', 'COMPACT');
  expect(result.system).toBe('host\nCOMPACT\nskills');
  expect(result.tools).toBe(input.tools);
  expect(result.messages).toBe(input.messages);
  expect(input.system).toBe('host\nORIGINAL\nskills');
});

it.each(['missing', 'ORIGINAL\nORIGINAL'])('refuses stale or ambiguous capture %s', system => {
  expect(() => compactTeachingInput({ ...input, system }, 'ORIGINAL', 'COMPACT')).toThrow();
});

it('never invents results or executes an unexpected recovery action', () => {
  const call = { type: 'tool_use' as const, id: 'unsafe', name: 'bash', input: { command: 'unexpected' } };
  expect(() => controlledResults([call], [{ name: 'read', input: { path: 'src/cache.js' }, content: 'fixture' }])).toThrow('Unregistered');
  expect(call.input).toEqual({ command: 'unexpected' });
});

it('matches exact tool arguments and preserves error feedback, without rewriting arguments', () => {
  const action = { name: 'read', input: { path: '../outside' }, content: 'Access denied', is_error: true };
  const call = { type: 'tool_use' as const, id: 'denied', name: 'read', input: action.input };
  expect(controlledResults([call], [action])).toEqual([{ type: 'tool_result', tool_use_id: 'denied', content: 'Access denied', is_error: true }]);
  expect(() => controlledResults([{ ...call, input: { path: 'src/../outside' } }], [action])).toThrow('Unregistered');
});

it('keeps semantic evidence but excludes token and latency clues before unblinding', () => {
  const evidence = semanticProbeEvidence({ text: 'Actual test failed', toolCalls: [], thinking: [], stopReason: 'end_turn',
    error: null, usage: { inputTokens: 15505 }, referenceUsd: 0.01, durationMs: 42 });
  expect(evidence).toEqual({ text: 'Actual test failed', toolCalls: [], thinking: [], stopReason: 'end_turn', error: null });
  expect(JSON.stringify(evidence)).not.toMatch(/15505|referenceUsd|durationMs|usage/);
});
