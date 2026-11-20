/**
 * Unit test for coding-preset wiring: `Runner.run` dispatches a coding Agent
 * through `Agent.substrateExecutor` (ADR-020). The public preset runs the
 * managed Worker; the internal leaf declaration runs the direct substrate.
 */

import { describe, expect, it, vi } from 'vitest';

const mockedResult = vi.hoisted(() => async () => ({
  success: true,
  lastText: 'mocked output',
  messages: [{ role: 'assistant' as const, content: 'mocked output' }],
  sessionId: 'mock-session',
}));
vi.mock('./agent-runtime/run-substrate.js', () => ({ runSubstrate: vi.fn(mockedResult) }));
vi.mock('./task-engine.js', () => ({ runKodaX: vi.fn(mockedResult) }));

import { Runner, createAgent, type PresetDispatcher } from '@kodax-ai/agent';
import { runSubstrate } from './agent-runtime/run-substrate.js';
import {
  DEFAULT_CODING_AGENT_NAME,
  createCodingAgent,
  extractFinalAssistantText,
} from './coding-preset.js';
import { createDefaultCodingAgent } from './default-coding-agent.js';
import { runKodaX } from './task-engine.js';
import type { KodaXResult } from './types.js';

function makeResult(partial: Partial<KodaXResult>): KodaXResult {
  return {
    success: true,
    lastText: '',
    messages: [],
    sessionId: 'test',
    ...partial,
  } as KodaXResult;
}

describe('coding-preset', () => {
  it('does not advertise retired judge model calls as active default middleware', () => {
    const agent = createDefaultCodingAgent();
    expect(agent.middleware?.find(entry => entry.name === 'preAnswerJudge')?.enabled).toBe(false);
    expect(agent.middleware?.find(entry => entry.name === 'postToolJudge')?.enabled).toBe(false);
    expect(agent.middleware?.find(entry => entry.name === 'mutationReflection')?.enabled).toBe(true);
  });

  it('createDefaultCodingAgent returns an agent with the stable dispatch name', () => {
    const agent = createDefaultCodingAgent();
    expect(agent.name).toBe(DEFAULT_CODING_AGENT_NAME);
    expect(typeof agent.instructions).toBe('string');
  });

  it('createDefaultCodingAgent attaches a substrate executor closure on the declaration', () => {
    const agent = createDefaultCodingAgent();
    expect(typeof agent.substrateExecutor).toBe('function');
  });

  it('the public preset runs a root Run on the managed Worker', async () => {
    vi.mocked(runKodaX).mockClear();
    vi.mocked(runSubstrate).mockClear();

    const result = await Runner.run(createDefaultCodingAgent(), 'Fix the bug.', {
      presetOptions: { provider: 'test-provider' },
      tracer: null,
    });

    expect(result.output).toBe('mocked output');
    expect(vi.mocked(runKodaX).mock.calls[0]?.[1]).toBe('Fix the bug.');
    expect(vi.mocked(runKodaX).mock.calls[0]?.[0].provider).toBe('test-provider');
    expect(runSubstrate).not.toHaveBeenCalled();
  });

  it('a leaf declaration runs the executor it was built with', async () => {
    vi.mocked(runKodaX).mockClear();
    vi.mocked(runSubstrate).mockClear();
    const agent = createCodingAgent(runSubstrate);

    await Runner.run(agent, 'Inspect the file.', { presetOptions: { provider: 'test-provider' }, tracer: null });

    expect(vi.mocked(runSubstrate).mock.calls[0]?.[2]).toBe(agent);
    expect(runKodaX).not.toHaveBeenCalled();
  });

  it('Runner.run delegates to Agent.substrateExecutor (declaration-borne, no registry)', async () => {
    const mock: PresetDispatcher = vi.fn(async () => ({
      output: 'mocked coding output',
      messages: [{ role: 'assistant' as const, content: 'mocked coding output' }],
      sessionId: 'mock-session',
    }));
    // Build a custom agent with our mock executor — proves Runner.run
    // dispatches off the declaration field, not a global registry.
    const customAgent = createAgent({
      name: 'test/coding/declaration-borne',
      instructions: 'test',
      substrateExecutor: mock,
    });
    const result = await Runner.run(customAgent, 'implement thing', {
      presetOptions: { provider: 'test-provider' },
      tracer: null,
    });
    expect(result.output).toBe('mocked coding output');
    expect(result.sessionId).toBe('mock-session');
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(
      customAgent,
      'implement thing',
      { presetOptions: { provider: 'test-provider' }, tracer: null },
    );
  });

  it('preserves top-level Runner permission intent through the default coding preset', async () => {
    const permissionIntent = {
      rootUserIntent: 'Review the current changes without modifying files.',
      delegatedObjective: 'Inspect the permission implementation.',
      bindingConstraints: ['Do not modify files.'],
      scopeHint: 'packages/repl/src/permission',
      readOnly: true,
    } as const;
    vi.mocked(runKodaX).mockClear();

    await Runner.run(createDefaultCodingAgent(), 'Review the current changes.', {
      permissionIntent,
      presetOptions: {
        context: {
          configHome: 'C:\\kodax-config',
          permissionIntent: { rootUserIntent: 'stale preset intent' },
        },
      },
      tracer: null,
    });

    const substrateOptions = vi.mocked(runKodaX).mock.calls[0]?.[0];
    expect(substrateOptions?.context?.permissionIntent).toEqual(permissionIntent);
    expect(substrateOptions?.context?.configHome).toBe('C:\\kodax-config');
  });

  it('preserves a preset permission intent when Runner does not override it', async () => {
    const presetIntent = {
      rootUserIntent: 'Inspect the current state.',
      readOnly: true,
    } as const;
    vi.mocked(runKodaX).mockClear();

    await Runner.run(createDefaultCodingAgent(), 'Inspect the current state.', {
      presetOptions: { context: { permissionIntent: presetIntent } },
      tracer: null,
    });

    expect(vi.mocked(runKodaX).mock.calls[0]?.[0].context?.permissionIntent)
      .toEqual(presetIntent);
  });

  it('createDefaultCodingAgent accepts overrides for declarative fields', () => {
    const agent = createDefaultCodingAgent({
      reasoning: { default: 'deep' },
      guardrails: [{ kind: 'input', name: 'safety' }],
    });
    expect(agent.reasoning?.default).toBe('high');
    expect(agent.guardrails).toHaveLength(1);
    expect(agent.guardrails?.[0]).toEqual({ kind: 'input', name: 'safety' });
    expect(agent.name).toBe(DEFAULT_CODING_AGENT_NAME);
    // Overrides MUST NOT overwrite the substrate executor closure.
    expect(typeof agent.substrateExecutor).toBe('function');
  });
});

