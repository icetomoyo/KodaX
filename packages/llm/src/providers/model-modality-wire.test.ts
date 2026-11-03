import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider, type KodaXMessage } from '../index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['anthropic', 'openai'] as const)('projects historical images for the selected %s model without changing canonical history', async protocol => {
  vi.stubEnv('MODEL_MODALITY_KEY', 'offline');
  const wires: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    wires.push(String(init?.body));
    return Response.json(protocol === 'anthropic'
      ? { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }
      : { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] });
  }));
  const provider = createCustomProvider({ name: 'model-modality', protocol, model: 'vision',
    models: [{ id: 'text', multimodalSupport: 'none' }], imageInput: true,
    baseUrl: 'https://modality.example/v1', apiKeyEnv: 'MODEL_MODALITY_KEY', maxOutputTokens: 100 });
  const image = { type: 'image' as const, path: path.resolve('tests/fixtures/images/valid-png.png'), mediaType: 'image/png' };
  const messages: KodaXMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Inspect this.' }, image] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'image-read', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image-read', content: [
      { type: 'text', text: 'Recorded evidence.' }, image,
    ] }] },
  ];
  const original = structuredClone(messages);
  await provider.complete(messages, [], '', undefined, { modelOverride: 'text' });
  await provider.complete(messages, [], '', undefined, { modelOverride: 'vision' });
  expect(wires[0]).not.toMatch(/"type":"image(?:_url)?"/);
  expect(wires[0]).toContain('Image content omitted');
  expect(wires[0]).toContain('Recorded evidence.');
  expect(wires[1]).toMatch(/"type":"image(?:_url)?"/);
  expect(messages).toEqual(original);
});
