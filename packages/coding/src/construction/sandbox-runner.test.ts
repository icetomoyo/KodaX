/**
 * FEATURE_089 Phase 3.5 — sandbox-runner unit tests.
 *
 * Drives manifest test cases through `Runner.run` with a deterministic
 * mock LLM and verifies the per-case grading logic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Agent, AgentMessage, RunnerLlmReturn } from '@kodax/core';

import {
  _resetAgentResolverForTesting,
  registerConstructedAgent,
} from './agent-resolver.js';
import { runSandboxAgentTest } from './sandbox-runner.js';
import type { AgentArtifact } from './types.js';

function buildArtifact(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    kind: 'agent',
    name: overrides.name ?? 'sandbox-tester',
    version: overrides.version ?? '1.0.0',
    status: overrides.status ?? 'staged',
    createdAt: overrides.createdAt ?? Date.now(),
    content: overrides.content ?? {
      instructions: 'echo agent for sandbox tests',
      testCases: [
        {
          id: 'echo-hello',
          input: 'hello',
          expectFinalText: 'echo: hello',
        },
      ],
    },
  };
}

function buildEchoAgent(name = 'sandbox-tester'): Agent {
  return { name, instructions: 'echo' };
}

/** Mock LLM that prepends "echo: " to whatever the user said. */
const echoLlm = async (
  messages: readonly AgentMessage[],
  _agent: Agent,
): Promise<RunnerLlmReturn> => {
  const last = messages[messages.length - 1];
  const userText =
    typeof last?.content === 'string'
      ? last.content
      : Array.isArray(last?.content)
        ? (last.content
            .map((b) => (b as { text?: string }).text)
            .filter(Boolean)
            .join('') as string)
        : '';
  return { text: `echo: ${userText}`, toolCalls: [] };
};

beforeEach(() => {
  _resetAgentResolverForTesting();
});
afterEach(() => {
  _resetAgentResolverForTesting();
});

describe('runSandboxAgentTest — empty cases', () => {
  it('returns ok=true with empty cases array when no testCases declared', async () => {
    const artifact = buildArtifact({
      content: { instructions: 'i' }, // no testCases
    });
    const result = await runSandboxAgentTest(artifact, {
      llm: echoLlm,
      resolvedAgent: buildEchoAgent(),
    });
    expect(result.ok).toBe(true);
    expect(result.cases).toEqual([]);
  });
});

describe('runSandboxAgentTest — case grading', () => {
  it('passes a case where expectFinalText is found in the output', async () => {
    const artifact = buildArtifact();
    const result = await runSandboxAgentTest(artifact, {
      llm: echoLlm,
      resolvedAgent: buildEchoAgent(),
    });
    expect(result.ok).toBe(true);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]?.ok).toBe(true);
    expect(result.cases[0]?.output).toBe('echo: hello');
  });

  it('fails a case whose expectFinalText does not match the output', async () => {
    const artifact = buildArtifact({
      content: {
        instructions: 'i',
        testCases: [{ id: 'wrong', input: 'hello', expectFinalText: 'goodbye' }],
      },
    });
    const result = await runSandboxAgentTest(artifact, {
      llm: echoLlm,
      resolvedAgent: buildEchoAgent(),
    });
    expect(result.ok).toBe(false);
    expect(result.cases[0]?.ok).toBe(false);
    expect(result.cases[0]?.error).toContain('expectFinalText');
  });

  it('expectMatch / expectNotMatch via regex', async () => {
    const artifact = buildArtifact({
      content: {
        instructions: 'i',
        testCases: [
          { id: 'm-pass', input: 'hello', expectMatch: '^echo:' },
          { id: 'nm-pass', input: 'hello', expectNotMatch: 'error' },
          { id: 'nm-fail', input: 'hello', expectNotMatch: '^echo' },
        ],
      },
    });
    const result = await runSandboxAgentTest(artifact, {
      llm: echoLlm,
      resolvedAgent: buildEchoAgent(),
    });
    expect(result.ok).toBe(false);
    expect(result.cases.find((c) => c.caseId === 'm-pass')?.ok).toBe(true);
    expect(result.cases.find((c) => c.caseId === 'nm-pass')?.ok).toBe(true);
    expect(result.cases.find((c) => c.caseId === 'nm-fail')?.ok).toBe(false);
  });

  it('flags cases that declare none of the expect* fields', async () => {
    const artifact = buildArtifact({
      content: {
        instructions: 'i',
        testCases: [{ id: 'no-expect', input: 'hello' }],
      },
    });
    const result = await runSandboxAgentTest(artifact, {
      llm: echoLlm,
      resolvedAgent: buildEchoAgent(),
    });
    expect(result.ok).toBe(false);
    expect(result.cases[0]?.error).toContain('no expectMatch');
  });

  it('records a clear error message when expectMatch regex is malformed', async () => {
    const artifact = buildArtifact({
      content: {
        instructions: 'i',
        testCases: [{ id: 'bad-regex', input: 'hello', expectMatch: '(' }],
      },
    });
    const result = await runSandboxAgentTest(artifact, {
      llm: echoLlm,
      resolvedAgent: buildEchoAgent(),
    });
    expect(result.ok).toBe(false);
    expect(result.cases[0]?.error).toContain('expectMatch is not a valid regex');
  });
});

describe('runSandboxAgentTest — agent resolution fallback', () => {
  it('looks up the agent in the resolver when no resolvedAgent override is given', async () => {
    const artifact = buildArtifact({ name: 'in-resolver' });
    registerConstructedAgent(artifact);
    const result = await runSandboxAgentTest(artifact, { llm: echoLlm });
    expect(result.ok).toBe(true);
    expect(result.cases).toHaveLength(1);
  });

  it('returns per-case errors when the agent is missing from the resolver and no override is given', async () => {
    const artifact = buildArtifact({ name: 'missing-from-resolver' });
    const result = await runSandboxAgentTest(artifact, { llm: echoLlm });
    expect(result.ok).toBe(false);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]?.error).toContain('not found in resolver');
  });
});

describe('runSandboxAgentTest — budget timeout', () => {
  it('records a timeout error when a case exceeds budgetMs', async () => {
    const slowLlm: typeof echoLlm = async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { text: 'late', toolCalls: [] };
    };
    const artifact = buildArtifact({
      content: {
        instructions: 'i',
        testCases: [{ id: 'slow', input: 'hi', expectFinalText: 'late' }],
      },
    });
    const result = await runSandboxAgentTest(artifact, {
      llm: slowLlm,
      budgetMs: 5,
      resolvedAgent: buildEchoAgent(),
    });
    expect(result.ok).toBe(false);
    expect(result.cases[0]?.error).toContain('timeout');
  });
});
