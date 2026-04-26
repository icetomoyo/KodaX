/**
 * Contract test for CAP-002: cleanupIncompleteToolCalls + validateAndFixToolHistory
 *
 * Inventory entry:
 * docs/features/v0.7.29-capability-inventory.md#cap-002
 *
 * Test obligations declared in inventory:
 * - CAP-HISTORY-CLEANUP-001 (orphan tool_use removed)
 * - CAP-HISTORY-CLEANUP-002 (interleaved tool_use/tool_result preserved)
 *
 * Risk classification: HIGH_RISK_PARITY — this capability was lost when
 * FEATURE_084 routed AMA around runKodaX and patched back at runner-driven.ts:2408.
 *
 * STATUS: ACTIVE since FEATURE_100 P2 (CAP-002 first-migration). The two
 * functions were extracted from `agent.ts` to `agent-runtime/history-cleanup.ts`;
 * this contract test pins their behavior so any future change is caught.
 */

import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax/ai';

import {
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from '../history-cleanup.js';

describe('CAP-002: history cleanup contract', () => {
  it('CAP-HISTORY-CLEANUP-001: orphan tool_use is removed before next provider call', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'do x' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will use tool A' },
          { type: 'tool_use', id: 'call_1', name: 'tool_a', input: {} },
        ],
      },
      // <-- no tool_result for call_1; this is an orphan
    ];

    const cleaned = cleanupIncompleteToolCalls(messages);

    // Orphan tool_use removed
    const lastMsg = cleaned[cleaned.length - 1]!;
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.content).not.toContainEqual(
      expect.objectContaining({ type: 'tool_use', id: 'call_1' }),
    );
    // Original messages array NOT mutated (immutability contract)
    const originalAssistant = messages[1]!;
    expect(Array.isArray(originalAssistant.content)).toBe(true);
    expect(originalAssistant.content).toContainEqual(
      expect.objectContaining({ type: 'tool_use', id: 'call_1' }),
    );
  });

  it('CAP-HISTORY-CLEANUP-002: interleaved tool_use/tool_result pairs preserved', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'do x' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'tool_a', input: {} },
          { type: 'tool_use', id: 'call_2', name: 'tool_b', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'result_1' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'result_2' },
        ],
      },
    ];

    const cleaned = cleanupIncompleteToolCalls(messages);

    // Both pairs preserved (no orphans)
    expect(cleaned).toEqual(messages);
  });

  it('CAP-HISTORY-CLEANUP-003: validateAndFixToolHistory removes orphan tool_use in assistant message', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'do x' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'tool_a', input: {} },
          { type: 'tool_use', id: 'call_2', name: 'tool_b', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          // Only one tool_result — call_2 is orphaned in the assistant message
          { type: 'tool_result', tool_use_id: 'call_1', content: 'result_1' },
        ],
      },
    ];

    const fixed = validateAndFixToolHistory(messages);
    const assistantBlock = fixed[1]!;

    // Orphaned tool_use call_2 stripped; matched call_1 retained.
    expect(assistantBlock.content).toContainEqual(
      expect.objectContaining({ type: 'tool_use', id: 'call_1' }),
    );
    expect(assistantBlock.content).not.toContainEqual(
      expect.objectContaining({ type: 'tool_use', id: 'call_2' }),
    );
  });

  it('CAP-HISTORY-CLEANUP-004: validateAndFixToolHistory removes orphan tool_result in user message', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'do x' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'tool_a', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'ok' },
          // call_99 has no preceding tool_use — orphan
          { type: 'tool_result', tool_use_id: 'call_99', content: 'orphan' },
        ],
      },
    ];

    const fixed = validateAndFixToolHistory(messages);
    const userBlock = fixed[2]!;

    expect(userBlock.content).toContainEqual(
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'call_1' }),
    );
    expect(userBlock.content).not.toContainEqual(
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'call_99' }),
    );
  });

  it('CAP-HISTORY-CLEANUP-005: assistant message with only non-substantive blocks (e.g. empty thinking) gets a "..." placeholder', () => {
    // Provider compatibility: Kimi rejects empty assistant messages with 400.
    // Microcompaction can clear thinking text in-place (`thinking: ''`); after
    // tool_use stripping the message may have content blocks that are all
    // non-substantive. The placeholder branch injects a `'...'` text block.
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'do x' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '' }, // non-substantive (compacted)
          { type: 'tool_use', id: 'call_1', name: 'tool_a', input: {} }, // will be stripped (orphan)
        ],
      },
      // No tool_result for call_1 → orphan stripped, leaving only empty thinking
    ];

    const fixed = validateAndFixToolHistory(messages);
    const assistantBlock = fixed[1]!;

    expect(assistantBlock.role).toBe('assistant');
    expect(assistantBlock.content).toEqual([{ type: 'text', text: '...' }]);
  });
});
