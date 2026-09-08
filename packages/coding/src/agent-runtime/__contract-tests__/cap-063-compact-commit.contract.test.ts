/**
 * Contract test for CAP-063: pre-stream validateAndFixToolHistory +
 * onCompactedMessages emission.
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-063-pre-stream-validateandfixtoolhistory--oncompactedmessages-emission
 *
 * Test obligations:
 * - CAP-COMPACT-COMMIT-001: messages committed after validation; emit on compaction
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/middleware/compaction-orchestration.ts:commitCompactedHistory
 * (extracted from agent.ts:736-744 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.4c).
 *
 * Time-ordering constraint: AFTER compaction lifecycle (CAP-060) AND
 * graceful degradation (CAP-062); BEFORE provider stream.
 *
 * Active here:
 *   - validateAndFixToolHistory always runs (orphan tool_uses removed via CAP-002)
 *   - didCompactMessages=true → fresh contextTokenSnapshot returned
 *     and `onCompactedMessages` fires with `(messages, compactionUpdate)`
 *   - didCompactMessages=false → snapshot=undefined; no callback fires
 *
 * STATUS: ACTIVE since FEATURE_100 P3.4c.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXMessage } from '@kodax-ai/llm';
import type { CompactionUpdate } from '@kodax-ai/agent';
import { commitCompactedHistory } from '../middleware/compaction-orchestration.js';
import type { KodaXEvents } from '../../types.js';

const cleanMessages: KodaXMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'world' },
];

describe('CAP-063: commitCompactedHistory — no compaction this turn', () => {
  it('CAP-COMPACT-COMMIT-NOOP: didCompactMessages=false → snapshot is undefined, onCompactedMessages NOT fired, validated messages still returned', async () => {
    const onCompactedMessages = vi.fn();
    const onContextCompactionFinished = vi.fn();
    const events: KodaXEvents = {
      onCompactedMessages,
      onContextCompactionFinished,
    };

    const out = await commitCompactedHistory({
      compacted: cleanMessages,
      didCompactMessages: false,
      compactionUpdate: undefined,
      events,
    });

    expect(out.contextTokenSnapshot).toBeUndefined();
    expect(onCompactedMessages).not.toHaveBeenCalled();
    // Validation still ran — clean messages are unchanged but the
    // function passed them through validateAndFixToolHistory.
    expect(out.messages).toEqual(cleanMessages);
  });
});

describe('CAP-063: commitCompactedHistory — compaction fired this turn', () => {
  it('CAP-COMPACT-COMMIT-001: didCompactMessages=true → onCompactedMessages fired with (messages, compactionUpdate); fresh snapshot returned', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const onCompactedMessages = vi.fn(async () => { clock.mockReturnValue(15); });
    const onContextCompactionFinished = vi.fn();
    const events: KodaXEvents = {
      onCompactedMessages,
      onContextCompactionFinished,
    };
    const compactionUpdate: CompactionUpdate = {
      anchor: undefined,
      artifactLedger: [],
      memorySeed: undefined,
      postCompactAttachments: undefined,
      report: {
        strategy: 'full_prefix',
        triggerSource: 'absolute',
        effectiveTriggerTokens: 1_000,
        protectedBudgetTokens: 200,
        fixedInputTokens: 50,
        eligibleTokens: 700,
        rawTailTokens: 200,
        summaryTokens: 80,
        queryLedgerTokens: 20,
      },
    } as unknown as CompactionUpdate;

    const out = await commitCompactedHistory({
      compacted: cleanMessages,
      didCompactMessages: true,
      compactionUpdate,
      events,
      tokensBefore: 1_100,
      elapsedMs: 25,
    });
    clock.mockRestore();

    expect(out.contextTokenSnapshot).toBeDefined();
    expect(onCompactedMessages).toHaveBeenCalledExactlyOnceWith(
      out.messages,
      compactionUpdate,
    );
    expect(onContextCompactionFinished).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: 'automatic_threshold',
        tokensBefore: 1_100,
        tokensAfter: out.contextTokenSnapshot?.currentTokens,
        committed: true,
        elapsedMs: 40,
        commitMs: 15,
        strategy: 'full_prefix',
        effectiveTriggerTokens: 1_000,
      }),
    );
  });

  it('CAP-COMPACT-COMMIT-002: validation runs unconditionally — orphan tool_use blocks are stripped via validateAndFixToolHistory (CAP-002 wiring)', async () => {
    // Inject an orphaned tool_use (no matching tool_result) — the
    // validation pass MUST drop the orphan so the provider doesn't
    // see a dangling tool_call_id.
    const orphan: KodaXMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'about to call' },
          { type: 'tool_use', id: 'orphan-1', name: 'read', input: {} },
        ],
      },
      // No matching tool_result follows.
      { role: 'user', content: 'next turn' },
    ];

    const out = await commitCompactedHistory({
      compacted: orphan,
      didCompactMessages: false,
      compactionUpdate: undefined,
      events: {},
    });

    // Either the orphan tool_use is removed from the assistant's
    // content blocks, or the entire assistant message is dropped.
    // Both are valid outcomes per CAP-002. The pin is: no
    // dangling `tool_use` survives the validation step.
    const remainingToolUseIds: string[] = [];
    for (const msg of out.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            typeof block === 'object'
            && block !== null
            && (block as { type?: string }).type === 'tool_use'
          ) {
            remainingToolUseIds.push((block as { id: string }).id);
          }
        }
      }
    }
    expect(remainingToolUseIds).not.toContain('orphan-1');
  });

  it('waits for durable host acknowledgement before publishing the canonical finish event', async () => {
    let acknowledge: (() => void) | undefined;
    const durable = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const onContextCompactionFinished = vi.fn();
    const pending = commitCompactedHistory({
      compacted: cleanMessages,
      didCompactMessages: true,
      compactionUpdate: { preCompactionMessages: cleanMessages },
      events: {
        onCompactedMessages: () => durable,
        onContextCompactionFinished,
      },
      tokensBefore: 100,
      elapsedMs: 1,
    });

    await Promise.resolve();
    expect(onContextCompactionFinished).not.toHaveBeenCalled();
    acknowledge?.();
    await pending;
    expect(onContextCompactionFinished).toHaveBeenCalledOnce();
  });
});
