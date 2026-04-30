/**
 * Tests for FEATURE_101 v0.7.31.1 — runtime tool capability re-clamp.
 *
 * Closes the v0.7.31 gap where `toolPermission` only enforced the
 * activation-time cap (manifest tools ⊆ system_cap.allowedToolCapabilities).
 * Runtime sub-runs scoped narrower than system_cap had no enforcement
 * — admission would let the manifest declare `bash:network`, the
 * activated agent would still happily invoke a network tool from
 * inside a sub-run whose parent only allowed `read`.
 *
 * The patch adds `RunOptions.parentToolCapabilities` plus a runtime
 * filter inside `Runner.run` that rejects calls outside the narrower
 * set, materializing the rejection as an error tool_result the LLM
 * can observe and recover from.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Agent, AgentMessage } from './agent.js';
import type { AgentManifest, ToolCapability } from './admission.js';
import {
  setAdmittedAgentBindings,
  _resetAdmittedAgentBindings,
} from './admission-session.js';
import { Runner } from './runner.js';
import type {
  RunnerLlmResult,
  RunnableTool,
} from './runner-tool-loop.js';

const echoTool: RunnableTool = {
  name: 'echo_tool',
  description: 'demo echo tool',
  input_schema: { type: 'object', properties: {} },
  execute: async (input) => ({
    content: `echoed: ${JSON.stringify(input)}`,
  }),
};

describe('Runner — runtime capability re-clamp', () => {
  afterEach(() => {
    // No global state to reset.
  });

  it('blocks tool calls outside parentToolCapabilities for admitted agents', async () => {
    const agent: Agent = { name: 'admitted-clamped', instructions: 'work', tools: [echoTool] };
    const manifest: AgentManifest = { ...agent };
    setAdmittedAgentBindings(agent, manifest, ['toolPermission']);

    const turns: RunnerLlmResult[] = [
      { text: '', toolCalls: [{ id: 'c1', name: 'echo_tool', input: { x: 1 } }] },
      { text: 'done', toolCalls: [] },
    ];
    let turnIdx = 0;
    let lastTranscript: readonly AgentMessage[] = [];

    try {
      const result = await Runner.run(agent, 'go', {
        llm: async (messages) => {
          lastTranscript = messages;
          return turns[turnIdx++]!;
        },
        tracer: null,
        // Classify echo_tool as 'bash:network' for the test, and clamp
        // parent to 'read' only — the call must be blocked.
        capabilityClassifier: (name) =>
          name === 'echo_tool' ? ('bash:network' as ToolCapability) : undefined,
        parentToolCapabilities: ['read'],
      });
      // Run returns successfully but the tool result must be the
      // clamped error message.
      expect(result.output).toBe('done');
      const toolResult = lastTranscript.find((m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => (b as { type?: string }).type === 'tool_result'),
      );
      expect(toolResult).toBeDefined();
      const block = (toolResult!.content as readonly { type?: string; content?: unknown }[]).find(
        (b) => b.type === 'tool_result',
      );
      const text = (block as { content?: unknown })?.content;
      const stringified = typeof text === 'string' ? text : JSON.stringify(text);
      expect(stringified).toMatch(/clamped at runtime/);
      expect(stringified).toMatch(/bash:network/);
      expect(stringified).toMatch(/parent run's allowed set/);
    } finally {
      _resetAdmittedAgentBindings(agent);
    }
  });

  it('does not clamp trusted (un-admitted) agents even when parent cap is narrow', async () => {
    const trusted: Agent = { name: 'trusted', instructions: 'work', tools: [echoTool] };
    // No setAdmittedAgentBindings — agent is trusted.

    const turns: RunnerLlmResult[] = [
      { text: '', toolCalls: [{ id: 'c1', name: 'echo_tool', input: {} }] },
      { text: 'ok', toolCalls: [] },
    ];
    let turnIdx = 0;

    const result = await Runner.run(trusted, 'go', {
      llm: async () => turns[turnIdx++]!,
      tracer: null,
      capabilityClassifier: () => 'bash:network' as ToolCapability,
      parentToolCapabilities: ['read'],
    });
    expect(result.output).toBe('ok');
    // Trusted agent → tool ran, no clamp message in transcript.
    const transcript = result.messages;
    const stringified = JSON.stringify(transcript);
    expect(stringified).not.toMatch(/clamped at runtime/);
  });

  it('admits calls whose capability is in the parent set', async () => {
    const agent: Agent = { name: 'admitted-allowed', instructions: 'work', tools: [echoTool] };
    const manifest: AgentManifest = { ...agent };
    setAdmittedAgentBindings(agent, manifest, ['toolPermission']);

    const turns: RunnerLlmResult[] = [
      { text: '', toolCalls: [{ id: 'c1', name: 'echo_tool', input: {} }] },
      { text: 'fine', toolCalls: [] },
    ];
    let turnIdx = 0;

    try {
      const result = await Runner.run(agent, 'go', {
        llm: async () => turns[turnIdx++]!,
        tracer: null,
        // echo_tool classified as 'read' — parent allows read → call passes.
        capabilityClassifier: () => 'read' as ToolCapability,
        parentToolCapabilities: ['read'],
      });
      expect(result.output).toBe('fine');
      const stringified = JSON.stringify(result.messages);
      expect(stringified).not.toMatch(/clamped at runtime/);
    } finally {
      _resetAdmittedAgentBindings(agent);
    }
  });

  it('rejects unknown-capability tools when parent cap is set (conservative default)', async () => {
    const agent: Agent = { name: 'unknown-cap', instructions: 'work', tools: [echoTool] };
    const manifest: AgentManifest = { ...agent };
    setAdmittedAgentBindings(agent, manifest, ['toolPermission']);

    const turns: RunnerLlmResult[] = [
      { text: '', toolCalls: [{ id: 'c1', name: 'unknown_tool', input: {} }] },
      { text: 'recovered', toolCalls: [] },
    ];
    let turnIdx = 0;
    let lastTranscript: readonly AgentMessage[] = [];

    try {
      const result = await Runner.run(agent, 'go', {
        llm: async (messages) => {
          lastTranscript = messages;
          return turns[turnIdx++]!;
        },
        tracer: null,
        capabilityClassifier: () => undefined, // unknown
        parentToolCapabilities: ['read'],
      });
      expect(result.output).toBe('recovered');
      const stringified = JSON.stringify(lastTranscript);
      expect(stringified).toMatch(/clamped at runtime/);
      expect(stringified).toMatch(/<unknown>/);
    } finally {
      _resetAdmittedAgentBindings(agent);
    }
  });

  it('does not clamp when parentToolCapabilities is omitted', async () => {
    const agent: Agent = { name: 'no-clamp', instructions: 'work', tools: [echoTool] };
    const manifest: AgentManifest = { ...agent };
    setAdmittedAgentBindings(agent, manifest, ['toolPermission']);

    const turns: RunnerLlmResult[] = [
      { text: '', toolCalls: [{ id: 'c1', name: 'echo_tool', input: {} }] },
      { text: 'fine', toolCalls: [] },
    ];
    let turnIdx = 0;

    try {
      const result = await Runner.run(agent, 'go', {
        llm: async () => turns[turnIdx++]!,
        tracer: null,
        capabilityClassifier: () => 'bash:network' as ToolCapability,
        // No parentToolCapabilities — clamp is bypassed.
      });
      expect(result.output).toBe('fine');
      const stringified = JSON.stringify(result.messages);
      expect(stringified).not.toMatch(/clamped at runtime/);
    } finally {
      _resetAdmittedAgentBindings(agent);
    }
  });
});
