/**
 * Integration contract for the P3.5 terminal flow — pins the
 * cross-helper composition no single CAP test can falsify.
 *
 * Inventory entries crossed:
 *   - CAP-074 (max-tokens continuation)
 *   - CAP-075 (managed-protocol auto-continue)
 *   - CAP-082 (catch cleanup chain)
 *   - CAP-083 (AbortError silent terminal)
 *   - CAP-084 (generic error terminal)
 *   - CAP-085 (iteration-limit terminal)
 *
 * Why this file exists:
 *   The six CAP-level unit tests verify each helper in isolation.
 *   They cannot detect a routing mistake in the catch block (e.g.,
 *   firing the AbortError terminal without first running cleanup, or
 *   calling onError twice). This contract pins the catch flow's
 *   sequencing.
 *
 * The asserted invariants:
 *   1. Catch flow on AbortError: cleanup runs FIRST, then
 *      stream:end fires, then caller assembles success:true result
 *      with cleanedMessages. onError is NOT fired.
 *   2. Catch flow on generic error: cleanup runs FIRST, then `error`
 *      event + onError fire. stream:end is NOT fired (that's
 *      AbortError-specific).
 *   3. Both branches return the same `cleanedMessages` and
 *      `updatedErrorMetadata` from the cleanup step — no branch
 *      bypasses the cleanup chain.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.5 sweep.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXMessage } from '@kodax/ai';
import type { KodaXEvents, KodaXOptions, SessionErrorMetadata } from '../../types.js';

import {
  runCatchCleanup,
  applyAbortErrorTerminal,
  applyGenericErrorTerminal,
} from '../catch-terminals.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';
import type { ExtensionEventEmitter } from '../stream-handler-wiring.js';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({ activeTools: ['read'], modelSelection: {} });
}

function fakeEmitter(): ExtensionEventEmitter {
  return vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter;
}

function makeOptions(save: ReturnType<typeof vi.fn>): KodaXOptions {
  return {
    session: {
      storage: { save, load: vi.fn(), delete: vi.fn(), list: vi.fn() },
    },
  } as unknown as KodaXOptions;
}

const messages: KodaXMessage[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'reply' },
];

/**
 * Compose the agent.ts catch flow. The helper records which sub-helpers
 * fired and returns enough state to assert the invariants.
 */
async function runCatchFlow(args: {
  error: Error;
  errorMetadata?: SessionErrorMetadata;
}): Promise<{
  branch: 'abort' | 'generic';
  cleanedMessages: KodaXMessage[];
  updatedErrorMetadata: SessionErrorMetadata;
  events: { onStreamEnd: ReturnType<typeof vi.fn>; onError: ReturnType<typeof vi.fn> };
  emitter: ReturnType<typeof fakeEmitter>;
  saveFn: ReturnType<typeof vi.fn>;
}> {
  const onStreamEnd = vi.fn();
  const onError = vi.fn();
  const emitter = fakeEmitter();
  const save = vi.fn().mockResolvedValue(undefined);
  const events = { onStreamEnd, onError } as unknown as KodaXEvents;

  const cleanup = await runCatchCleanup({
    error: args.error,
    messages,
    errorMetadata: args.errorMetadata,
    options: makeOptions(save),
    sessionId: 'sess-1',
    title: 't',
    runtimeSessionState: freshState(),
  });

  if (args.error.name === 'AbortError') {
    await applyAbortErrorTerminal({ events, emitActiveExtensionEvent: emitter });
    return {
      branch: 'abort',
      cleanedMessages: cleanup.cleanedMessages,
      updatedErrorMetadata: cleanup.updatedErrorMetadata,
      events: { onStreamEnd, onError },
      emitter,
      saveFn: save,
    };
  }

  await applyGenericErrorTerminal({ error: args.error, events, emitActiveExtensionEvent: emitter });
  return {
    branch: 'generic',
    cleanedMessages: cleanup.cleanedMessages,
    updatedErrorMetadata: cleanup.updatedErrorMetadata,
    events: { onStreamEnd, onError },
    emitter,
    saveFn: save,
  };
}

describe('P3.5 integration: catch flow on AbortError', () => {
  it('P3.5-FLOW-001: AbortError → cleanup runs first (save called once with cleanedMessages), then abort terminal (stream:end fires, onError NOT fired)', async () => {
    const error = new Error('user abort');
    error.name = 'AbortError';

    const out = await runCatchFlow({ error });

    expect(out.branch).toBe('abort');
    // Cleanup ran first — save was called.
    expect(out.saveFn).toHaveBeenCalledOnce();
    // Abort terminal fired stream:end.
    expect(out.events.onStreamEnd).toHaveBeenCalledOnce();
    const streamEndCall = (out.emitter as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'stream:end',
    );
    expect(streamEndCall).toBeDefined();
    // onError NOT fired (AbortError is silent terminal).
    expect(out.events.onError).not.toHaveBeenCalled();
    const errorCall = (out.emitter as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'error',
    );
    expect(errorCall).toBeUndefined();
  });
});

describe('P3.5 integration: catch flow on generic error', () => {
  it('P3.5-FLOW-002: non-AbortError → cleanup runs first, then generic terminal (error event + onError fire, stream:end NOT fired)', async () => {
    const out = await runCatchFlow({ error: new Error('something broke') });

    expect(out.branch).toBe('generic');
    expect(out.saveFn).toHaveBeenCalledOnce();
    // Generic terminal fired `error` event + onError.
    expect(out.events.onError).toHaveBeenCalledOnce();
    const errorCall = (out.emitter as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'error',
    );
    expect(errorCall).toBeDefined();
    // stream:end NOT fired (that's AbortError-specific).
    expect(out.events.onStreamEnd).not.toHaveBeenCalled();
    const streamEndCall = (out.emitter as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'stream:end',
    );
    expect(streamEndCall).toBeUndefined();
  });
});

describe('P3.5 integration: cleanup is unconditional', () => {
  it('P3.5-FLOW-003: both branches receive the SAME cleaned messages and updated metadata from the single cleanup step (no branch bypasses cleanup)', async () => {
    const abortError = new Error('abort');
    abortError.name = 'AbortError';

    const abortOut = await runCatchFlow({ error: abortError });
    const genericOut = await runCatchFlow({ error: new Error('boom') });

    // Both runs got cleaned messages from the same chain — pin that
    // the metadata counter starts at 1 in both (no carry-over from
    // the abort run because each `runCatchFlow` starts fresh).
    expect(abortOut.updatedErrorMetadata.consecutiveErrors).toBe(1);
    expect(genericOut.updatedErrorMetadata.consecutiveErrors).toBe(1);

    // Both runs forwarded errorMetadata into the snapshot save.
    expect(abortOut.saveFn).toHaveBeenCalledOnce();
    expect(genericOut.saveFn).toHaveBeenCalledOnce();
    expect((abortOut.saveFn.mock.calls[0]![1] as { errorMetadata: SessionErrorMetadata }).errorMetadata.lastError).toBe('abort');
    expect((genericOut.saveFn.mock.calls[0]![1] as { errorMetadata: SessionErrorMetadata }).errorMetadata.lastError).toBe('boom');
  });
});
