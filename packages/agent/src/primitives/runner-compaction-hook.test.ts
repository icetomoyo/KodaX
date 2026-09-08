/**
 * FEATURE_179 (v0.7.42) — compaction hook trigger parity tests.
 *
 * The hook was previously fired only AFTER tool_result append. That boundary
 * silently skipped:
 *   1. Text-only end-of-turn termination (Runner returns at the no-tool-call
 *      branch without firing the hook).
 *   2. Idle-yield + multi-turn text replies where the agent never made a tool
 *      call between large context growths.
 *
 * FEATURE_179 moved the hook to the TOP of every tool-loop iteration, BEFORE
 * the LLM call. This aligns with claudecode (`query.ts:307-454`), opencode
 * (`processor.ts:609-613`), pi-mono (`agent-session.ts:949`), and KodaX SA
 * (`run-substrate.ts:621-627`).
 *
 * These tests pin the new contract so future refactors cannot reintroduce
 * the tool-result-only firing point.
 */

import { describe, expect, it } from 'vitest';

import { createAgent, type Agent } from './agent.js';
import { attachRunnerRecoveryTranscript, readRunnerRecoveryTranscript, Runner } from './runner.js';
import { ContextCapacityError } from '../context-capacity.js';
import { KodaXContextOverflowError } from '@kodax-ai/llm';
import type {
  RunnableTool,
  RunnerLlmResult,
} from './runner-tool-loop.js';
import type { AgentMessage } from './agent.js';

const noopTool: RunnableTool = {
  name: 'noop',
  description: 'no-op for testing',
  input_schema: { type: 'object', properties: {} },
  execute: async () => ({ content: 'noop ok' }),
};

const agentWithTools: Agent = createAgent({
  name: 'compaction-hook-test',
  instructions: 'test',
  tools: [noopTool],
});

const agentNoTools: Agent = createAgent({
  name: 'compaction-hook-text-only',
  instructions: 'test',
});

