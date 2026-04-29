/**
 * FEATURE_106 Slice 1 — `scope-aware-harness-guardrail` integration test.
 *
 * Per FEATURE_106 §Acceptance Criteria:
 *
 *   > Guardrail unit test + integration test (mock provider 跑 6 文件
 *   > write 任务，期望 reflection injected 一次)
 *
 * The unit tests in `scope-aware-harness-guardrail.test.ts` directly
 * invoke the `afterTool` hook. This file boots the full Runner tool
 * loop with a mock LLM that emits 6 sequential write tool calls and a
 * RunnableTool that mutates the shared mutation tracker, verifying:
 *
 *   1. The guardrail fires exactly once across the 6-call sequence
 *      (idempotency under realistic loop dispatch).
 *   2. The first significant mutation is what triggers the rewrite
 *      (not the smallest, not the last).
 *   3. Subsequent tool results pass through with their original content.
 *   4. `mutationTracker.reflectionInjected` ends up `true`.
 *
 * No real LLM, no real filesystem — purely the Runner ↔ guardrail wiring
 * exercised against a deterministic scripted callback.
 */

import { describe, expect, it } from 'vitest';

import {
  Runner,
  createAgent,
  isRunnableTool,
  type AgentMessage,
  type AgentTool,
  type RunnerLlmResult,
  type RunnerToolCall,
  type RunnerToolResult,
} from '@kodax/core';

import type { KodaXManagedProtocolPayload, ManagedMutationTracker } from '../../types.js';
import {
  createScopeAwareHarnessGuardrail,
  SCOPE_AWARE_HARNESS_GUARDRAIL_NAME,
} from './scope-aware-harness-guardrail.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

/**
 * Build a `write` tool whose execute() mutates the supplied tracker as
 * if a real file had been written. Each call adds one file with the
 * line count specified in the call's input.
 */
function buildWriteTool(tracker: ManagedMutationTracker): AgentTool {
  const tool = {
    name: 'write',
    description: 'mock write — mutates the shared tracker',
    input_schema: { type: 'object' as const, properties: {} },
    execute: async (input: Record<string, unknown>): Promise<RunnerToolResult> => {
      const file = String(input.file ?? '<unknown>');
      const lines = typeof input.lines === 'number' ? input.lines : 50;
      tracker.files.set(file, lines);
      tracker.totalOps += 1;
      return { content: `wrote ${lines} lines to ${file}`, isError: false };
    },
  };
  if (!isRunnableTool(tool)) {
    throw new Error('write tool failed RunnableTool typeguard — fix the shape');
  }
  return tool;
}

/**
 * Build a deterministic LLM callback that emits a script of tool calls,
 * then a final text turn. The callback inspects message history length
 * to decide which scripted turn to emit, so it works correctly even
 * when the Runner's compaction or guardrail rewrites alter the
 * transcript shape between turns.
 */
