import { expect, it } from 'vitest';
import { buildAssistantMessageFromLlmResult } from './runner-tool-loop.js';

it('commits Responses order while honoring final tool filtering and text sanitation', () => {
  const thinking = { type: 'thinking' as const, thinking: '', responsesReasoning: {
    source: { provider: 'test', api: 'openai-responses' as const, model: 'm' }, id: 'rs1', summary: [], encrypted_content: 'cipher' } };
  const message = buildAssistantMessageFromLlmResult({ text: 'safe', thinkingBlocks: [thinking], toolCalls: [],
    contentBlocks: [{ type: 'text', text: 'unsafe' }, thinking, { type: 'tool_use', id: 'x', name: 'hidden', input: {} }] });
  expect(message.content).toEqual([{ type: 'text', text: 'safe' }, thinking]);
});