describe('Runner compactionHook — FEATURE_179 trigger parity', () => {
  it('retries a rejected generation once after replacing history without reexecuting tools', async () => {
    let toolExecutions = 0;
    let calls = 0;
    const agent = createAgent({ name: 'capacity-recovery', instructions: 'sys', tools: [{
      ...noopTool, execute: async () => { toolExecutions += 1; return { content: 'evidence '.repeat(1000) }; },
    }] });
    const result = await Runner.run(agent, 'inspect', { tracer: null,
      llm: async (): Promise<RunnerLlmResult> => {
        calls += 1;
        if (calls === 1) return { text: '', toolCalls: [{ id: 'one', name: 'noop', input: {} }] };
        if (calls === 2) throw new KodaXContextOverflowError({ inputTokensKind: 'unknown' });
        return { text: 'recovered', toolCalls: [] };
      },
      compactionHook: async (messages, rejection) => rejection ? messages.map((message) => (
        message.role === 'user' && Array.isArray(message.content)
          ? { ...message, content: message.content.map((block) => block.type === 'tool_result'
            ? { ...block, content: 'saved evidence' } : block) } : message
      )) : undefined,
    });
    expect(result.output).toBe('recovered');
    expect(calls).toBe(3);
    expect(toolExecutions).toBe(1);
  });

  it('does not retry an unchanged context or loop on a second capacity rejection', async () => {
    for (const shrink of [false, true]) {
      let calls = 0;
      await expect(Runner.run(agentNoTools, 'evidence '.repeat(100), { tracer: null,
        llm: async () => { calls += 1; throw new KodaXContextOverflowError({ inputTokensKind: 'unknown' }); },
        compactionHook: async (messages, error) => error && shrink
          ? messages.map((message) => message.role === 'user' ? { ...message, content: 'short' } : message)
          : undefined,
      })).rejects.toBeInstanceOf(KodaXContextOverflowError);
      expect(calls).toBe(shrink ? 2 : 1);
    }
  });
  it('fires the hook even on a text-only iteration (no tool calls)', async () => {
    // Before FEATURE_179 this case silently skipped the hook — Runner exited
    // at the no-tool-call branch without invoking it. With the new top-of-loop
    // location the hook fires BEFORE the LLM call regardless of what the LLM
    // returns.
    //
    // NOTE: the Runner passes a mutable transcript reference to the hook and
    // continues to push to that same array post-call. vi.fn().mock.calls
    // captures the reference, not a snapshot, so asserting role-shape inside
    // the hook closure is the correct way to test "what the hook saw".
    const seenRoles: string[][] = [];
    const hookCalls = { n: 0 };
    const hook = async (t: readonly AgentMessage[]) => {
      hookCalls.n++;
      seenRoles.push(t.map((m) => m.role));
      return undefined;
    };

    await Runner.run(agentNoTools, 'hi', {
      llm: async () => 'text-only response',
      compactionHook: hook,
      tracer: null,
    });

    expect(hookCalls.n).toBe(1);
    expect(seenRoles[0]).toEqual(['system', 'user']);
  });

  it('fires the hook once per iteration in a multi-step tool loop', async () => {
    // Three iters: tool call → tool call → text-only termination.
    // Top-of-loop hook fires before each LLM call → 3 invocations total.
    let llmCall = 0;
    const llm = async (): Promise<RunnerLlmResult> => {
      llmCall++;
      if (llmCall < 3) {
        return { text: '', toolCalls: [{ id: `c${llmCall}`, name: 'noop', input: {} }] };
      }
      return { text: 'done', toolCalls: [] };
    };
    let hookCalls = 0;
    const hook = async (_t: readonly AgentMessage[]) => {
      hookCalls++;
      return undefined;
    };

    await Runner.run(agentWithTools, 'go', {
      llm,
      compactionHook: hook,
      tracer: null,
    });

    expect(hookCalls).toBe(3);
  });

  it('sees the prior iteration’s tool_result on the next top-of-loop call', async () => {
    // Iter 0 hook sees: [system, user]
    // Iter 0 LLM emits tool_use → tool_result appended.
    // Iter 1 hook sees: [system, user, assistant(tool_use), user(tool_result)]
    // Then iter 1 LLM emits text-only → loop terminates.
    let llmCall = 0;
    const llm = async (): Promise<RunnerLlmResult> => {
      llmCall++;
      if (llmCall === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'noop', input: {} }] };
      }
      return { text: 'done', toolCalls: [] };
    };
    const transcriptsSeen: number[] = [];
    const hook = async (t: readonly AgentMessage[]) => {
      transcriptsSeen.push(t.length);
      return undefined;
    };

    await Runner.run(agentWithTools, 'go', { llm, compactionHook: hook, tracer: null });

    // First call: no assistant yet. Second call: prior assistant tool_use +
    // tool_result added, so length grew by exactly 2 between calls.
    expect(transcriptsSeen.length).toBe(2);
    expect(transcriptsSeen[1]).toBe(transcriptsSeen[0]! + 2);
  });

  it('uses the hook’s replacement transcript on the next LLM call', async () => {
    // Hook returns a shorter transcript on iter 1 — the iter 1 LLM call
    // should receive the compacted view.
    let llmCall = 0;
    const llmSeesAtCall: number[] = [];
    const llm = async (messages: readonly AgentMessage[]): Promise<RunnerLlmResult> => {
      llmCall++;
      llmSeesAtCall.push(messages.length);
      if (llmCall === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'noop', input: {} }] };
      }
      return { text: 'done', toolCalls: [] };
    };

    let hookCall = 0;
    const hook = async (t: readonly AgentMessage[]): Promise<readonly AgentMessage[] | undefined> => {
      hookCall++;
      if (hookCall === 2) {
        // Replace with a synthetic single-summary message.
        return [{ role: 'system', content: '[compacted]' } as AgentMessage];
      }
      return undefined;
    };

    await Runner.run(agentWithTools, 'go', { llm, compactionHook: hook, tracer: null });

    // Iter 0 LLM saw the original transcript (no replacement yet).
    // Iter 1 LLM saw the hook's replacement → exactly 1 message ([compacted]).
    expect(llmSeesAtCall.length).toBe(2);
    expect(llmSeesAtCall[1]).toBe(1);
    expect(llmSeesAtCall[0]).toBeGreaterThan(1);
  });

  it('does not abort the run when the hook throws', async () => {
    const llm = async () => 'ok';
    const hook = async () => {
      throw new Error('hook explode');
    };
    await expect(
      Runner.run(agentNoTools, 'hi', { llm, compactionHook: hook, tracer: null }),
    ).resolves.toMatchObject({ output: 'ok' });
  });

  it('preserves a committed replacement if a later recovery step fails', async () => {
    const committed: AgentMessage[] = [{ role: 'user', content: 'committed summary' }];
    const failure = new Error('artifact unavailable');
    attachRunnerRecoveryTranscript(failure, committed);
    const llm = vi.fn(async () => 'must not run with stale history');
    await expect(Runner.run(agentNoTools, 'old history', {
      llm, tracer: null, compactionHook: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(readRunnerRecoveryTranscript(failure)).toEqual(committed);
    expect(llm).not.toHaveBeenCalled();
  });

  it('carries the latest canonical transcript on a hard-capacity error', async () => {
    const capacityError = new ContextCapacityError({
      contextWindow: 1_000,
      currentTokens: 2_000,
      reservedResponseTokens: 100,
    }, 'Runner compaction test');

    let caught: unknown;
    try {
      await Runner.run(agentNoTools, 'RECOVERY_TRANSCRIPT_SENTINEL', {
        llm: async () => 'unreachable',
        compactionHook: async () => {
          throw capacityError;
        },
        tracer: null,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(capacityError);
    expect(readRunnerRecoveryTranscript(caught)).toEqual([
      { role: 'user', content: 'RECOVERY_TRANSCRIPT_SENTINEL' },
    ]);
  });

  it('fires the hook on iter 0 of a second Runner.run() with an existing transcript (idle-yield resume)', async () => {
    // Simulates: after a text-only termination the parent re-engages the
    // Runner with the accumulated history + a new user message. Iter 0 of
    // the new invocation must fire the hook so any prior growth is compacted
    // BEFORE the next LLM call. Pre-FEATURE_179 this case was silently
    // skipped on the AMA path.
    const accumulated: AgentMessage[] = [
      { role: 'user', content: 'prior request' },
      { role: 'assistant', content: 'prior reply' },
      { role: 'user', content: 'another prior' },
      { role: 'assistant', content: 'another reply' },
      { role: 'user', content: 'new request that may push over threshold' },
    ];
    let seenLen = -1;
    const hook = async (t: readonly AgentMessage[]) => {
      if (seenLen < 0) seenLen = t.length;
      return undefined;
    };

    await Runner.run(agentNoTools, accumulated, {
      llm: async () => 'fresh reply',
      compactionHook: hook,
      tracer: null,
    });

    // The hook saw the FULL accumulated history at iter 0 entry (system
    // prepended + every accumulated message).
    expect(seenLen).toBeGreaterThanOrEqual(accumulated.length);
  });

  it('is idempotent across iterations — compacted transcript is not re-compacted needlessly', async () => {
    // The hook returns its own transcript shape; verify the Runner uses the
    // returned reference identity correctly (same array → no replacement,
    // new array → replacement applied) so a "no-op when under threshold"
    // production hook does not cause spurious re-allocation.
    let llmCall = 0;
    const llm = async (): Promise<RunnerLlmResult> => {
      llmCall++;
      if (llmCall === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'noop', input: {} }] };
      }
      return { text: 'done', toolCalls: [] };
    };
    let hookCall = 0;
    const hook = async (t: readonly AgentMessage[]) => {
      hookCall++;
      // Return the same array reference (the documented "skip" signal)
      return t;
    };

    const result = await Runner.run(agentWithTools, 'go', {
      llm,
      compactionHook: hook,
      tracer: null,
    });
    // Run completed, hook was invoked twice (iter 0 + iter 1), no transcript
    // surgery happened in either case.
    expect(hookCall).toBe(2);
    expect(result.output).toBe('done');
  });
});
