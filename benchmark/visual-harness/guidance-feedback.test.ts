import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { useInspectionContract, appendToolFeedback } from './guidance-feedback.js';

it('changes only the production inspection description and refuses a schema-changing comparison', () => {
  const request = { model: 'kimi-for-coding', messages: [{ role: 'user', content: 'Question' }], tools: [
    { type: 'function', function: { name: 'visual_inspect', description: 'Before', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'read', description: 'Unchanged', parameters: {} } },
  ] };
  const after = useInspectionContract(request, { name: 'visual_inspect', description: 'After', input_schema: { type: 'object', properties: {} } });
  expect(after).toEqual({ ...request, tools: [{ ...request.tools[0], function: { ...request.tools[0]!.function, description: 'After' } }, request.tools[1]] });
  expect(request.tools[0]!.function.description).toBe('Before');
  expect(() => useInspectionContract(request, { name: 'visual_inspect', description: 'After', input_schema: { type: 'object', properties: { extra: { type: 'string' } } } })).toThrow('schema');
});

it('refuses missing or ambiguous contracts and orphan feedback before changing the transport', async () => {
  const definition = { name: 'visual_inspect', description: 'Production', input_schema: { type: 'object' as const, properties: {} } };
  expect(() => useInspectionContract({}, definition)).toThrow('contract');
  expect(() => useInspectionContract({ tools: [] }, { ...definition, name: 'read' })).toThrow('contract');
  expect(() => useInspectionContract({ tools: [] }, definition)).toThrow('schema');
  const tool = { function: { name: 'visual_inspect', parameters: definition.input_schema } };
  expect(() => useInspectionContract({ tools: [tool, tool] }, definition)).toThrow('schema');
  const originalFetch = globalThis.fetch;
  const reply = { content: '', tool_calls: [{ id: 'expected', type: 'function' as const, function: { name: 'visual_inspect', arguments: '{}' } }] };
  await expect(appendToolFeedback({}, reply, [{ id: 'expected', content: 'Missing prefix' }])).rejects.toThrow('ordered real result');
  await expect(appendToolFeedback({ messages: [] }, { content: 'No proposal' }, [])).rejects.toThrow('ordered real result');
  await expect(appendToolFeedback({ messages: [] }, reply, [])).rejects.toThrow('ordered real result');
  await expect(appendToolFeedback({ messages: [] }, reply, [{ id: 'wrong', content: 'Wrong occurrence' }])).rejects.toThrow('ordered real result');
  expect(globalThis.fetch).toBe(originalFetch);
});

it('preserves a real tool failure without fabricating evidence and restores an existing serialization key', async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.KODAX_VISUAL_SERIALIZATION_KEY;
  const request = { messages: [{ role: 'user', content: 'Recheck the old observation.' }], tools: [] };
  try {
    process.env.KODAX_VISUAL_SERIALIZATION_KEY = 'existing-local-value';
    const next = await appendToolFeedback(request, { content: '', tool_calls: [
      { id: 'failed-view', type: 'function', function: { name: 'visual_inspect', arguments: '{}' } },
    ] }, [{ id: 'failed-view', content: '[Tool Error] Original observation is unavailable.', isError: true }]);
    expect(next.messages).toEqual([...request.messages,
      { role: 'assistant', content: null, tool_calls: [{ id: 'failed-view', type: 'function',
        function: { name: 'visual_inspect', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'failed-view', content: '[Tool Error] Original observation is unavailable.' },
    ]);
    expect(request.messages).toEqual([{ role: 'user', content: 'Recheck the old observation.' }]);
    expect(globalThis.fetch).toBe(originalFetch);
    expect(process.env.KODAX_VISUAL_SERIALIZATION_KEY).toBe('existing-local-value');
  } finally {
    if (previousKey === undefined) delete process.env.KODAX_VISUAL_SERIALIZATION_KEY;
    else process.env.KODAX_VISUAL_SERIALIZATION_KEY = previousKey;
  }
});

it('retains an SDK image I/O failure and restores the transport instead of returning invented feedback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-guidance-feedback-io-'));
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.KODAX_VISUAL_SERIALIZATION_KEY;
  try {
    await expect(appendToolFeedback({ messages: [] }, { content: '', tool_calls: [
      { id: 'unreadable-view', type: 'function', function: { name: 'visual_inspect', arguments: '{}' } },
    ] }, [{ id: 'unreadable-view', content: [{ type: 'image', path: directory, mediaType: 'image/png' }] }])).rejects.toThrow();
    expect(globalThis.fetch).toBe(originalFetch);
    expect(process.env.KODAX_VISUAL_SERIALIZATION_KEY).toBe(previousKey);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('uses the real SDK serializer to preserve ordered tool results, image bytes and pixel text in the next request', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-guidance-feedback-test-'));
  const originalFetch = globalThis.fetch;
  try {
    const bytes = await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/png');
    const file = path.join(directory, 'crop.png'); await writeFile(file, bytes);
    const request = { model: 'kimi-for-coding', messages: [{ role: 'system', content: 'Frozen production system' }], tools: [] };
    const next = await appendToolFeedback(request, { content: 'Checking.', tool_calls: [
      { id: 'crop-1', type: 'function', function: { name: 'visual_inspect', arguments: '{}' } },
      { id: 'pixels-2', type: 'function', function: { name: 'visual_read_pixels', arguments: '{}' } },
    ] }, [
      { id: 'crop-1', content: [{ type: 'text', text: 'Actual selected crop' }, { type: 'image', path: file, mediaType: 'image/png' }] },
      { id: 'pixels-2', content: '{"sampleY":[170,171,172],"indices":[[0],[0],[1]]}' },
    ]);
    const wire = JSON.stringify(next.messages);
    expect(wire).toContain(bytes.toString('base64'));
    expect(wire).toContain('sampleY');
    expect(wire.indexOf('crop-1')).toBeLessThan(wire.indexOf('pixels-2'));
    expect((next.messages as { role: string }[]).filter(item => item.role === 'tool')).toHaveLength(2);
    expect((next.messages as unknown[])[0]).toEqual(request.messages[0]);
    expect(globalThis.fetch).toBe(originalFetch);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
