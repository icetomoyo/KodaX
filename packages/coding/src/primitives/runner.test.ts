/**
 * Unit tests for Runner (FEATURE_080 v0.7.23).
 *
 * Covers:
 *   - Generic dispatch: single-turn LLM call through injected `opts.llm`.
 *   - Session integration on generic path: user + assistant appended as
 *     `message` entries.
 *   - Preset dispatch: registered dispatcher receives agent + input + opts
 *     and its return value is returned verbatim.
 *   - Error surface: missing `llm` for generic agent yields a clear error.
 *   - `runStream` emits message + complete events in order.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgent, type Agent } from './agent.js';
import { createInMemorySession } from './session.js';
import {
  Runner,
  _resetPresetDispatchers,
  registerPresetDispatcher,
  type PresetDispatcher,
} from './runner.js';

describe('Runner', () => {
  afterEach(() => {
    _resetPresetDispatchers();
  });

  describe('generic dispatch', () => {
    const helloAgent: Agent = createAgent({
      name: 'test-hello',
      instructions: 'Be helpful and concise.',
    });

    it('calls the injected llm with system + user messages and returns output', async () => {
      type LlmFn = NonNullable<Parameters<typeof Runner.run>[2]>['llm'];
      const llm = vi.fn<NonNullable<LlmFn>>(async () => 'hello, world');
      const result = await Runner.run(helloAgent, 'say hi', { llm });
      expect(result.output).toBe('hello, world');
      expect(result.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
      expect(result.messages[0]!.content).toBe('Be helpful and concise.');
      expect(result.messages[1]!.content).toBe('say hi');
      expect(result.messages[2]!.content).toBe('hello, world');
      expect(llm).toHaveBeenCalledTimes(1);
      const call = llm.mock.calls[0]!;
      expect(call[0]).toHaveLength(2);
      expect(call[1]).toBe(helloAgent);
    });

    it('accepts a pre-built message array as input', async () => {
      const llm = vi.fn(async () => 'ok');
      const result = await Runner.run(helloAgent, [{ role: 'user', content: 'q1' }], { llm });
      expect(result.messages.map((m) => m.content)).toEqual([
        'Be helpful and concise.',
        'q1',
        'ok',
      ]);
    });

    it('supports instructions as a function', async () => {
      const fnAgent: Agent = createAgent({
        name: 'fn-agent',
        instructions: () => 'Dynamic instructions',
      });
      const llm = vi.fn(async () => 'reply');
      const result = await Runner.run(fnAgent, 'x', { llm });
      expect(result.messages[0]!.content).toBe('Dynamic instructions');
    });

    it('appends user + assistant to the provided Session', async () => {
      const session = createInMemorySession();
      const llm = vi.fn(async () => 'done');
      const result = await Runner.run(helloAgent, 'q', { llm, session });
      expect(result.sessionId).toBe(session.id);
      const collected: Array<{ role: string; content: unknown }> = [];
      for await (const entry of session.entries()) {
        if (entry.type === 'message') {
          const payload = entry.payload as { role: string; content: unknown };
          collected.push({ role: payload.role, content: payload.content });
        }
      }
      expect(collected).toEqual([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'done' },
      ]);
    });

    it('throws a clear error when neither llm nor preset is available', async () => {
      await expect(Runner.run(helloAgent, 'hi'))
        .rejects.toThrow(/no registered preset dispatcher/);
    });
  });

  describe('preset dispatch', () => {
    it('routes to the registered dispatcher when agent.name matches', async () => {
      const dispatcher: PresetDispatcher = vi.fn(async () => ({
        output: 'preset output',
        messages: [{ role: 'assistant' as const, content: 'preset output' }],
        sessionId: 'preset-session-1',
      }));
      registerPresetDispatcher('preset-agent', dispatcher);
      const agent: Agent = createAgent({
        name: 'preset-agent',
        instructions: 'ignored',
      });

      const result = await Runner.run(agent, 'hi', { presetOptions: { flag: true } });
      expect(result.output).toBe('preset output');
      expect(result.sessionId).toBe('preset-session-1');
      expect(dispatcher).toHaveBeenCalledTimes(1);
      expect(dispatcher).toHaveBeenCalledWith(agent, 'hi', { presetOptions: { flag: true } });
    });

    it('unregister function stops the dispatcher from matching', async () => {
      const dispatcher: PresetDispatcher = vi.fn(async () => ({
        output: 'x',
        messages: [],
      }));
      const unregister = registerPresetDispatcher('tmp-agent', dispatcher);
      unregister();
      const agent: Agent = createAgent({ name: 'tmp-agent', instructions: 'i' });
      await expect(Runner.run(agent, 'hi'))
        .rejects.toThrow(/no registered preset dispatcher/);
      expect(dispatcher).not.toHaveBeenCalled();
    });
  });

  describe('runStream', () => {
    it('yields one message event per assistant message then complete', async () => {
      const agent = createAgent({ name: 'stream-hello', instructions: 'sys' });
      const events: Array<{ kind: string }> = [];
      for await (const event of Runner.runStream(agent, 'hi', { llm: async () => 'reply' })) {
        events.push({ kind: event.kind });
      }
      expect(events.map((e) => e.kind)).toEqual(['message', 'complete']);
    });

    it('yields an error event when the run throws', async () => {
      const agent = createAgent({ name: 'stream-err', instructions: 'sys' });
      const events: Array<{ kind: string; error?: Error }> = [];
      for await (const event of Runner.runStream(agent, 'hi', {
        llm: async () => { throw new Error('llm boom'); },
      })) {
        events.push(event.kind === 'error' ? { kind: event.kind, error: event.error } : { kind: event.kind });
      }
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('error');
      expect(events[0]!.error?.message).toBe('llm boom');
    });
  });
});
