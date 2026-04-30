/**
 * FEATURE_101 v0.7.31.2 — Runner.run honours `manifest.maxIterations`
 * for admitted agents (min-wins against `RunOptions.maxToolLoopIterations`
 * and the engine default `MAX_TOOL_LOOP_ITERATIONS`).
 *
 * Closes a v0.7.31 silent-footgun: `ManifestPatch.clampMaxIterations`
 * was composed in `composePatches` but never written to the manifest
 * by `applyManifestPatch`, and `Runner.run`'s iteration cap was
 * sourced only from RunOptions. Any future invariant author who
 * emitted a `clampMaxIterations` patch would observe verdict=ok +
 * clampNotes but the cap would not actually narrow the loop.
 *
 * The fix wires the post-clamp manifest's `maxIterations` field
 * (added in v0.7.31.2) through the WeakMap binding registry so
 * Runner.run can read it after admission completed.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Agent, AgentMessage } from './agent.js';
import type { AgentManifest } from './admission.js';
import {
  setAdmittedAgentBindings,
  _resetAdmittedAgentBindings,
} from './admission-session.js';
import { Runner } from './runner.js';
import type {
  RunnerLlmResult,
  RunnableTool,
} from './runner-tool-loop.js';

const passthroughTool: RunnableTool = {
  name: 'noop',
  description: 'no-op tool used to keep the loop alive',
  input_schema: { type: 'object', properties: {} },
  execute: async () => ({ content: 'noop ok' }),
};

function buildAlwaysToolCallLlm(): (
  messages: readonly AgentMessage[],
) => Promise<RunnerLlmResult> {
  let n = 0;
  return async () => {
    n += 1;
    return { text: '', toolCalls: [{ id: `c${n}`, name: 'noop', input: {} }] };
  };
}

describe('Runner — manifest.maxIterations clamp', () => {
  afterEach(() => {
    // setAdmittedAgentBindings stores in a WeakMap; agents fall out of
    // scope after each it-block so the WeakMap entries are reclaimed
    // automatically. _resetAdmittedAgentBindings is called per-test below
    // anyway for determinism under parallel workers.
  });

  it('clamps the tool-loop iteration cap to manifest.maxIterations when admitted', async () => {
    const agent: Agent = {
      name: 'admitted-iter-clamped',
      instructions: 'loop',
      tools: [passthroughTool],
    };
    const manifest: AgentManifest = { ...agent, maxIterations: 3 };
    setAdmittedAgentBindings(agent, manifest, ['boundedRevise']);

    try {
      // RunOptions.maxToolLoopIterations is unset (defaults to 20). The
      // manifest cap of 3 should win — the run must throw at iteration 3,
      // not 20.
      await expect(
        Runner.run(agent, 'go', {
          llm: buildAlwaysToolCallLlm(),
          tracer: null,
        }),
      ).rejects.toThrow(/MAX_TOOL_LOOP_ITERATIONS \(3\)/);
    } finally {
      _resetAdmittedAgentBindings(agent);
    }
  });

  it('takes min-wins against opts.maxToolLoopIterations (manifest narrower)', async () => {
    const agent: Agent = {
      name: 'min-wins-manifest',
      instructions: 'loop',
      tools: [passthroughTool],
    };
    const manifest: AgentManifest = { ...agent, maxIterations: 2 };
    setAdmittedAgentBindings(agent, manifest, ['boundedRevise']);

    try {
      await expect(
        Runner.run(agent, 'go', {
          llm: buildAlwaysToolCallLlm(),
          tracer: null,
          maxToolLoopIterations: 50, // wider than manifest's 2 — manifest wins
        }),
      ).rejects.toThrow(/MAX_TOOL_LOOP_ITERATIONS \(2\)/);
    } finally {
      _resetAdmittedAgentBindings(agent);
    }
  });

  it('takes min-wins against opts.maxToolLoopIterations (opts narrower)', async () => {
    const agent: Agent = {
      name: 'min-wins-opts',
      instructions: 'loop',
      tools: [passthroughTool],
    };
    const manifest: AgentManifest = { ...agent, maxIterations: 100 };
    setAdmittedAgentBindings(agent, manifest, ['boundedRevise']);

    try {
      await expect(
        Runner.run(agent, 'go', {
          llm: buildAlwaysToolCallLlm(),
          tracer: null,
          maxToolLoopIterations: 4, // narrower than manifest's 100 — opts wins
        }),
      ).rejects.toThrow(/MAX_TOOL_LOOP_ITERATIONS \(4\)/);
    } finally {
      _resetAdmittedAgentBindings(agent);
    }
  });

  it('falls back to engine default when neither manifest nor opts sets a cap', async () => {
    const agent: Agent = {
      name: 'no-cap',
      instructions: 'loop',
      tools: [passthroughTool],
    };
    // Admitted but manifest has no maxIterations — should use engine default (20).
    const manifest: AgentManifest = { ...agent };
    setAdmittedAgentBindings(agent, manifest, ['boundedRevise']);

    try {
      await expect(
        Runner.run(agent, 'go', {
          llm: buildAlwaysToolCallLlm(),
          tracer: null,
        }),
      ).rejects.toThrow(/MAX_TOOL_LOOP_ITERATIONS \(20\)/);
    } finally {
      _resetAdmittedAgentBindings(agent);
    }
  });

  it('does not clamp trusted (un-admitted) agents even when binding-shape coincides', async () => {
    const trusted: Agent = {
      name: 'trusted',
      instructions: 'loop',
      tools: [passthroughTool],
    };
    // No setAdmittedAgentBindings — `getAdmittedAgentBindings` returns
    // undefined → manifestCap is undefined → optsCap survives unchanged.

    await expect(
      Runner.run(trusted, 'go', {
        llm: buildAlwaysToolCallLlm(),
        tracer: null,
        maxToolLoopIterations: 5,
      }),
    ).rejects.toThrow(/MAX_TOOL_LOOP_ITERATIONS \(5\)/);
  });
});
