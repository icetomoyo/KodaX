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

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { KodaXEvents, KodaXManagedProtocolPayload, KodaXOptions } from '../../types.js';
import {
  buildToolExecutionContext,
  buildWorkflowHostMetadata,
} from '../tool-execution-context.js';

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

  it('FEATURE_247 (R7): sessionId, taskSurface, and agentProfile are threaded onto the ctx for host-tool attribution', () => {
    const profile = { surface: 'partner', id: 'p1', version: '1.0.0', name: 'Acme Partner' };
    const ctx = buildToolExecutionContext({
      options: {
        provider: 'anthropic',
        context: { taskSurface: 'repl', agentProfile: profile },
      } as unknown as KodaXOptions,
      sessionId: 'sess-abc',
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect(ctx.sessionId).toBe('sess-abc');
    expect(ctx.taskSurface).toBe('repl');
    expect(ctx.agentProfile).toEqual(profile);
  });

  it('FEATURE_247 (R7): sessionId/taskSurface/agentProfile are undefined by default (default Coding Agent path unchanged)', () => {
    const ctx = buildToolExecutionContext({
      options: { provider: 'anthropic', context: {} } as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.taskSurface).toBeUndefined();
    expect(ctx.agentProfile).toBeUndefined();
  });

  it('CAP-TOOL-CTX-002: FEATURE_067 — onChildProgress is exactly undefined', () => {
    const ctx = buildToolExecutionContext({
      options: {} as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect(ctx.onChildProgress).toBeUndefined();
  });

  it('CAP-TOOL-CTX-003: parentAgentConfig snapshots provider/model/reasoning and repo-intelligence config', () => {
    const ctx = buildToolExecutionContext({
      options: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        modelOverride: 'claude-opus-4-8',
        effort: 'high',
        reasoningMode: 'deep',
        compaction: { triggerPercent: 60, triggerTokens: 120_000 },
        context: {
          repoIntelligenceMode: 'off',
          repoIntelligenceTrace: true,
        },
      } as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect(ctx.parentAgentConfig).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      effort: 'high',
      reasoningMode: 'deep',
      repoIntelligenceMode: 'off',
      repoIntelligenceTrace: true,
      compaction: { triggerPercent: 60, triggerTokens: 120_000 },
    });
  });

  it('CAP-TOOL-CTX-003b: binds exact-history loading to a root or isolated persistent child context', async () => {
    const loadFullLineage = vi.fn(async (_sessionId: string) => null);
    const storage = {
      load: async () => null,
      save: async () => undefined,
      loadFullLineage,
    };
    const root = buildToolExecutionContext({
      options: { session: { id: 'root-session', storage } } as KodaXOptions,
      sessionId: 'root-session',
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect(root.loadSessionHistory).toBeTypeOf('function');
    await expect(root.loadSessionHistory?.()).resolves.toBeNull();

    const child = buildToolExecutionContext({
      options: {
        session: { id: 'root-session', storage },
        context: { currentAgentId: 'child-1' },
      } as KodaXOptions,
      sessionId: 'root-session',
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect(child.loadSessionHistory).toBeUndefined();

    const isolatedChild = buildToolExecutionContext({
      options: {
        session: { id: 'worker-session', scope: 'managed-task-worker', storage },
        context: { currentAgentId: 'child-1' },
      } as KodaXOptions,
      sessionId: 'worker-session',
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect(isolatedChild.loadSessionHistory).toBeTypeOf('function');
    await expect(isolatedChild.loadSessionHistory?.()).resolves.toBeNull();
    expect(loadFullLineage).toHaveBeenLastCalledWith('worker-session');
  });

  it('CAP-TOOL-CTX-003c: history loading respects explicit tool exclusions and visibility policy', () => {
    const storage = {
      load: async () => null,
      save: async () => undefined,
      loadFullLineage: async () => null,
    };
    const build = (context: NonNullable<KodaXOptions['context']>) => buildToolExecutionContext({
      options: {
        session: { id: 'root-session', storage },
        context,
      } as KodaXOptions,
      sessionId: 'root-session',
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });

    const excluded = build({ excludeTools: ['session_history_read'] });
    expect(excluded.excludeTools).toEqual(['session_history_read']);
    expect(excluded.loadSessionHistory).toBeUndefined();
    expect(build({
      toolVisibilityPolicy: (tool) => tool.name !== 'session_history_search',
    }).loadSessionHistory).toBeUndefined();
  });

  it('CAP-TOOL-CTX-004a: emitManagedProtocol mutates the shared payload ref so multiple emissions accumulate (when managedProtocolEmission is enabled)', () => {
    // FEATURE_193 (v0.7.43) deep V1 cleanup: the V1 scout/contract/handoff
    // payload slices were physically removed; this contract now pins
    // accumulation through the single surviving `verdict` slot — a
    // second emission overwrites prior fields while preserving siblings.
    const ref = makeRef();
    const ctx = buildToolExecutionContext({
      options: {
        context: {
          managedProtocolEmission: { enabled: true, role: 'evaluator' },
        },
      } as unknown as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: ref,
    });
    expect(ctx.emitManagedProtocol).toBeDefined();

    ctx.emitManagedProtocol!({
      verdict: { source: 'evaluator', status: 'revise', followups: [], userFacingText: 'first' },
    });
    ctx.emitManagedProtocol!({
      verdict: { source: 'evaluator', status: 'accept', followups: [], userFacingText: 'second' },
    });

    // Both emissions accumulated into the single ref.current value.
    expect(ref.current?.verdict?.status).toBe('accept');
    expect(ref.current?.verdict?.userFacingText).toBe('second');
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

  it('CAP-TOOL-CTX-007: parentEvents preserves the full callback surface for child-dispatch telemetry', () => {
    const events: KodaXEvents = {
      onTextDelta: () => {},
      onToolProgress: () => {},
    };
    const ctx = buildToolExecutionContext({
      options: { events } as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });

    expect(ctx.parentEvents).toBe(events);
  });

  it('CAP-TOOL-CTX-008: sessionScratchDir is derived from session id and git root', () => {
    const gitRoot = path.resolve('cap-048-repo');
    const ctx = buildToolExecutionContext({
      options: {
        context: { gitRoot },
        session: { id: 'session A' },
      } as unknown as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });

    expect(ctx.sessionScratchDir).toBe(
      path.join(gitRoot, '.agent', 'tmp', 'sessions', 'session_A'),
    );
  });

  // F270: the model-callable run_workflow tool is hosted for AMA only. Prompt
  // policy limits activation to explicit Workflow requests; SA never hosts it.
  const baseDir = path.resolve('cap-048-workflow-runs');

  it('CAP-TOOL-CTX-009: workflowHost is wired when an AMA turn has a runs directory', () => {
    const ctx = buildToolExecutionContext({
      options: {
        workflowRunsBaseDir: baseDir,
        agentMode: 'ama',
        context: { workflowIntent: 'explicit' },
      } as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect(ctx.workflowHost).toBeDefined();
    expect(typeof ctx.workflowHost?.runInline).toBe('function');
  });

  it('FEATURE_247 (R7/R8): buildWorkflowHostMetadata carries sessionId / surface / taskSurface / projectRoot for host attribution', () => {
    const meta = buildWorkflowHostMetadata(
      {
        provider: 'anthropic',
        context: {
          gitRoot: '/repo',
          taskSurface: 'repl',
          agentProfile: { surface: 'partner' },
        },
      } as unknown as KodaXOptions,
      'sess-42',
    );
    expect(meta).toEqual({
      sessionId: 'sess-42',
      surface: 'partner',
      taskSurface: 'repl',
      projectRoot: '/repo',
    });
  });

  it('FEATURE_247 (R7/R8): buildWorkflowHostMetadata omits unknown fields (empty map when nothing is known)', () => {
    expect(
      buildWorkflowHostMetadata({ provider: 'anthropic', context: {} } as KodaXOptions, undefined),
    ).toEqual({});
    // sessionId-only is valid (a headless run with no workspace/profile).
    expect(
      buildWorkflowHostMetadata({ provider: 'anthropic', context: {} } as KodaXOptions, 'sess-1'),
    ).toEqual({ sessionId: 'sess-1' });
  });

  it('CAP-TOOL-CTX-010: workflowHost is undefined without a runs dir, or for SA / unset mode (FEATURE_249 leaves only these hostless)', () => {
    // No runs dir → no host even in AMA.
    expect(
      buildToolExecutionContext({
        options: { agentMode: 'ama' } as KodaXOptions,
        runtime: undefined,
        managedProtocolPayloadRef: makeRef(),
      }).workflowHost,
    ).toBeUndefined();

    // Runs dir set but the retired 'sa' label or an unset mode → no host. Only
    // the AMA label hosts a workflow.
    // 'ama' is deliberately NOT in this list post-FEATURE_249 — it now hosts (009).
    for (const agentMode of ['sa', undefined] as const) {
      expect(
        buildToolExecutionContext({
          options: { workflowRunsBaseDir: baseDir, agentMode } as unknown as KodaXOptions,
          runtime: undefined,
          managedProtocolPayloadRef: makeRef(),
        }).workflowHost,
        `agentMode=${String(agentMode)}`,
      ).toBeUndefined();
    }
  });

  it('CAP-TOOL-CTX-011: workflowHost is hidden from AMA without explicit Workflow intent', () => {
    const ctx = buildToolExecutionContext({
      options: { workflowRunsBaseDir: baseDir, agentMode: 'ama' } as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: makeRef(),
    });
    expect(ctx.workflowHost).toBeUndefined();
  });
});
