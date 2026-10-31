import { expect, it } from 'vitest';
import { reconcileAssistantContent } from './assistant-content.js';
import type { KodaXAssistantBlock, KodaXToolUseBlock } from './types.js';

it('keeps native order while applying tool repairs and visibility filtering', () => {
  const old: KodaXToolUseBlock = { type: 'tool_use', id: 'a', name: 'bad', input: {} };
  const thinking = { type: 'thinking' as const, thinking: 'reason' };
  const text = { type: 'text' as const, text: 'visible' };
  const ordered: KodaXAssistantBlock[] = [text, old, thinking, { ...old, id: 'hidden' }];
  expect(reconcileAssistantContent(ordered, { textBlocks: [text], thinkingBlocks: [thinking], toolBlocks: [{ ...old, name: 'read' }] }))
    .toEqual([text, { ...old, name: 'read' }, thinking]);
});
it('cannot bypass sanitized text or inject removed tools through the ordered side channel', () => {
  const ordered: KodaXAssistantBlock[] = [{ type: 'text', text: 'unsafe' }, { type: 'tool_use', id: 'x', name: 'write', input: {} }, { type: 'text', text: 'secret' }];
  expect(reconcileAssistantContent(ordered, { textBlocks: [{ text: 'safe' }], toolBlocks: [] }))
    .toEqual([{ type: 'text', text: 'safe' }]);
});
it('does not invent original ordering for legacy results', () => {
  expect(reconcileAssistantContent(undefined, { textBlocks: [{ text: 'text' }], thinkingBlocks: [{ type: 'thinking', thinking: 'thought' }] }))
    .toEqual([{ type: 'thinking', thinking: 'thought' }, { type: 'text', text: 'text' }]);
});
it('keeps interleaved tool positions when sanitation removes an internal text suffix', () => {
  const tool = { type: 'tool_use' as const, id: 't', name: 'read', input: {} };
  const ordered: KodaXAssistantBlock[] = [{ type: 'text', text: 'before' }, tool, { type: 'text', text: 'after\nTool policy: secret' }];
  expect(reconcileAssistantContent(ordered, { textBlocks: [{ text: 'beforeafter\n' }], toolBlocks: [tool] }))
    .toEqual([{ type: 'text', text: 'before' }, tool, { type: 'text', text: 'after\n' }]);
});

it('preserves native custom provenance only for unchanged authoritative tool calls', () => {
  const original: KodaXToolUseBlock = { type: 'tool_use', id: 'call', name: 'query', input: { sql: 'SELECT 1' },
    customTool: { property: 'sql', source: { provider: 'p', api: 'openai-responses', model: 'm', baseUrl: 'https://p.example' } } };
  const plain: KodaXToolUseBlock = { type: 'tool_use', id: 'call', name: 'query', input: { sql: 'SELECT 1' } };
  expect(reconcileAssistantContent([original], { toolBlocks: [plain] })[0]).toEqual(original);
  expect(reconcileAssistantContent([original], { toolBlocks: [{ ...plain, input: { sql: 'SELECT 2' } }] })[0]).not.toHaveProperty('customTool');
  expect(reconcileAssistantContent([original], { toolBlocks: [{ ...plain, name: 'other' }] })[0]).not.toHaveProperty('customTool');
});
