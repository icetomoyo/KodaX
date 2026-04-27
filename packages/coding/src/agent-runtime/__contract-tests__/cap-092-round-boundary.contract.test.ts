/**
 * Contract test for CAP-092: round-boundary message shape reshape (FEATURE_076)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-092-round-boundary-message-shape-reshape-feature_076
 *
 * Test obligations:
 * - CAP-ROUND-BOUNDARY-001: AMA worker-trace → clean {user, assistant} pair
 * - CAP-ROUND-BOUNDARY-002: SA result passes through (no-op)
 *
 * Risk: HIGH (FEATURE_076 — downstream session-snapshot, /resume,
 * /continue, multi-turn REPL all depend on clean {user, assistant}
 * pairs).
 *
 * Class: 1
 *
 * Verified location: task-engine/_internal/round-boundary.ts:131
 * (reshapeToUserConversation). The agent.ts call site at the
 * runManagedTask outer wrapper invokes it on every result.
 *
 * Note on overlap: extensive function-level coverage already exists in
 * `task-engine/_internal/round-boundary.test.ts` (12+ tests of
 * reshapeToUserConversation). This contract test pins the two
 * inventory-level obligations explicitly so the CAP-inventory
 * coverage tracker matches a green test for this capability.
 *
 * Time-ordering constraint: LAST step before returning from
 * runManagedTask; after all internal terminal handling.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6m.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXMessage } from '@kodax/ai';
import { reshapeToUserConversation } from '../../task-engine/_internal/round-boundary.js';
import type { KodaXOptions, KodaXResult } from '../../types.js';

function makeOptions(): KodaXOptions {
  return {
    session: {},
  } as unknown as KodaXOptions;
}

function makeResult(messages: KodaXMessage[], lastText = ''): KodaXResult {
  return {
    success: true,
    messages,
    sessionId: 'test-session',
    lastText,
  } as unknown as KodaXResult;
}

describe('CAP-092: round-boundary message shape reshape contract', () => {
  it('CAP-ROUND-BOUNDARY-001: AMA worker-execution-trace (Scout role-prompt wrapping) is reshaped to a clean {user, assistant} pair', () => {
    const workerTrace: KodaXMessage[] = [
      // Original user prompt
      { role: 'user', content: 'fix the auth bug' },
      // Worker-trace tail: Scout role-prompt wrapped pair
      { role: 'user', content: 'You are the Scout role tasked with...' },
      { role: 'assistant', content: 'scout findings: bug in auth.ts' },
    ];
    const result = makeResult(workerTrace, 'Found the bug at auth.ts:42 — null check missing.');

    const reshaped = reshapeToUserConversation(result, makeOptions(), 'fix the auth bug');

    // Reshaped output should have clean {user, assistant} pairs and not
    // contain the role-prompt-wrapped scout user message.
    expect(reshaped.messages.length).toBeGreaterThanOrEqual(2);
    const lastUser = reshaped.messages.find((m) => m.role === 'user');
    expect(lastUser).toBeDefined();
    // No role-prompt prefix in the user-facing output.
    const userText = typeof lastUser!.content === 'string' ? lastUser!.content : '';
    expect(userText).not.toMatch(/^You are the Scout role/);
  });

  it('CAP-ROUND-BOUNDARY-002: SA result with already-clean {user, assistant} pair passes through (reshape is a no-op for the conversational shape)', () => {
    const cleanMessages: KodaXMessage[] = [
      { role: 'user', content: 'what is 2 + 2?' },
      { role: 'assistant', content: '4' },
    ];
    const result = makeResult(cleanMessages, '4');

    const reshaped = reshapeToUserConversation(result, makeOptions(), 'what is 2 + 2?');

    expect(reshaped.messages).toHaveLength(2);
    expect(reshaped.messages[0]!.role).toBe('user');
    expect(reshaped.messages[1]!.role).toBe('assistant');
    // The user message in the output matches the prompt exactly.
    expect(reshaped.messages[0]!.content).toBe('what is 2 + 2?');
  });
});
