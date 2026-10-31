/**
 * Contract test for CAP-014: microcompact per-turn cleanup
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-014-microcompact-per-turn-cleanup
 *
 * Test obligations (reformulated to match the actual implementation):
 * - CAP-MICROCOMPACT-001a: the default policy is disabled; explicit legacy
 *   opt-in replaces tool_result blocks older than `maxAge` with placeholders
 * - CAP-MICROCOMPACT-001b: thinking blocks are NOT cleared
 *   (preserves signature for API continuity)
 * - CAP-MICROCOMPACT-001c: image blocks are preserved across all ages
 *   (replacing them would invalidate Anthropic prompt-cache prefixes and
 *   drop multimodal context; aligns with claudecode / pi-mono / opencode)
 * - CAP-MICROCOMPACT-001d: protected tools (`ask_user_question`) never
 *   cleared regardless of age
 * - CAP-MICROCOMPACT-001e: recent messages within maxAge unchanged
 *
 * Note on the original P1 stub:
 *   The stub said "stale thinking blocks ... stripped", but the actual
 *   `microcompact` implementation INTENTIONALLY preserves thinking
 *   blocks (microcompaction.ts:99-103) — clearing them breaks providers
 *   like Kimi that require non-empty reasoning_content on every
 *   assistant tool-call message. The reformulated obligations above
 *   match the real contract.
 *
 * CAP-MICROCOMPACT-002 is retired: automatic per-turn invocation was removed.
 * CAP-MICROCOMPACT-003 below checks explicit compatibility opt-in over many turns.
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: packages/agent/src/compaction/microcompaction.ts:67
 * (`microcompact`). Retained as an explicit compatibility helper.
 *
 * STATUS: ACTIVE-PARTIAL since FEATURE_100 P3.6o.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXMessage } from '@kodax-ai/llm';
import { microcompact, DEFAULT_MICROCOMPACTION_CONFIG } from '@kodax-ai/agent';

const ACTIVE_MICROCOMPACTION_CONFIG = {
  ...DEFAULT_MICROCOMPACTION_CONFIG,
  enabled: true,
};

describe('CAP-014: microcompact per-turn cleanup contract', () => {
  it('CAP-MICROCOMPACT-001a: default policy preserves old evidence', () => {
    const messages = agedToolResultMessages('default evidence');
    expect(microcompact(messages, DEFAULT_MICROCOMPACTION_CONFIG)).toBe(messages);
  });

  it('CAP-MICROCOMPACT-001a: explicit legacy opt-in clears tool results older than maxAge', () => {
    const messages = agedToolResultMessages('old output');
    const compacted = microcompact(messages, ACTIVE_MICROCOMPACTION_CONFIG);

    const firstUser = compacted[1] as KodaXMessage;
    const block = (firstUser.content as ReadonlyArray<{ type: string; content?: unknown }>)[0]!;
    expect(block.type).toBe('tool_result');
    const blockContent = (block as { content?: string }).content;
    expect(typeof blockContent).toBe('string');
    expect(blockContent).toMatch(/^\[Cleared: /);
  });

  it('CAP-MICROCOMPACT-001b: thinking blocks are NOT cleared (preserves signature for API continuity)', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'extensive reasoning text', signature: 'sig-1' } as unknown as KodaXMessage['content'][number],
          { type: 'text', text: 'hello' },
        ],
      } as KodaXMessage,
    ];
    for (let i = 0; i < 25; i++) {
      messages.push({ role: 'user', content: `u${i}` });
      messages.push({ role: 'assistant', content: `a${i}` });
    }
    const compacted = microcompact(messages, ACTIVE_MICROCOMPACTION_CONFIG);
    const firstAssistant = compacted[0] as KodaXMessage;
    const blocks = firstAssistant.content as ReadonlyArray<{ type: string; thinking?: string }>;
    const thinkingBlock = blocks.find((b) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock?.thinking).toBe('extensive reasoning text');
  });

  it('CAP-MICROCOMPACT-001c: image blocks are preserved across all ages (no replacement)', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            path: '/tmp/screenshot.png',
            source: { type: 'base64', data: 'xxx' },
          } as unknown as KodaXMessage['content'][number],
        ],
      } as KodaXMessage,
    ];
    for (let i = 0; i < 25; i++) {
      messages.push({ role: 'assistant', content: `a${i}` });
      messages.push({ role: 'user', content: `u${i}` });
    }
    const compacted = microcompact(messages, ACTIVE_MICROCOMPACTION_CONFIG);
    const firstUser = compacted[0] as KodaXMessage;
    const blocks = firstUser.content as ReadonlyArray<{ type: string; path?: string }>;
    const preserved = blocks[0]!;
    expect(preserved.type).toBe('image');
    expect(preserved.path).toBe('/tmp/screenshot.png');
  });

  it('CAP-MICROCOMPACT-001d: protected tools (ask_user_question) are never cleared regardless of age', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tc-protected',
            name: 'ask_user_question',
            input: { question: 'q' },
          },
        ],
      } as KodaXMessage,
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tc-protected',
            content: 'preserved user reply',
          },
        ],
      } as KodaXMessage,
    ];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'assistant', content: `a${i}` });
      messages.push({ role: 'user', content: `u${i}` });
    }
    const compacted = microcompact(messages, ACTIVE_MICROCOMPACTION_CONFIG);
    const firstToolResult = compacted[1] as KodaXMessage;
    const block = (firstToolResult.content as ReadonlyArray<{ type: string; content?: unknown }>)[0]!;
    const content = (block as { content?: string }).content;
    expect(content).toBe('preserved user reply');
  });

  it('CAP-MICROCOMPACT-001e: recent messages within maxAge return the same array reference (no-op fast path)', () => {
    const recent: KodaXMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const compacted = microcompact(recent, ACTIVE_MICROCOMPACTION_CONFIG);
    // No clearing happened → function returns the same input array
    // reference (documented "Returns ... or original if unchanged" at
    // microcompaction.ts:65).
    expect(compacted).toBe(recent);
  });

  // CAP-MICROCOMPACT-002 retired: the current substrate does not call the
  // compatibility helper automatically. Its default preserves evidence (001a).
  it('CAP-MICROCOMPACT-003: explicit legacy opt-in ages multiple old results while preserving recent output', () => {
    const messages = agedToolResultMessages('first old output');
    messages.splice(2, 0, { role: 'assistant', content: [{ type: 'tool_use', id: 'second', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'second', content: 'second old output' }] });
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'recent', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'recent', content: 'recent output' }] });
    const compacted = microcompact(messages, ACTIVE_MICROCOMPACTION_CONFIG);
    expect(JSON.stringify(compacted)).not.toContain('first old output');
    expect(JSON.stringify(compacted)).not.toContain('second old output');
    expect(JSON.stringify(compacted)).toContain('recent output');
    expect(JSON.stringify(messages)).toContain('first old output');
  });
});

function agedToolResultMessages(content: string): KodaXMessage[] {
  const messages: KodaXMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tc-old', name: 'bash', input: { command: 'echo old' } },
      ],
    } as KodaXMessage,
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tc-old', content },
      ],
    } as KodaXMessage,
  ];
  for (let i = 0; i < 25; i++) {
    messages.push({ role: 'assistant', content: `a${i}` });
    messages.push({ role: 'user', content: `u${i}` });
  }
  return messages;
}
