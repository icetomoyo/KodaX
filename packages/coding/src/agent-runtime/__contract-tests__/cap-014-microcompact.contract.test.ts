/**
 * Contract test for CAP-014: microcompact per-turn cleanup
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-014-microcompact-per-turn-cleanup
 *
 * Test obligations (reformulated to match the actual implementation):
 * - CAP-MICROCOMPACT-001a: tool_result blocks older than `maxAge`
 *   turns are replaced with `[Cleared: ...]` placeholders
 * - CAP-MICROCOMPACT-001b: thinking blocks are NOT cleared
 *   (preserves signature for API continuity)
 * - CAP-MICROCOMPACT-001c: image blocks older than `maxAge` are
 *   replaced with `[Image: <filename>]` text markers
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
 * CAP-MICROCOMPACT-002 (per-turn epilogue ordering) and 003 (5+ turn
 * pruning across multiple tool_results) stay `it.todo` — the first is
 * a call-site invariant inside runKodaX, the second is integration-
 * level coverage that the function-level 001a already implies.
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: packages/agent/src/compaction/microcompaction.ts:67
 * (`microcompact`). Called from agent.ts per-turn epilogue.
 *
 * STATUS: ACTIVE-PARTIAL since FEATURE_100 P3.6o.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXMessage } from '@kodax/ai';
import { microcompact, DEFAULT_MICROCOMPACTION_CONFIG } from '@kodax/agent';

describe('CAP-014: microcompact per-turn cleanup contract', () => {
  it('CAP-MICROCOMPACT-001a: tool_result blocks older than maxAge turns are replaced with `[Cleared: ...]` placeholders', () => {
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
          { type: 'tool_result', tool_use_id: 'tc-old', content: 'old output' },
        ],
      } as KodaXMessage,
    ];
    // Add 25 more user/assistant turns to age the original beyond maxAge=20.
    for (let i = 0; i < 25; i++) {
      messages.push({ role: 'assistant', content: `a${i}` });
      messages.push({ role: 'user', content: `u${i}` });
    }
    const compacted = microcompact(messages, DEFAULT_MICROCOMPACTION_CONFIG);

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
    const compacted = microcompact(messages, DEFAULT_MICROCOMPACTION_CONFIG);
    const firstAssistant = compacted[0] as KodaXMessage;
    const blocks = firstAssistant.content as ReadonlyArray<{ type: string; thinking?: string }>;
    const thinkingBlock = blocks.find((b) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock?.thinking).toBe('extensive reasoning text');
  });

  it('CAP-MICROCOMPACT-001c: image blocks older than maxAge are replaced with `[Image: <filename>]` text markers', () => {
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
    const compacted = microcompact(messages, DEFAULT_MICROCOMPACTION_CONFIG);
    const firstUser = compacted[0] as KodaXMessage;
    const blocks = firstUser.content as ReadonlyArray<{ type: string; text?: string }>;
    const replaced = blocks[0]!;
    expect(replaced.type).toBe('text');
    expect(replaced.text).toBe('[Image: screenshot.png]');
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
    const compacted = microcompact(messages, DEFAULT_MICROCOMPACTION_CONFIG);
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
    const compacted = microcompact(recent, DEFAULT_MICROCOMPACTION_CONFIG);
    // No clearing happened → function returns the same input array
    // reference (documented "Returns ... or original if unchanged" at
    // microcompaction.ts:65).
    expect(compacted).toBe(recent);
  });

  it.todo(
    'CAP-MICROCOMPACT-002: microcompact runs in per-turn epilogue, not pre-stream — INTEGRATION-LEVEL ordering invariant inside runKodaX, deferred to substrate-executor migration.',
  );

  it.todo(
    'CAP-MICROCOMPACT-003: redundant tool-result echoes pruned across 5+ turn sessions — single-tool-result aging is covered by 001a; multi-tool-result pruning across multiple turns is integration-level.',
  );
});
