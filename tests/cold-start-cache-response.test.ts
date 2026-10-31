import { expect, it } from 'vitest';
import type { KodaXStreamResult } from '../packages/llm/src/index.js';
import { captureColdStartResponse } from './cold-start-cache-response.js';

it('preserves tool-only probe responses and stop reasons while redacting nested content', () => {
  const result: KodaXStreamResult = {
    textBlocks: [],
    toolBlocks: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'fixture-secret.txt' } }],
    thinkingBlocks: [],
    stopReason: 'tool_use',
    usage: { inputTokens: 100, outputTokens: 12, totalTokens: 112, cachedReadTokens: 80 },
  };
  const record = captureColdStartResponse(result, text => text.replaceAll('fixture-secret', '[REDACTED]'));

  expect(record).toMatchObject({
    text: '',
    response: {
      toolBlocks: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { path: '[REDACTED].txt' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 100, outputTokens: 12, totalTokens: 112, cachedReadTokens: 80 },
    },
  });
  expect(JSON.stringify(record)).not.toContain('fixture-secret');
  expect(result.toolBlocks[0]!.input.path).toBe('fixture-secret.txt');
});
