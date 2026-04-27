/**
 * Contract test for CAP-082: catch-block cleanup chain.
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-082-catch-block--error-metadata--cleanup-chain
 *
 * Test obligations:
 * - CAP-CATCH-CLEANUP-001: history validated before persistence
 * - CAP-CATCH-CLEANUP-002: consecutive errors counter increments across runs
 *
 * Risk: HIGH (must not mask the original error; cleaned messages must
 * not lose user history)
 *
 * Class: 1
 *
 * Verified location: agent-runtime/catch-terminals.ts:runCatchCleanup
 * (extracted from agent.ts:1360-1388 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.5d).
 *
 * Time-ordering constraint: FIRST step in catch; BEFORE branching to
 * AbortError vs general-error.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.5d.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXMessage } from '@kodax/ai';
import type { KodaXOptions, SessionErrorMetadata } from '../../types.js';

import { runCatchCleanup } from '../catch-terminals.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({ activeTools: ['read'], modelSelection: {} });
}

function makeOptions(save?: ReturnType<typeof vi.fn>): KodaXOptions {
  if (save) {
    return {
      session: {
        storage: { save, load: vi.fn(), delete: vi.fn(), list: vi.fn() },
      },
    } as unknown as KodaXOptions;
  }
  return {} as unknown as KodaXOptions;
}

describe('CAP-082: runCatchCleanup — history validation + persistence', () => {
  it('CAP-CATCH-CLEANUP-001: history with orphan tool_use blocks → cleaned messages drop the orphan, snapshot save sees the cleaned version', async () => {
    const orphan: KodaXMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'about to call' },
          { type: 'tool_use', id: 'orphan-1', name: 'read', input: {} },
        ],
      },
      { role: 'user', content: 'next prompt' },
    ];
    const save = vi.fn().mockResolvedValue(undefined);

    const out = await runCatchCleanup({
      error: new Error('boom'),
      messages: orphan,
      errorMetadata: undefined,
      options: makeOptions(save),
      sessionId: 'sess-1',
      title: 't',
      runtimeSessionState: freshState(),
    });

    // Orphan should be removed by the cleanup chain.
    const remainingToolUseIds: string[] = [];
    for (const msg of out.cleanedMessages) {
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

    // Snapshot save was called with the cleaned messages (not the dirty input).
    expect(save).toHaveBeenCalledOnce();
    const savedPayload = save.mock.calls[0]![1] as { messages: KodaXMessage[] };
    expect(savedPayload.messages).toEqual(out.cleanedMessages);
  });

  it('CAP-CATCH-CLEANUP-NO-STORAGE: undefined session.storage → silent skip (no throw)', async () => {
    const out = await runCatchCleanup({
      error: new Error('boom'),
      messages: [{ role: 'user', content: 'hi' }],
      errorMetadata: undefined,
      options: makeOptions(),
      sessionId: 'sess-1',
      title: 't',
      runtimeSessionState: freshState(),
    });
    expect(out.cleanedMessages).toBeDefined();
    expect(out.contextTokenSnapshot).toBeDefined();
  });
});

describe('CAP-082: runCatchCleanup — error metadata accounting', () => {
  it('CAP-CATCH-CLEANUP-002: consecutive errors counter increments across runs', async () => {
    const opts = makeOptions(vi.fn().mockResolvedValue(undefined));

    const first = await runCatchCleanup({
      error: new Error('first'),
      messages: [],
      errorMetadata: undefined,
      options: opts,
      sessionId: 'sess-1',
      title: 't',
      runtimeSessionState: freshState(),
    });
    expect(first.updatedErrorMetadata.consecutiveErrors).toBe(1);
    expect(first.updatedErrorMetadata.lastError).toBe('first');

    const second = await runCatchCleanup({
      error: new Error('second'),
      messages: [],
      errorMetadata: first.updatedErrorMetadata,
      options: opts,
      sessionId: 'sess-1',
      title: 't',
      runtimeSessionState: freshState(),
    });
    expect(second.updatedErrorMetadata.consecutiveErrors).toBe(2);
    expect(second.updatedErrorMetadata.lastError).toBe('second');
  });

  it('CAP-CATCH-CLEANUP-METADATA-PASSED: errorMetadata is forwarded to saveSessionSnapshot with the incremented counter', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const out = await runCatchCleanup({
      error: new Error('boom'),
      messages: [],
      errorMetadata: { lastError: 'prev', lastErrorTime: 0, consecutiveErrors: 4 } as SessionErrorMetadata,
      options: makeOptions(save),
      sessionId: 'sess-1',
      title: 't',
      runtimeSessionState: freshState(),
    });
    expect(save).toHaveBeenCalledOnce();
    const savedPayload = save.mock.calls[0]![1] as { errorMetadata: SessionErrorMetadata };
    expect(savedPayload.errorMetadata).toBe(out.updatedErrorMetadata);
    expect(savedPayload.errorMetadata.consecutiveErrors).toBe(5);
  });
});
