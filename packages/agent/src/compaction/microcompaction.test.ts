import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax/ai';
import { microcompact, DEFAULT_MICROCOMPACTION_CONFIG } from './microcompaction.js';

function createTextMessage(role: KodaXMessage['role'], content: string): KodaXMessage {
  return { role, content };
}

function createToolUseMessage(
  toolName: string,
  toolId: string,
  input: Record<string, unknown> = {},
): KodaXMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input,
      },
    ],
  };
}

function createToolResultMessage(
  toolUseId: string,
  content: string,
): KodaXMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
      },
    ],
  };
}

/** Generate N turns of filler to push earlier messages past maxAge. */
function filler(n: number): KodaXMessage[] {
  return Array(n).fill(null).flatMap((_, i) => [
    createTextMessage('user', `task ${i}`),
    createTextMessage('assistant', `response ${i}`),
  ]);
}

describe('microcompaction', () => {
  it('returns the same array when disabled', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'hello'),
      createToolUseMessage('read', 'tool_1', { path: 'src/auth.ts' }),
      createToolResultMessage('tool_1', 'file content'),
      createTextMessage('user', 'follow-up'),
    ];

    const config = { enabled: false, maxAge: 20, protectedTools: [] as string[] };
    const result = microcompact(messages, config);

    expect(result).toBe(messages);
  });

  it('returns the same array for empty messages', () => {
    const messages: KodaXMessage[] = [];
    const result = microcompact(messages);

    expect(result).toBe(messages);
  });

  it('returns the same array when no compaction is needed', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'hello'),
      createToolUseMessage('read', 'tool_1', { path: 'src/auth.ts' }),
      createToolResultMessage('tool_1', 'file content'),
      createTextMessage('assistant', 'response'),
    ];

    const result = microcompact(messages, {
      enabled: true,
      maxAge: 20,
      protectedTools: [],
    });

    expect(result).toBe(messages);
  });

  it('clears tool result content older than maxAge turns', () => {
    const messages: KodaXMessage[] = [
      // Turn 0
      createTextMessage('user', 'task 1'),
      createToolUseMessage('read', 'tool_1', { path: 'src/auth.ts' }),
      createToolResultMessage('tool_1', 'original content 1'),
      // Turn 1
      createTextMessage('user', 'task 2'),
      createToolUseMessage('read', 'tool_2', { path: 'src/main.ts' }),
      createToolResultMessage('tool_2', 'original content 2'),
      createTextMessage('assistant', 'response'),
    ];

    const result = microcompact(messages, {
      enabled: true,
      maxAge: 1,
      protectedTools: [],
    });

    // Tool result at index 2 (turn 0) should be cleared with rich preview
    const resultBlock = (result[2]?.content as { content: string }[])[0];
    expect(resultBlock?.content).toContain('[Cleared:');
    expect(resultBlock?.content).toContain('read');
    expect(resultBlock?.content).toContain('auth.ts');

    // Tool result at index 5 (turn 1) should NOT be cleared (age < maxAge)
    const recentBlock = (result[5]?.content as { content: string }[])[0];
    expect(recentBlock?.content).toBe('original content 2');
  });

  it('generates rich preview for bash commands', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'task 1'),
      createToolUseMessage('bash', 'tool_1', { command: 'git status --porcelain' }),
      createToolResultMessage('tool_1', 'M src/auth.ts\nM src/main.ts'),
      ...filler(30),
    ];

    const result = microcompact(messages, { enabled: true, maxAge: 1, protectedTools: [] });
    const block = (result[2]?.content as { content: string }[])[0];
    expect(block?.content).toContain('[Cleared:');
    expect(block?.content).toContain('git');
  });

  it('generates rich preview for grep with pattern', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'task 1'),
      createToolUseMessage('grep', 'tool_1', { path: 'src/auth.ts', pattern: 'validateToken' }),
      createToolResultMessage('tool_1', 'line 42: export function validateToken'),
      ...filler(30),
    ];

    const result = microcompact(messages, { enabled: true, maxAge: 1, protectedTools: [] });
    const block = (result[2]?.content as { content: string }[])[0];
    expect(block?.content).toContain('[Cleared:');
    expect(block?.content).toContain('grep');
    expect(block?.content).toContain('auth.ts');
    expect(block?.content).toContain('validateToken');
  });

  it('does not clear protected tools', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'ask a question'),
      createToolUseMessage('ask_user_question', 'tool_1'),
      createToolResultMessage('tool_1', 'user response'),
      ...filler(40),
    ];

    const result = microcompact(messages, {
      enabled: true,
      maxAge: 1,
      protectedTools: ['ask_user_question'],
    });

    const protectedBlock = (result[2]?.content as { content: string }[])[0];
    expect(protectedBlock?.content).toBe('user response');
  });

  it('does not re-process already-cleared results', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'task 1'),
      createToolUseMessage('read', 'tool_1', { path: 'src/auth.ts' }),
      {
        role: 'user',
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tool_1',
            content: '[Cleared: read auth.ts]',
          },
        ],
      },
      ...filler(30),
    ];

    const result = microcompact(messages, {
      enabled: true,
      maxAge: 1,
      protectedTools: [],
    });

    const block = (result[2]?.content as { content: string }[])[0];
    expect(block?.content).toBe('[Cleared: read auth.ts]');
  });

  it('also skips already-pruned results', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'task 1'),
      createToolUseMessage('read', 'tool_1', { path: 'src/auth.ts' }),
      {
        role: 'user',
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tool_1',
            content: '[Pruned: read auth.ts]',
          },
        ],
      },
      ...filler(30),
    ];

    const result = microcompact(messages, { enabled: true, maxAge: 1, protectedTools: [] });
    const block = (result[2]?.content as { content: string }[])[0];
    expect(block?.content).toBe('[Pruned: read auth.ts]');
  });

  it('does not mutate the input messages array', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'task 1'),
      createToolUseMessage('read', 'tool_1', { path: 'src/auth.ts' }),
      createToolResultMessage('tool_1', 'original content'),
      ...filler(30),
    ];

    const originalContent = JSON.stringify(messages[2]);

    microcompact(messages, {
      enabled: true,
      maxAge: 1,
      protectedTools: [],
    });

    expect(JSON.stringify(messages[2])).toBe(originalContent);
  });

  it('respects DEFAULT_MICROCOMPACTION_CONFIG', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'task 1'),
      createToolUseMessage('read', 'tool_1', { path: 'src/auth.ts' }),
      createToolResultMessage('tool_1', 'original content'),
      ...filler(50),
    ];

    const result = microcompact(messages);

    const block = (result[2]?.content as { content: string }[])[0];
    expect(block?.content).toContain('[Cleared:');
  });

  it('handles messages with string content (no tool results)', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'hello'),
      createTextMessage('assistant', 'hi'),
      createTextMessage('user', 'how are you'),
    ];

    const result = microcompact(messages, {
      enabled: true,
      maxAge: 1,
      protectedTools: [],
    });

    expect(result).toBe(messages);
  });

  it('clears multiple tool results in the same message', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'task 1'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'read', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'tool_2', name: 'read', input: { path: 'b.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'content 1' },
          { type: 'tool_result', tool_use_id: 'tool_2', content: 'content 2' },
        ],
      },
      ...filler(30),
    ];

    const result = microcompact(messages, { enabled: true, maxAge: 1, protectedTools: [] });
    const blocks = result[2]?.content as { content: string }[];
    expect(blocks[0]?.content).toContain('[Cleared:');
    expect(blocks[1]?.content).toContain('[Cleared:');
  });

  it('handles mixed content blocks (text + tool results)', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'task 1'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read the file:' },
          { type: 'tool_use', id: 'tool_1', name: 'read', input: { path: 'src/auth.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is the result:' },
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'file content' },
        ],
      },
      ...filler(30),
    ];

    const result = microcompact(messages, { enabled: true, maxAge: 1, protectedTools: [] });
    const blocks = result[2]?.content as { type: string; text?: string; content?: string }[];
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[0]?.text).toBe('Here is the result:');
    expect(blocks[1]?.content).toContain('[Cleared:');
    expect(blocks[1]?.content).toContain('auth.ts');
  });

  it('correctly identifies tool names from preceding tool_use blocks', () => {
    const messages: KodaXMessage[] = [
      createTextMessage('user', 'task'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'custom_tool_name', input: {} },
        ],
      },
      createToolResultMessage('tool_1', 'result'),
      ...filler(30),
    ];

    const result = microcompact(messages, { enabled: true, maxAge: 1, protectedTools: [] });
    const block = (result[2]?.content as { content: string }[])[0];
    expect(block?.content).toContain('custom_tool_name');
  });
});