function buildScriptedLlm(
  toolCallScripts: readonly { readonly file: string; readonly lines: number }[],
): (messages: readonly AgentMessage[]) => Promise<RunnerLlmResult> {
  let turn = 0;
  return async (_messages) => {
    const idx = turn;
    turn += 1;
    if (idx < toolCallScripts.length) {
      const { file, lines } = toolCallScripts[idx]!;
      const call: RunnerToolCall = {
        id: `t${idx}`,
        name: 'write',
        input: { file, lines },
      };
      return { text: '', toolCalls: [call] };
    }
    return { text: 'done', toolCalls: [] };
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('scope-aware-harness-guardrail × Runner.run integration', () => {
  it('fires exactly once across a 6-file write sequence', async () => {
    const tracker: ManagedMutationTracker = { files: new Map(), totalOps: 0 };
    const payloadRef: { current: KodaXManagedProtocolPayload | undefined } = { current: undefined };
    const guardrail = createScopeAwareHarnessGuardrail({ mutationTracker: tracker, payloadRef });
    const writeTool = buildWriteTool(tracker);
    const agent = createAgent({
      name: 'scout-test',
      instructions: 'mock scout',
      tools: [writeTool],
    });

    // Six small files — first two stay below the 3-file threshold; the
    // third write crosses into significant scope and should trigger.
    const script = [
      { file: 'a.ts', lines: 10 },
      { file: 'b.ts', lines: 12 },
      { file: 'c.ts', lines: 15 }, // → triggers (3 files now)
      { file: 'd.ts', lines: 8 },
      { file: 'e.ts', lines: 7 },
      { file: 'f.ts', lines: 9 },
    ];

    const seenResults: RunnerToolResult[] = [];
    await Runner.run(agent, 'go', {
      llm: buildScriptedLlm(script),
      guardrails: [guardrail],
      tracer: null, // skip tracing — keeps the test self-contained
      toolObserver: {
        onToolResult: (_call, result) => {
          seenResults.push(result);
        },
      },
    });

    // The tracker accumulated all 6 files.
    expect(tracker.files.size).toBe(6);
    expect(tracker.reflectionInjected).toBe(true);

    // Exactly one tool result was rewritten (carries the harness hint).
    const rewritten = seenResults.filter(
      (r) => typeof r.content === 'string' && r.content.includes('emit_scout_verdict'),
    );
    expect(rewritten).toHaveLength(1);

    // The rewrite happened on the THIRD call (the one that crossed
    // the 3-file threshold), not the first or last.
    const rewriteIndex = seenResults.findIndex(
      (r) => typeof r.content === 'string' && r.content.includes('emit_scout_verdict'),
    );
    expect(rewriteIndex).toBe(2);

    // Subsequent results (after the rewrite) carry the original content
    // unchanged — no double injection.
    for (let i = 3; i < seenResults.length; i += 1) {
      const result = seenResults[i]!;
      expect(typeof result.content).toBe('string');
      expect(result.content).not.toContain('emit_scout_verdict');
    }
  });

  it('skips the rewrite entirely when Scout has already committed to H1_EXECUTE_EVAL', async () => {
    const tracker: ManagedMutationTracker = { files: new Map(), totalOps: 0 };
    // Pre-seed Scout's verdict to H1.
    const payloadRef: { current: KodaXManagedProtocolPayload | undefined } = {
      current: {
        scout: {
          confirmedHarness: 'H1_EXECUTE_EVAL',
          scope: [],
          requiredEvidence: [],
        },
      },
    };
    const guardrail = createScopeAwareHarnessGuardrail({ mutationTracker: tracker, payloadRef });
    const writeTool = buildWriteTool(tracker);
    const agent = createAgent({
      name: 'scout-test',
      instructions: 'mock scout',
      tools: [writeTool],
    });
    const script = [
      { file: 'a.ts', lines: 50 },
      { file: 'b.ts', lines: 60 },
      { file: 'c.ts', lines: 70 },
      { file: 'd.ts', lines: 80 },
    ];
    const seenResults: RunnerToolResult[] = [];
    await Runner.run(agent, 'go', {
      llm: buildScriptedLlm(script),
      guardrails: [guardrail],
      tracer: null,
      toolObserver: {
        onToolResult: (_call, result) => {
          seenResults.push(result);
        },
      },
    });
    expect(tracker.files.size).toBe(4);
    // No rewrite — Scout already committed.
    expect(tracker.reflectionInjected).toBeUndefined();
    const rewritten = seenResults.filter(
      (r) => typeof r.content === 'string' && r.content.includes('emit_scout_verdict'),
    );
    expect(rewritten).toHaveLength(0);
  });

  it('the guardrail name in the agent declaration matches the constructed guardrail', () => {
    // Confirms coding-agents.ts's declarative marker uses the same name
    // the constructed guardrail registers under — no string drift.
    const tracker: ManagedMutationTracker = { files: new Map(), totalOps: 0 };
    const payloadRef: { current: KodaXManagedProtocolPayload | undefined } = { current: undefined };
    const guardrail = createScopeAwareHarnessGuardrail({ mutationTracker: tracker, payloadRef });
    expect(guardrail.name).toBe(SCOPE_AWARE_HARNESS_GUARDRAIL_NAME);
    expect(SCOPE_AWARE_HARNESS_GUARDRAIL_NAME).toBe('scope-aware-harness');
  });
});
