import { expect, it } from 'vitest';
import { moveVisualMethodToSystem } from './method-placement.js';

it('moves one exact method from inspection to the existing system without changing evidence, schemas or other tools', () => {
  const request = { model: 'frozen', messages: [{ role: 'system', content: 'Production' },
    { role: 'user', content: [{ type: 'text', text: 'Question' }] }], tools: [
    { type: 'function', function: { name: 'visual_inspect', description: 'Gather evidence. Inspect pixels.', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'read', description: 'Read files.', parameters: {} } },
  ], max_tokens: 2048 };
  const original = structuredClone(request);
  const moved = moveVisualMethodToSystem(request, 'Gather evidence.');
  expect(moved).toEqual({ ...request, messages: [{ role: 'system', content: 'Production\n\nGather evidence.' }, request.messages[1]],
    tools: [{ ...request.tools[0], function: { ...request.tools[0]!.function, description: 'Inspect pixels.' } }, request.tools[1]] });
  expect(request).toEqual(original);
});

it('rejects drift, duplicate guidance and ambiguous injection targets before producing an ablation', () => {
  const request = { messages: [{ role: 'system', content: 'Production' }], tools: [
    { function: { name: 'visual_inspect', description: 'Gather evidence. Inspect pixels.' } },
  ] };
  const variants = [
    {}, { ...request, tools: [] }, { ...request, messages: [] },
    { ...request, messages: [...request.messages, ...request.messages] },
    { ...request, tools: [...request.tools, ...request.tools] },
    { ...request, messages: [{ role: 'system', content: 'Gather evidence.' }] },
    { ...request, tools: [{ function: { name: 'visual_inspect', description: 'Changed. Inspect pixels.' } }] },
    { ...request, tools: [...request.tools, { function: { name: 'other', description: 'Gather evidence.' } }] },
  ];
  for (const variant of variants) expect(() => moveVisualMethodToSystem(variant, 'Gather evidence.')).toThrow('Frozen');
  expect(() => moveVisualMethodToSystem(request, '')).toThrow('Frozen');
});
