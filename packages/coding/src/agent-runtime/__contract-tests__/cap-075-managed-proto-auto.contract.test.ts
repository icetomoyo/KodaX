/**
 * Contract test for CAP-075: managed protocol auto-continue fallback.
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-075-managed-protocol-auto-continue-fallback
 *
 * Test obligations:
 * - CAP-MANAGED-PROTO-AUTO-001: fires once when end_turn but no protocol emitted
 * - CAP-MANAGED-PROTO-AUTO-002: skipped when protocol is optional
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/managed-protocol-continue.ts:maybeAutoContinueManagedProtocol
 * (extracted from agent.ts:996-1027 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.5b).
 *
 * Time-ordering constraint: AFTER L5 max-tokens continuation gate
 * (CAP-074); BEFORE tool-blocks-empty branch.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.5b.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXMessage, KodaXStreamResult } from '@kodax/ai';
import type { KodaXContextTokenSnapshot, KodaXOptions } from '../../types.js';

import { maybeAutoContinueManagedProtocol } from '../managed-protocol-continue.js';
import { MANAGED_PROTOCOL_TOOL_NAME } from '../../managed-protocol.js';

function fakeSnapshot(): KodaXContextTokenSnapshot {
  return { currentTokens: 100, source: 'estimated' } as unknown as KodaXContextTokenSnapshot;
}

function makeResult(overrides: Partial<KodaXStreamResult> = {}): KodaXStreamResult {
  return {
    stopReason: 'end_turn',
    textBlocks: [],
    toolBlocks: [],
    thinkingBlocks: [],
    usage: {} as KodaXStreamResult['usage'],
    ...overrides,
  } as KodaXStreamResult;
}

function makeOptions(emission: {
  enabled: boolean;
  optional?: boolean;
  role?: string;
}): KodaXOptions {
  return {
    context: {
      managedProtocolEmission: {
        enabled: emission.enabled,
        optional: emission.optional ?? false,
        role: emission.role ?? 'scout',
      },
    },
  } as unknown as KodaXOptions;
}

describe('CAP-075: maybeAutoContinueManagedProtocol — gate short-circuits', () => {
  it('CAP-MANAGED-PROTO-AUTO-LATCH: continueAttempted=true → no_op, latch unchanged, messages unmutated', () => {
    const messages: KodaXMessage[] = [];
    const out = maybeAutoContinueManagedProtocol({
      result: makeResult({ stopReason: 'end_turn' }),
      lastText: 'some final text',
      messages,
      continueAttempted: true,
      options: makeOptions({ enabled: true, role: 'scout' }),
      emittedManagedProtocolPayload: undefined,
      completedTurnTokenSnapshot: fakeSnapshot(),
    });
    expect(out.outcome).toBe('no_op');
    expect(out.nextContinueAttempted).toBe(true);
    expect(messages).toEqual([]);
  });

  it('CAP-MANAGED-PROTO-AUTO-002: optional=true → no_op (protocol only required on escalation; Scout-with-tools ok to end without it)', () => {
    const messages: KodaXMessage[] = [];
    const out = maybeAutoContinueManagedProtocol({
      result: makeResult({ stopReason: 'end_turn' }),
      lastText: 'final answer',
      messages,
      continueAttempted: false,
      options: makeOptions({ enabled: true, optional: true, role: 'scout' }),
      emittedManagedProtocolPayload: undefined,
      completedTurnTokenSnapshot: fakeSnapshot(),
    });
    expect(out.outcome).toBe('no_op');
    expect(out.nextContinueAttempted).toBe(false);
    expect(messages).toEqual([]);
  });

  it('CAP-MANAGED-PROTO-AUTO-DISABLED: emission.enabled=false → no_op', () => {
    const out = maybeAutoContinueManagedProtocol({
      result: makeResult({ stopReason: 'end_turn' }),
      lastText: 'final',
      messages: [],
      continueAttempted: false,
      options: makeOptions({ enabled: false }),
      emittedManagedProtocolPayload: undefined,
      completedTurnTokenSnapshot: fakeSnapshot(),
    });
    expect(out.outcome).toBe('no_op');
  });

  it('CAP-MANAGED-PROTO-AUTO-NOT-END-TURN: stopReason !== end_turn → no_op', () => {
    const out = maybeAutoContinueManagedProtocol({
      result: makeResult({ stopReason: 'tool_use' }),
      lastText: 'final',
      messages: [],
      continueAttempted: false,
      options: makeOptions({ enabled: true, role: 'scout' }),
      emittedManagedProtocolPayload: undefined,
      completedTurnTokenSnapshot: fakeSnapshot(),
    });
    expect(out.outcome).toBe('no_op');
  });

  it('CAP-MANAGED-PROTO-AUTO-EMPTY-TEXT: lastText empty → no_op (managed-protocol-empty has its own handler upstream)', () => {
    const out = maybeAutoContinueManagedProtocol({
      result: makeResult({ stopReason: 'end_turn' }),
      lastText: '',
      messages: [],
      continueAttempted: false,
      options: makeOptions({ enabled: true, role: 'scout' }),
      emittedManagedProtocolPayload: undefined,
      completedTurnTokenSnapshot: fakeSnapshot(),
    });
    expect(out.outcome).toBe('no_op');
  });

  it('CAP-MANAGED-PROTO-AUTO-TOOL-BLOCKS: tool_blocks non-empty → no_op (any tool call satisfies the protocol naturally)', () => {
    const out = maybeAutoContinueManagedProtocol({
      result: makeResult({
        stopReason: 'end_turn',
        toolBlocks: [
          { type: 'tool_use', id: 't1', name: 'read', input: {} },
        ] as unknown as KodaXStreamResult['toolBlocks'],
      }),
      lastText: 'final',
      messages: [],
      continueAttempted: false,
      options: makeOptions({ enabled: true, role: 'scout' }),
      emittedManagedProtocolPayload: undefined,
      completedTurnTokenSnapshot: fakeSnapshot(),
    });
    expect(out.outcome).toBe('no_op');
  });
});

describe('CAP-075: maybeAutoContinueManagedProtocol — fires once', () => {
  it('CAP-MANAGED-PROTO-AUTO-001: end_turn + required protocol missing → continue, latch flips true, synthetic user message demands ONLY the protocol tool call', () => {
    const messages: KodaXMessage[] = [{ role: 'assistant', content: 'plain text answer' }];
    const out = maybeAutoContinueManagedProtocol({
      result: makeResult({ stopReason: 'end_turn' }),
      lastText: 'plain text answer (no protocol block)',
      messages,
      continueAttempted: false,
      options: makeOptions({ enabled: true, role: 'scout' }),
      emittedManagedProtocolPayload: undefined,
      completedTurnTokenSnapshot: fakeSnapshot(),
    });
    expect(out.outcome).toBe('continue');
    expect(out.nextContinueAttempted).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!._synthetic).toBe(true);
    const blocks = messages[1]!.content as Array<{ type: string; text: string }>;
    expect(blocks[0]!.text).toMatch(/required protocol was not emitted/);
    expect(blocks[0]!.text).toMatch(MANAGED_PROTOCOL_TOOL_NAME);
    expect(blocks[0]!.text).toMatch(/Do NOT output any text/);
    expect(blocks[0]!.text).toMatch(/```kodax-task-scout```/);
  });

  it('CAP-MANAGED-PROTO-AUTO-INLINED-BLOCK: lastText already contains the fenced block → no_op (model inlined it without calling the tool)', () => {
    const out = maybeAutoContinueManagedProtocol({
      result: makeResult({ stopReason: 'end_turn' }),
      lastText: 'Here is my analysis.\n```kodax-task-scout\n{...}\n```',
      messages: [],
      continueAttempted: false,
      options: makeOptions({ enabled: true, role: 'scout' }),
      emittedManagedProtocolPayload: undefined,
      completedTurnTokenSnapshot: fakeSnapshot(),
    });
    expect(out.outcome).toBe('no_op');
    expect(out.nextContinueAttempted).toBe(false);
  });
});
