import { expect, it } from 'vitest';
import { prepareAnthropicNativeHistory, restoreAnthropicNativeHistory } from './anthropic-native-history.js';
import type { KodaXMessage, KodaXGenerationSource } from '../types.js';

const source: KodaXGenerationSource = { provider: 'anthropic', api: 'anthropic-messages', model: 'claude-opus-5-5', credentialScope: 'account-a' };
const content = [{ type: 'thinking' as const, thinking: '', signature: 'signed' }, { type: 'text' as const, text: 'done' }];
it('keeps an immutable prefix across restore, system/tools/suffix/effort changes and zero-tool bootstrap', () => {
  const messages: KodaXMessage[] = [{ role: 'user', content: 'hello' }];
  const first = prepareAnthropicNativeHistory(messages, source, undefined, {
    system: 'system one', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'data reminder' }] }],
    output_config: { effort: 'high' },
  });
  const nativeHistory = first.finish(first.request, content, content);
  messages.push({ role: 'assistant', content, nativeHistory }, { role: 'user', content: 'next' });
  const restored = restoreAnthropicNativeHistory(JSON.parse(JSON.stringify(messages)) as KodaXMessage[], source)!;
  expect(restored.start).toBe(2);
  const tool = { name: 'read', description: 'read', input_schema: { type: 'object' } };
  const second = prepareAnthropicNativeHistory(messages, source, restored, {
    system: 'system two', tools: [tool], messages: [{ role: 'user', content: 'next' }], output_config: { effort: 'low' },
  });
  expect(second.request.system).toBe('system one'); expect(second.request.tools).toEqual([]);
  const wire = second.request.messages as Record<string, unknown>[];
  expect(wire.slice(0, 2)).toEqual([...(first.request.messages as unknown[]), { role: 'assistant', content }]);
  expect(wire.at(-1)).toMatchObject({ role: 'system', content: expect.arrayContaining([
    { type: 'tool_addition', tool: { type: 'tool_definition', definition: tool } }, { type: 'text', text: expect.stringContaining('system two') },
  ]) });
  const history = second.finish(second.request, content, content);
  expect(history.baseline).toBeUndefined(); expect(history.append).toHaveLength(2);
  messages.push({ role: 'assistant', content, nativeHistory: history });
  expect(restoreAnthropicNativeHistory(messages, source)?.start).toBe(4);
});

it('refuses foreign, edited, missing-parent or corrupt fragments and never resurrects transformed thinking', () => {
  const messages: KodaXMessage[] = [{ role: 'user', content: 'hello' }];
  const first = prepareAnthropicNativeHistory(messages, source, undefined, { system: '', messages: [{ role: 'user', content: 'hello' }] });
  const history = first.finish(first.request, content, content, [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }]);
  messages.push({ role: 'assistant', content, nativeHistory: history });
  expect(restoreAnthropicNativeHistory(messages, { ...source, credentialScope: 'account-b' })).toBeUndefined();
  expect(restoreAnthropicNativeHistory([{ ...messages[0]!, content: 'edited' }, messages[1]!], source)).toBeUndefined();
  const restored = restoreAnthropicNativeHistory(messages, source)!;
  expect(restored.messages).toEqual([{ role: 'user', content: 'hello' }, { role: 'assistant', content }]);
  history.id = 'forged'; expect(restoreAnthropicNativeHistory(messages, source)).toBeUndefined();
});