describe('extractFinalAssistantText — placeholder/empty filter (P1③)', () => {
  it('returns real lastText unchanged', () => {
    const result = makeResult({ lastText: 'here is the answer' });
    expect(extractFinalAssistantText(result)).toBe('here is the answer');
  });

  it('does NOT surface a legacy persisted "..." as a real reply', () => {
    // lastText empty → walks back to the last assistant message. A legacy
    // session may carry a `'...'` placeholder block; it is not a real reply.
    const result = makeResult({
      lastText: '',
      messages: [
        { role: 'user', content: 'do x' },
        { role: 'assistant', content: [{ type: 'text', text: '...' }] },
      ],
    });
    expect(extractFinalAssistantText(result)).toBe('');
  });

  it('does NOT surface a bare empty-text marker as a real reply', () => {
    const result = makeResult({
      lastText: '',
      messages: [
        { role: 'user', content: 'do x' },
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
      ],
    });
    expect(extractFinalAssistantText(result)).toBe('');
  });

  it('treats a lastText that is only "..." as no reply', () => {
    const result = makeResult({ lastText: '...' });
    expect(extractFinalAssistantText(result)).toBe('');
  });

  it('does NOT punch through a placeholder final turn to an earlier turn (resumed-session safety)', () => {
    // If THIS run's final assistant turn is a placeholder, the run produced no
    // visible reply → return ''. Resurfacing 'real earlier answer' would, in a
    // resumed `-c` session, return the answer to a DIFFERENT (previous) question.
    const result = makeResult({
      lastText: '',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'real earlier answer' }] },
        { role: 'user', content: 'noop' },
        { role: 'assistant', content: [{ type: 'text', text: '...' }] },
      ],
    });
    expect(extractFinalAssistantText(result)).toBe('');
  });

  it('returns "" when this run has no assistant turn (trailing normal user — interrupted/error)', () => {
    // Shape [prev-turn assistant, this-turn user]: provider error or
    // interrupted before the assistant turn. Must NOT punch back to the prior
    // turn's answer (which, in a resumed session, answered a DIFFERENT question).
    const result = makeResult({
      lastText: '',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
        { role: 'user', content: 'a different new question' },
      ],
    });
    expect(extractFinalAssistantText(result)).toBe('');
  });

  it('walks back past a trailing tool_result user turn to the real final assistant answer', () => {
    // Walking back past NON-assistant trailing messages is still correct — the
    // most-recent assistant IS the final answer, just not the literal last msg.
    const result = makeResult({
      lastText: '',
      messages: [
        { role: 'user', content: 'do x' },
        { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
      ],
    });
    expect(extractFinalAssistantText(result)).toBe('the answer');
  });
});
