/**
 * Contract test for CAP-045: session loading + post-load message normalization
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-045-session-loading--post-load-message-normalization
 *
 * Test obligations:
 * - CAP-SESSION-LOAD-001: clean session load produces expected
 *   messages + metadata fields (INTEGRATION-LEVEL — depends on
 *   `storage.load()` fixture-driven flow inside runKodaX; deferred to
 *   substrate-executor migration).
 * - CAP-SESSION-LOAD-002: FEATURE_076 normalization drops worker-trace
 *   tails from pre-v0.7.25 sessions (FUNCTION-LEVEL — active here
 *   against `normalizeLoadedSessionMessages`).
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: task-engine/_internal/round-boundary.ts:191
 * (normalizeLoadedSessionMessages). The agent.ts call site at
 * the session-load entry uses this function on resumed sessions to
 * strip trailing role-prompt-shaped worker pairs that pre-v0.7.25
 * sessions persisted alongside the user-facing conversation.
 *
 * Time-ordering constraint: AFTER session id resolution; BEFORE first
 * user message push.
 *
 * STATUS: ACTIVE-PARTIAL since FEATURE_100 P3.6l.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXMessage } from '@kodax/ai';
import { normalizeLoadedSessionMessages } from '../../task-engine/_internal/round-boundary.js';

describe('CAP-045: session loading + post-load message normalization contract', () => {
  it.todo(
    'CAP-SESSION-LOAD-001: clean session storage.load() yields expected messages, title, errorMetadata, and extension state — INTEGRATION-LEVEL, deferred until substrate-executor extracts the session-load step.',
  );

  it('CAP-SESSION-LOAD-002a: trailing role-prompt-shaped {user, assistant} pair is dropped (Scout/Planner/Generator/Evaluator pattern)', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'real user question' },
      { role: 'assistant', content: 'real assistant answer' },
      { role: 'user', content: 'You are the Scout role tasked with...' },
      { role: 'assistant', content: 'scout response' },
    ];
    const normalized = normalizeLoadedSessionMessages(messages);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]!.content).toBe('real user question');
    expect(normalized[1]!.content).toBe('real assistant answer');
  });

  it('CAP-SESSION-LOAD-002b: multiple trailing role-prompt pairs are stripped iteratively', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'real user prompt' },
      { role: 'assistant', content: 'real reply' },
      { role: 'user', content: 'You are the Scout role.' },
      { role: 'assistant', content: 'scout reply' },
      { role: 'user', content: 'You are the Generator role.' },
      { role: 'assistant', content: 'generator reply' },
    ];
    const normalized = normalizeLoadedSessionMessages(messages);
    expect(normalized).toHaveLength(2);
  });

  it('CAP-SESSION-LOAD-002c: clean session (no role-prompt tail) is returned unchanged', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'follow-up question' },
      { role: 'assistant', content: 'follow-up reply' },
    ];
    const normalized = normalizeLoadedSessionMessages(messages);
    expect(normalized).toHaveLength(4);
    expect(normalized).toEqual(messages);
  });

  it('CAP-SESSION-LOAD-002d: input array is NEVER mutated (returns a fresh slice)', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'real' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'You are the Evaluator role.' },
      { role: 'assistant', content: 'eval' },
    ];
    const originalLength = messages.length;
    normalizeLoadedSessionMessages(messages);
    expect(messages.length).toBe(originalLength);
    expect(messages[2]!.content).toMatch(/Evaluator role/);
  });

  it('CAP-SESSION-LOAD-002e: empty messages array is handled (returns empty array)', () => {
    expect(normalizeLoadedSessionMessages([])).toEqual([]);
  });
});
