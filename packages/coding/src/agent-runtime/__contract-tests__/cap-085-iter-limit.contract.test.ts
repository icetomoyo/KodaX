/**
 * Contract test for CAP-085: iteration limit terminal.
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-085-iteration-limit-terminal
 *
 * Test obligations:
 * - CAP-ITER-LIMIT-001: limitReached flag set when maxIter consumed
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/iteration-limit-terminal.ts:applyIterationLimitTerminal
 * (extracted from agent.ts:1422-1432 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.5c).
 *
 * Time-ordering constraint: ONLY reached when natural for-loop exit
 * (all maxIter iterations consumed without an early break).
 *
 * Active here:
 *   - Final session snapshot save (CAP-011 calling site)
 *   - Promise-signal extraction from `lastText` via checkPromiseSignal
 *
 * STATUS: ACTIVE since FEATURE_100 P3.5c.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXMessage } from '@kodax/ai';
import type { KodaXOptions } from '../../types.js';

import { applyIterationLimitTerminal } from '../iteration-limit-terminal.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({ activeTools: ['read'], modelSelection: {} });
}

function makeOptions(overrides: { withStorage?: boolean } = {}): KodaXOptions {
  if (overrides.withStorage) {
    return {
      session: {
        storage: {
          save: vi.fn().mockResolvedValue(undefined),
          load: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
        },
      },
    } as unknown as KodaXOptions;
  }
  return { session: undefined } as unknown as KodaXOptions;
}

const messages: KodaXMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'final answer' },
];

describe('CAP-085: applyIterationLimitTerminal — final snapshot save', () => {
  it('CAP-ITER-LIMIT-SNAPSHOT: save() invoked on session.storage exactly once with the messages and title', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const options = {
      session: { storage: { save, load: vi.fn(), delete: vi.fn(), list: vi.fn() } },
    } as unknown as KodaXOptions;

    await applyIterationLimitTerminal({
      options,
      sessionId: 'sess-x',
      messages,
      title: 'session title',
      runtimeSessionState: freshState(),
      lastText: 'final',
    });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0]).toBe('sess-x');
    expect((save.mock.calls[0]![1] as { messages: KodaXMessage[] }).messages).toEqual(messages);
  });

  it('CAP-ITER-LIMIT-NO-STORAGE: when options.session.storage is undefined, snapshot save is skipped silently (no throw)', async () => {
    // No assertion needed beyond "did not throw" — the helper is a
    // pass-through to saveSessionSnapshot which itself short-circuits.
    await expect(
      applyIterationLimitTerminal({
        options: makeOptions(),
        sessionId: 'sess-1',
        messages,
        title: 't',
        runtimeSessionState: freshState(),
        lastText: 'final',
      }),
    ).resolves.toBeDefined();
  });
});

describe('CAP-085: applyIterationLimitTerminal — promise signal extraction', () => {
  it('CAP-ITER-LIMIT-001: COMPLETE signal embedded in lastText surfaces in finalSignal', async () => {
    const out = await applyIterationLimitTerminal({
      options: makeOptions(),
      sessionId: 'sess-1',
      messages,
      title: 't',
      runtimeSessionState: freshState(),
      lastText: 'all done. <promise>COMPLETE:finished the work</promise>',
    });
    expect(out.finalSignal).toBe('COMPLETE');
    expect(out.finalReason).toMatch(/finished the work/);
  });

  it('CAP-ITER-LIMIT-NO-SIGNAL: lastText with no signal markers → finalSignal/finalReason are empty strings (preserves byte-for-byte the original `[\'\', \'\']` return from checkPromiseSignal)', async () => {
    const out = await applyIterationLimitTerminal({
      options: makeOptions(),
      sessionId: 'sess-1',
      messages,
      title: 't',
      runtimeSessionState: freshState(),
      lastText: 'just a plain text wrap-up',
    });
    // Empty-string sentinels — caller's downstream code already handles
    // these as falsy (`if (!result.signal)`).
    expect(out.finalSignal).toBe('');
    expect(out.finalReason).toBe('');
  });
});
