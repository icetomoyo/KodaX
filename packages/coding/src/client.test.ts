import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KodaXContextTokenSnapshot,
  KodaXMessage,
  KodaXResult,
} from './types.js';

const mocks = vi.hoisted(() => ({
  runKodaX: vi.fn(),
}));

vi.mock('./task-engine.js', () => ({
  runKodaX: mocks.runKodaX,
}));

import { KodaXClient } from './client.js';

function createResult(
  messages: KodaXMessage[],
  contextTokenSnapshot?: KodaXContextTokenSnapshot,
): KodaXResult {
  return {
    success: true,
    lastText: 'ok',
    messages,
    sessionId: 'session-1',
    contextTokenSnapshot,
  };
}

describe('KodaXClient', () => {
  beforeEach(() => {
    mocks.runKodaX.mockReset();
  });

  it('seeds the first request from configured initial messages', async () => {
    const initialMessages: KodaXMessage[] = [
      { role: 'user', content: 'existing user message' },
      { role: 'assistant', content: 'existing assistant reply' },
    ];

    mocks.runKodaX.mockResolvedValueOnce(createResult(initialMessages));

    const client = new KodaXClient({
      provider: 'test-provider',
      session: {
        id: 'session-1',
        initialMessages,
      },
    });

    expect(client.getMessages()).toEqual(initialMessages);

    await client.send('follow-up prompt');

    expect(mocks.runKodaX).toHaveBeenCalledTimes(1);
    expect(mocks.runKodaX.mock.calls[0]?.[0].session?.initialMessages).toEqual(initialMessages);
  });

  it('reuses the latest conversation history and token snapshot on later sends', async () => {
    const firstMessages: KodaXMessage[] = [
      { role: 'user', content: 'first prompt' },
      { role: 'assistant', content: 'first answer' },
    ];
    const secondMessages: KodaXMessage[] = [
      ...firstMessages,
      { role: 'user', content: 'second prompt' },
      { role: 'assistant', content: 'second answer' },
    ];
    const firstSnapshot: KodaXContextTokenSnapshot = {
      currentTokens: 123,
      baselineEstimatedTokens: 120,
      source: 'api',
      usage: {
        inputTokens: 120,
        outputTokens: 3,
        totalTokens: 123,
      },
    };
    const secondSnapshot: KodaXContextTokenSnapshot = {
      currentTokens: 150,
      baselineEstimatedTokens: 147,
      source: 'api',
      usage: {
        inputTokens: 147,
        outputTokens: 3,
        totalTokens: 150,
      },
    };

    mocks.runKodaX
      .mockResolvedValueOnce(createResult(firstMessages, firstSnapshot))
      .mockResolvedValueOnce(createResult(secondMessages, secondSnapshot));

    const client = new KodaXClient({ provider: 'test-provider' });

    await client.send('first prompt');
    await client.send('second prompt');

    expect(mocks.runKodaX).toHaveBeenCalledTimes(2);
    expect(mocks.runKodaX.mock.calls[1]?.[0].session?.initialMessages).toEqual(firstMessages);
    expect(mocks.runKodaX.mock.calls[1]?.[0].context?.contextTokenSnapshot).toEqual(firstSnapshot);
    expect(client.getMessages()).toEqual(secondMessages);
  });
});
