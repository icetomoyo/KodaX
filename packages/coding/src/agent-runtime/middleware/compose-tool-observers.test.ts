/**
 * FEATURE_187 (v0.7.43) Phase D — composeToolObservers tests.
 *
 * Pins the three precedence-critical behaviours:
 *   1. beforeTool runs in order + short-circuits on first non-true result
 *   2. onToolCall fans out to every observer (no short-circuit)
 *   3. onToolResult fans out to every observer (no short-circuit)
 *
 * Plus a few edge cases (zero observers, undefined hooks, async order).
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  RunnerToolCall,
  RunnerToolObserver,
  RunnerToolResult,
} from '@kodax-ai/agent';

import { composeToolObservers } from './compose-tool-observers.js';
import { ContextCapacityError } from '@kodax-ai/agent';
import { KodaXProviderError } from '@kodax-ai/llm';
import { ToolResultBatchCapacityError } from '../../tools/tool-result-policy.js';

const SAMPLE_CALL: RunnerToolCall = {
  name: 'read',
  id: 'tool_1',
  input: { file_path: '/x' },
};
const SAMPLE_RESULT: RunnerToolResult = { content: 'file contents' };

describe('composeToolObservers — local failure provenance', () => {
  it.each(['onToolCall', 'onToolResult', 'onToolExecutionStart', 'onToolExecutionEnd'] as const)(
    'marks local exceptions from %s without continuing fan-out', (event) => {
      const failure = new TypeError('observer failed');
      const later = vi.fn();
      const composed = composeToolObservers({ [event]: () => { throw failure; } }, { [event]: later });
      expect(() => composed[event]!(SAMPLE_CALL, SAMPLE_RESULT)).toThrow(failure);
      expect(failure).toMatchObject({ executionFailure: { source: 'local', errorName: 'TypeError' } });
      expect(later).not.toHaveBeenCalled();
    },
  );

  it.each([
    Object.assign(new Error('stop'), { name: 'AbortError' }),
    new KodaXProviderError('provider failure'),
    new ContextCapacityError({ currentTokens: 100, contextWindow: 10, reservedResponseTokens: 1 }),
    new ToolResultBatchCapacityError(100, 10),
  ])('preserves existing typed failure $name', (failure) => {
    const composed = composeToolObservers({ onToolCall: () => { throw failure; } });
    expect(() => composed.onToolCall!(SAMPLE_CALL)).toThrow(failure);
    expect(failure).not.toHaveProperty('executionFailure');
  });

  it('does not overwrite attributed errors or classify async permission/provider gates', async () => {
    const executionFailure = { source: 'provider', errorClass: 'connection_failure' };
    const attributed = Object.assign(new Error('existing failure'), { executionFailure });
    const providerFailure = new Error('untyped upstream failure');
    const composed = composeToolObservers({
      onToolCall: () => { throw attributed; },
      beforeTool: async () => { throw providerFailure; },
    });
    expect(() => composed.onToolCall!(SAMPLE_CALL)).toThrow(attributed);
    expect(attributed.executionFailure).toBe(executionFailure);
    await expect(composed.beforeTool!(SAMPLE_CALL)).rejects.toBe(providerFailure);
    expect(providerFailure).not.toHaveProperty('executionFailure');
  });
});

describe('composeToolObservers — beforeTool precedence', () => {
  it('invokes beforeTool in argument order and returns the first short-circuit verdict', async () => {
    const order: string[] = [];
    const a: RunnerToolObserver = {
      beforeTool: async () => {
        order.push('a');
        return true;
      },
    };
    const b: RunnerToolObserver = {
      beforeTool: async () => {
        order.push('b');
        return 'blocked-by-b';
      },
    };
    const c: RunnerToolObserver = {
      beforeTool: async () => {
        order.push('c');
        return true;
      },
    };

    const composed = composeToolObservers(a, b, c);
    const verdict = await composed.beforeTool!(SAMPLE_CALL);

    expect(verdict).toBe('blocked-by-b');
    // 'c' must NOT run — b short-circuited.
    expect(order).toEqual(['a', 'b']);
  });

  it('passes through true / undefined and only blocks on string or false', async () => {
    const a: RunnerToolObserver = { beforeTool: async () => undefined };
    const b: RunnerToolObserver = { beforeTool: async () => true };
    const c: RunnerToolObserver = { beforeTool: async () => false };

    const composed = composeToolObservers(a, b, c);
    expect(await composed.beforeTool!(SAMPLE_CALL)).toBe(false);
  });

  it('returns true when every observer allows', async () => {
    const a: RunnerToolObserver = { beforeTool: async () => true };
    const b: RunnerToolObserver = { beforeTool: async () => undefined };

    const composed = composeToolObservers(a, b);
    expect(await composed.beforeTool!(SAMPLE_CALL)).toBe(true);
  });

  it('skips observers without a beforeTool hook', async () => {
    const a: RunnerToolObserver = { onToolCall: () => undefined };
    const b: RunnerToolObserver = { beforeTool: async () => 'blocked-by-b' };

    const composed = composeToolObservers(a, b);
    expect(await composed.beforeTool!(SAMPLE_CALL)).toBe('blocked-by-b');
  });
});

describe('composeToolObservers — onToolCall fan-out', () => {
  it('invokes onToolCall on every observer (no short-circuit)', () => {
    const aSpy = vi.fn();
    const bSpy = vi.fn();
    const cSpy = vi.fn();
    const composed = composeToolObservers(
      { onToolCall: aSpy },
      { onToolCall: bSpy },
      { onToolCall: cSpy },
    );

    composed.onToolCall!(SAMPLE_CALL);

    expect(aSpy).toHaveBeenCalledOnce();
    expect(bSpy).toHaveBeenCalledOnce();
    expect(cSpy).toHaveBeenCalledOnce();
  });

  it('preserves invocation order across observers', () => {
    const order: string[] = [];
    const composed = composeToolObservers(
      { onToolCall: () => { order.push('a'); } },
      { onToolCall: () => { order.push('b'); } },
      { onToolCall: () => { order.push('c'); } },
    );

    composed.onToolCall!(SAMPLE_CALL);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('skips observers without onToolCall', () => {
    const bSpy = vi.fn();
    const composed = composeToolObservers(
      { beforeTool: async () => true },
      { onToolCall: bSpy },
    );

    expect(() => composed.onToolCall!(SAMPLE_CALL)).not.toThrow();
    expect(bSpy).toHaveBeenCalledOnce();
  });
});

describe('composeToolObservers — onToolResult fan-out', () => {
  it('invokes onToolResult on every observer (no short-circuit)', () => {
    const aSpy = vi.fn();
    const bSpy = vi.fn();
    const composed = composeToolObservers(
      { onToolResult: aSpy },
      { onToolResult: bSpy },
    );

    composed.onToolResult!(SAMPLE_CALL, SAMPLE_RESULT);

    expect(aSpy).toHaveBeenCalledWith(SAMPLE_CALL, SAMPLE_RESULT);
    expect(bSpy).toHaveBeenCalledWith(SAMPLE_CALL, SAMPLE_RESULT);
  });
});

describe('composeToolObservers — zero-arg + edge cases', () => {
  it('zero-argument call returns a usable no-op observer', async () => {
    const composed = composeToolObservers();
    expect(await composed.beforeTool!(SAMPLE_CALL)).toBe(true);
    expect(() => composed.onToolCall!(SAMPLE_CALL)).not.toThrow();
    expect(() => composed.onToolResult!(SAMPLE_CALL, SAMPLE_RESULT)).not.toThrow();
  });

  it('does NOT mutate the input observers (keys, hook identities, OR call counts)', () => {
    // Strengthened mutation test: not only does the snapshot still
    // match after composition (shallow check), but invoking the
    // composed observer's lifecycle methods must NOT cause the input
    // observers' hook references to be reassigned, nor leak
    // unexpected calls beyond what the caller drives.
    const aSpy = vi.fn();
    const aOriginal: RunnerToolObserver = { onToolCall: aSpy };
    const aBeforeCompose = {
      keys: Object.keys(aOriginal).sort(),
      onToolCallRef: aOriginal.onToolCall,
    };

    const composed = composeToolObservers(aOriginal);
    // Pre-invoke snapshot: keys + hook identity preserved.
    expect(Object.keys(aOriginal).sort()).toEqual(aBeforeCompose.keys);
    expect(aOriginal.onToolCall).toBe(aBeforeCompose.onToolCallRef);

    // Drive the composed observer once; the input must not pick up
    // any new hooks or lose its existing onToolCall.
    composed.onToolCall!(SAMPLE_CALL);
    expect(Object.keys(aOriginal).sort()).toEqual(aBeforeCompose.keys);
    expect(aOriginal.onToolCall).toBe(aBeforeCompose.onToolCallRef);
    expect(aSpy).toHaveBeenCalledOnce();
  });
});
