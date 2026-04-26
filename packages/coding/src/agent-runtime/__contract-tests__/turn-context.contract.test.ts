/**
 * Contract test for TurnContext type — FEATURE_100 P3.0
 *
 * Inventory entry: docs/features/v0.7.29.md § P3 Implementation Plan / TurnContext type design
 *
 * Test obligations:
 *  - TURN-CONTEXT-001: spread produces a new object; original unchanged
 *  - TURN-CONTEXT-002: changing one field via spread leaves all other fields
 *    referentially equal (verifies "PER_TURN advance via spread" semantics)
 *  - TURN-CONTEXT-003: TurnOutcome discriminated union is exhaustive at the
 *    type level — adding a new variant without updating the switch fails
 *    typecheck (compile-time pin via `never`)
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/turn-context.ts (P3.0 introduction)
 *
 * STATUS: ACTIVE since FEATURE_100 P3.0.
 *
 * P3.0 introduces the TurnContext type with no usage yet. These tests
 * pin the immutability contract that all P3.1+ steps must honor.
 */

import { describe, expect, it } from 'vitest';

import type { TurnContext, TurnOutcome } from '../turn-context.js';

// Build a minimal TurnContext fixture. Field values are intentionally
// minimal — we're testing structural/immutability semantics, not field
// content. Heavy types (KodaXOptions, KodaXEvents, etc.) are stubbed
// via `as unknown as ...` casts because constructing real instances
// would couple this test to upstream type details that change frequently.
function fixture(overrides: Partial<TurnContext> = {}): TurnContext {
  const base = {
    options: {} as TurnContext['options'],
    events: {} as TurnContext['events'],
    maxIter: 200,
    sessionId: 'fixture-session',
    executionCwd: '/fixture',
    toolCtx: {} as TurnContext['toolCtx'],
    compactionConfig: {} as TurnContext['compactionConfig'],
    prompt: 'fixture prompt',
    title: 'fixture title',
    errorMetadata: undefined,
    managedProtocolPayload: { current: undefined } as TurnContext['managedProtocolPayload'],
    iter: 0,
    messages: [] as TurnContext['messages'],
    sessionState: {} as TurnContext['sessionState'],
    currentExecution: {} as TurnContext['currentExecution'],
    reasoningPlan: {} as TurnContext['reasoningPlan'],
    contextTokenSnapshot: {} as TurnContext['contextTokenSnapshot'],
    costTracker: {} as TurnContext['costTracker'],
    compactConsecutiveFailures: 0,
    managedProtocolContinueAttempted: false,
    incompleteRetryCount: 0,
    maxTokensRetryCount: 0,
    preAnswerJudgeConsumed: false,
    postToolJudgeConsumed: false,
    autoFollowUpCount: 0,
    autoDepthEscalationCount: 0,
    autoTaskRerouteCount: 0,
    lastText: '',
    limitReached: false,
  } as const;
  return { ...base, ...overrides };
}

describe('TurnContext: immutability via spread', () => {
  it('TURN-CONTEXT-001: spread produces a new object reference', () => {
    const ctx = fixture();
    const next: TurnContext = { ...ctx, iter: 1 };
    expect(next).not.toBe(ctx);
    expect(next.iter).toBe(1);
    // Original unchanged — load-bearing for the "no in-place mutation" rule.
    expect(ctx.iter).toBe(0);
  });

  it('TURN-CONTEXT-002: spread leaves untouched fields referentially equal', () => {
    // The two `@mutable-exception` fields (toolCtx, sessionState) MUST stay
    // the same reference across turns. Plain spread guarantees this for all
    // fields — this test pins that the spread-based advance protocol works
    // correctly for the exception-tier fields.
    const originalToolCtx = {} as TurnContext['toolCtx'];
    const originalSessionState = {} as TurnContext['sessionState'];
    const originalManagedProtocolPayload = {
      current: undefined,
    } as TurnContext['managedProtocolPayload'];

    const ctx = fixture({
      toolCtx: originalToolCtx,
      sessionState: originalSessionState,
      managedProtocolPayload: originalManagedProtocolPayload,
    });

    // Step that only advances `iter` MUST leave the exception-tier fields
    // referentially equal — extension callbacks rely on stable references.
    const next: TurnContext = { ...ctx, iter: ctx.iter + 1 };

    expect(next.toolCtx).toBe(originalToolCtx);
    expect(next.sessionState).toBe(originalSessionState);
    expect(next.managedProtocolPayload).toBe(originalManagedProtocolPayload);
  });

  it('TURN-CONTEXT-002b: messages array follows copy-on-write — append produces a new array', () => {
    const ctx = fixture({ messages: [] });

    // The "append a message" pattern that every step uses.
    const newMessage = { role: 'user', content: 'hello' } as TurnContext['messages'][number];
    const next: TurnContext = { ...ctx, messages: [...ctx.messages, newMessage] };

    expect(next.messages).not.toBe(ctx.messages);
    expect(next.messages).toHaveLength(1);
    expect(ctx.messages).toHaveLength(0); // original untouched
  });
});

describe('TurnContext: TurnOutcome discriminated union exhaustiveness', () => {
  it('TURN-CONTEXT-003: switch over `kind` is exhaustive at type level', () => {
    // This function compiles only when every TurnOutcome variant is handled.
    // The default branch's `never` assignment fails typecheck if a new
    // variant is added to the union without a corresponding case here.
    function classify(outcome: TurnOutcome): string {
      switch (outcome.kind) {
        case 'continue':
          return 'continue';
        case 'complete':
          return outcome.signal ?? 'complete';
        case 'interrupted':
          return 'interrupted';
        case 'error':
          return outcome.error.message;
        case 'limit_reached':
          return 'limit';
        default: {
          // Type-level pin: `never` here forces typecheck failure if any
          // TurnOutcome variant is added without updating this switch.
          const _exhaustive: never = outcome;
          return _exhaustive;
        }
      }
    }

    const ctx = fixture();
    expect(classify({ kind: 'continue', ctx })).toBe('continue');
    expect(classify({ kind: 'complete', ctx })).toBe('complete');
    expect(classify({ kind: 'complete', ctx, signal: 'BLOCKED' })).toBe('BLOCKED');
    expect(classify({ kind: 'interrupted', ctx })).toBe('interrupted');
    expect(classify({ kind: 'error', ctx, error: new Error('boom') })).toBe('boom');
    expect(classify({ kind: 'limit_reached', ctx })).toBe('limit');
  });
});
