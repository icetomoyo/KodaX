

import { describe, expect, it } from 'vitest';

import { detectIdleYield } from '@kodax-ai/agent';

describe('FEATURE_190 Phase 1 — detectIdleYield text-only termination behavior', () => {
  it('text-only Worker with no pending children → idle-yield false (loop exits cleanly)', () => {
    // The canonical text-only termination flow: Worker produces a final
    // text message, Runner.run exits via the no-tool-calls branch,
    // outer loop computes the snapshot and detectIdleYield returns
    // false → the outer loop breaks → run terminates.
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(false);
  });

  it('text-only Worker WITH pending children → idle-yield true (FEATURE_165 safety preserved)', () => {
    // Even if Worker tries to text-only terminate while a dispatched
    // child is still in flight, the outer loop must NOT break — it
    // must wait for the child to finish and re-invoke Worker. Under
    // pre-F190 architecture this gate lived in the emit_handoff
    // wrapper (handoffEmit pending-children check). Post-F190 the gate
    // is satisfied by detectIdleYield itself — pendingChildTaskCount>0
    // is sufficient to keep the loop waiting regardless of whether
    // Worker called emit_handoff or just went text-only.
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 1,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: false,
      }),
    ).toBe(true);
  });

  it('text-only Worker with pending background message → idle-yield true (Bug E coverage extends to text-only)', () => {
    expect(
      detectIdleYield({
        lastAssistantToolCallCount: 0,
        pendingChildTaskCount: 0,
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict: false,
        hasPendingBackgroundMessages: true,
      }),
    ).toBe(true);
  });
});
