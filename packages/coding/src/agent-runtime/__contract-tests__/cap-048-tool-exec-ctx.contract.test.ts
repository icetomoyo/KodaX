/**
 * Contract test for CAP-048: tool execution context construction with
 * FEATURE_074 callback policy
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-048-tool-execution-context-construction-with-feature_074-callback-policy
 *
 * Test obligations:
 * - CAP-TOOL-CTX-001: FEATURE_074 — set_permission_mode is NOT
 *   forwarded to KodaXToolExecutionContext
 * - CAP-TOOL-CTX-002: FEATURE_067 — onChildProgress is undefined
 * - CAP-TOOL-CTX-003: parentAgentConfig propagates to tool ctx
 * - CAP-TOOL-CTX-004: emitManagedProtocol closure mutates the shared
 *   payload ref; multiple emissions accumulate
 * - CAP-TOOL-CTX-005: emitManagedProtocol is undefined when
 *   managedProtocolEmission is not enabled
 *
 * Risk: HIGH (security-sensitive: FEATURE_074 explicitly prevents
 * permission widening — the absence of `set_permission_mode` is the
 * load-bearing invariant).
 *
 * Class: 1
 *
 * Verified location: agent-runtime/tool-execution-context.ts:51
 * (`buildToolExecutionContext`, extracted from agent.ts:419-460 during
 * FEATURE_100 P3.6p).
 *
 * Time-ordering constraint: constructed once at frame entry; passed to
 * every tool dispatch.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6p.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXManagedProtocolPayload, KodaXOptions } from '../../types.js';
import { buildToolExecutionContext } from '../tool-execution-context.js';

function makeRef(): { current: KodaXManagedProtocolPayload | undefined } {
  return { current: undefined };
}

describe('CAP-048: tool execution context construction contract', () => {
  it('CAP-TOOL-CTX-001: FEATURE_074 — set_permission_mode is NOT a property on the constructed tool execution context', () => {
    const eventsWithSetPermission = {
      // Even if the caller passes a set_permission_mode callback,
      // buildToolExecutionContext must NOT forward it.
      set_permission_mode: () => {
        throw new Error('this should never be called');
      },
    };
    const ctx = buildToolExecutionContext({
      options: { events: eventsWithSetPermission } as unknown as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect('set_permission_mode' in ctx).toBe(false);
  });

  it('CAP-TOOL-CTX-002: FEATURE_067 — onChildProgress is exactly undefined', () => {
    const ctx = buildToolExecutionContext({
      options: {} as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect(ctx.onChildProgress).toBeUndefined();
  });

  it('CAP-TOOL-CTX-003: parentAgentConfig snapshots options.provider / options.model / options.reasoningMode', () => {
    const ctx = buildToolExecutionContext({
      options: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        reasoningMode: 'deep',
      } as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect(ctx.parentAgentConfig).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      reasoningMode: 'deep',
    });
  });

  it('CAP-TOOL-CTX-004a: emitManagedProtocol mutates the shared payload ref so multiple emissions accumulate (when managedProtocolEmission is enabled)', () => {
    const ref = makeRef();
    const ctx = buildToolExecutionContext({
      options: {
        context: {
          managedProtocolEmission: { enabled: true, role: 'scout' },
        },
      } as unknown as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: ref,
    });
    expect(ctx.emitManagedProtocol).toBeDefined();

    ctx.emitManagedProtocol!({
      verdict: { source: 'evaluator', status: 'accept', followups: [], userFacingText: 'first' },
    });
    ctx.emitManagedProtocol!({
      scout: { summary: 'second', scope: [], requiredEvidence: [] },
    });

    // Both emissions accumulated into the single ref.current value.
    expect(ref.current?.verdict?.userFacingText).toBe('first');
    expect(ref.current?.scout?.summary).toBe('second');
  });

  it('CAP-TOOL-CTX-005: emitManagedProtocol is undefined when managedProtocolEmission is not enabled', () => {
    const ref = makeRef();

    // Case 1: no managedProtocolEmission at all
    expect(
      buildToolExecutionContext({
        options: {} as KodaXOptions,
        runtime: undefined,
        managedProtocolPayloadRef: ref,
      }).emitManagedProtocol,
    ).toBeUndefined();

    // Case 2: managedProtocolEmission present but enabled: false
    expect(
      buildToolExecutionContext({
        options: {
          context: {
            managedProtocolEmission: { enabled: false, role: 'scout' },
          },
        } as unknown as KodaXOptions,
        runtime: undefined,
        managedProtocolPayloadRef: ref,
      }).emitManagedProtocol,
    ).toBeUndefined();
  });

  it('CAP-TOOL-CTX-006: askUser / askUserInput / exitPlanMode are forwarded from options.events when present', () => {
    const askUser = () => {};
    const askUserInput = () => {};
    const exitPlanMode = () => {};
    const ctx = buildToolExecutionContext({
      options: {
        events: { askUser, askUserInput, exitPlanMode },
      } as unknown as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect(ctx.askUser).toBe(askUser);
    expect(ctx.askUserInput).toBe(askUserInput);
    expect(ctx.exitPlanMode).toBe(exitPlanMode);
  });
});
