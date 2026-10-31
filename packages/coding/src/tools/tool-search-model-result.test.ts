import { expect, it } from 'vitest';
import type { KodaXMessage, KodaXToolDefinition, KodaXToolResultBlock } from '@kodax-ai/llm';
import { getToolDefinition } from './index.js';
import { toolSearchHandler } from './tool-search.js';
import { projectToolSearchResultParameters } from './tool-search-model-result.js';

it('keeps the canonical receipt complete while reusing identical parameters already disclosed to the model', async () => {
  const receipt = await toolSearchHandler({ query: 'select:web_fetch' }, { backups: new Map() });
  const definition = getToolDefinition('web_fetch');
  if (typeof receipt !== 'string' || !definition) throw new Error('Missing canonical web contract');
  const messages: KodaXMessage[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'help', name: 'tool_search', input: { query: 'select:web_fetch' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'help', content: receipt }] },
  ];
  const before = JSON.stringify(messages);
  const projected = projectToolSearchResultParameters(messages, [definition]);
  expect(JSON.stringify(messages)).toBe(before);
  expect(receipt).toContain('"parameters":');
  const content = projected.at(-1)?.content;
  if (!Array.isArray(content) || content[0]?.type !== 'tool_result' || typeof content[0].content !== 'string') {
    throw new Error('Missing projected receipt');
  }
  expect(content[0].content).not.toContain('"parameters":');
  expect(content[0].content).toContain('follows redirects');
  expect(content[0].content).toContain('does not cache');
  expect(content[0].content).toContain('current tool contracts');
  expect(content[0].content.length).toBeLessThan(receipt.length);
});

const schema: KodaXToolDefinition = { name: 'lookup', description: 'Read an indexed item.', input_schema: {
  type: 'object', properties: { path: { type: 'string', description: 'Exact full path selected from available evidence.' },
    kind: { type: 'string', enum: ['file', 'module'], default: 'file' } }, required: ['path'],
} };
const help = `<function>${JSON.stringify({ name: schema.name, description: schema.description, parameters: schema.input_schema })}</function>`;
const exchange = (): KodaXMessage[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'query', name: 'tool_search', input: { query: 'select:lookup' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'query', content: help }] },
];
function receipt(messages: readonly KodaXMessage[]): KodaXToolResultBlock {
  const blocks = messages.at(-1)?.content;
  if (!Array.isArray(blocks) || blocks[0]?.type !== 'tool_result') throw new Error('Missing test receipt');
  return blocks[0];
}

it('reconstructs full parameters after fitting hides a tool, without changing history or discovering it again', () => {
  const canonical = exchange();
  expect(receipt(projectToolSearchResultParameters(canonical, [schema])).content).not.toContain('"parameters":');
  expect(projectToolSearchResultParameters(canonical, [])).toEqual(canonical);
  expect(projectToolSearchResultParameters(canonical.slice(1), [schema])).toEqual(canonical.slice(1));
});

it.each(['constraint', 'annotation', 'ambiguous'] as const)('preserves the complete contract when proof differs: %s', kind => {
  const changed = structuredClone(schema);
  if (kind === 'constraint') changed.input_schema.required = ['path', 'kind'];
  else changed.input_schema.properties.path = { type: 'string', description: 'A different parameter contract.' };
  const canonical = exchange();
  expect(projectToolSearchResultParameters(canonical, kind === 'ambiguous' ? [schema, changed] : [changed])).toEqual(canonical);
});

it.each(['orphan', 'duplicate-call', 'duplicate-result', 'read', 'before-call', 'error'] as const)('leaves uncertain evidence untouched: %s', kind => {
  const canonical = exchange();
  const call = canonical[0]!.content;
  const result = canonical[1]!.content;
  if (!Array.isArray(call) || !Array.isArray(result)) throw new Error('Missing test exchange');
  if (kind === 'orphan') canonical.shift();
  if (kind === 'duplicate-call') call.push({ type: 'tool_use', id: 'query', name: 'read', input: { path: 'source.ts' } });
  if (kind === 'duplicate-result') result.push({ ...receipt(canonical) });
  if (kind === 'read') call[0] = { type: 'tool_use', id: 'query', name: 'read', input: { path: 'source.ts' } };
  if (kind === 'before-call') canonical.reverse();
  if (kind === 'error') receipt(canonical).is_error = true;
  expect(projectToolSearchResultParameters(canonical, [schema])).toEqual(canonical);
});

it('keeps warnings, unmatched functions, partial JSON, images and receipt metadata', () => {
  const canonical = exchange();
  const other = '<function>{"name":"unknown","description":"Unavailable here","parameters":{}}</function>';
  const partial = '<function>{"name":"lookup"';
  const mixed = `[WARNING: incomplete catalog]\n${help}\n${other}\n${partial}\n[RESULT_LIMIT_REACHED]`;
  const image = { type: 'image' as const, mediaType: 'image/png' as const, path: 'unchanged-image.png' };
  receipt(canonical).content = [{ type: 'text', text: mixed }, image];
  receipt(canonical).metadata = { outputPath: 'full-receipt.json', truncated: true };
  const projected = receipt(projectToolSearchResultParameters(canonical, [schema]));
  expect(projected.metadata).toEqual(receipt(canonical).metadata);
  expect(Array.isArray(projected.content) && projected.content[1]).toEqual(image);
  const text = Array.isArray(projected.content) && projected.content[0]?.type === 'text' ? projected.content[0].text : '';
  for (const evidence of ['[WARNING: incomplete catalog]', other, partial, '[RESULT_LIMIT_REACHED]']) expect(text).toContain(evidence);
  expect(text).not.toContain('"default":"file"');
  expect(receipt(canonical).content).toEqual([{ type: 'text', text: mixed }, image]);
});

it('keeps zero-parameter contracts when the reference would cost more', () => {
  const small = { ...schema, input_schema: { type: 'object' as const, properties: {} } };
  const canonical = exchange();
  receipt(canonical).content = `<function>${JSON.stringify({ name: small.name, description: '', parameters: small.input_schema })}</function>`;
  expect(projectToolSearchResultParameters(canonical, [small])).toEqual(canonical);
});
