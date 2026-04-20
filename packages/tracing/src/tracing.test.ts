/**
 * Unit test for FEATURE_083 (v0.7.24) tracing primitives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Tracer,
  addTracingProcessor,
  setTracingProcessors,
  shutdownTracing,
  type Span,
  type Trace,
  type TracingProcessor,
} from './index.js';

describe('@kodax/tracing', () => {
  beforeEach(() => {
    setTracingProcessors([]);
  });

  afterEach(() => {
    setTracingProcessors([]);
  });

  it('Tracer.startTrace creates a trace with a root span', () => {
    const tracer = new Tracer();
    const trace = tracer.startTrace({ name: 'unit-test' });

    expect(trace.id).toBeDefined();
    expect(trace.rootSpan.name).toBe('unit-test');
    expect(trace.rootSpan.data.kind).toBe('agent');
    expect(trace.rootSpan.children).toHaveLength(0);
    expect(trace.endedAt).toBeUndefined();
  });

  it('addChild nests spans under the parent', () => {
    const trace = new Tracer().startTrace({ name: 'parent' });
    const generation = trace.rootSpan.addChild('generation-1', {
      kind: 'generation',
      agentName: 'scout',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    const tool = trace.rootSpan.addChild('tool-call-1', {
      kind: 'tool_call',
      toolName: 'bash',
      status: 'ok',
    });

    expect(trace.rootSpan.children).toHaveLength(2);
    expect(generation.parentId).toBe(trace.rootSpan.id);
    expect(tool.parentId).toBe(trace.rootSpan.id);
    expect(generation.traceId).toBe(trace.id);
  });

  it('span.end is idempotent and sets endedAt', () => {
    const trace = new Tracer({ now: () => 10_000 }).startTrace({ name: 'idem' });
    const child = trace.rootSpan.addChild('child', {
      kind: 'tool_call',
      toolName: 'grep',
      status: 'ok',
    });
    child.end();
    const firstEnd = child.endedAt;
    child.end(); // second call is a no-op
    expect(child.endedAt).toBe(firstEnd);
  });

  it('setError records Error instances with stack traces', () => {
    const trace = new Tracer().startTrace({ name: 'err' });
    const child = trace.rootSpan.addChild('child', {
      kind: 'tool_call',
      toolName: 'bash',
      status: 'error',
    });
    child.setError(new Error('boom'));
    expect(child.error?.message).toBe('boom');
    expect(child.error?.stack).toContain('Error');
  });

  it('addTracingProcessor receives onSpanStart / onSpanEnd / onTraceEnd', () => {
    const events: Array<[string, string]> = [];
    const processor: TracingProcessor = {
      onSpanStart(span) {
        events.push(['start', span.name]);
      },
      onSpanEnd(span) {
        events.push(['end', span.name]);
      },
      onTraceEnd(trace) {
        events.push(['traceEnd', trace.rootSpan.name]);
      },
    };
    addTracingProcessor(processor);

    const trace = new Tracer().startTrace({ name: 'root' });
    const child = trace.rootSpan.addChild('child', {
      kind: 'tool_call',
      toolName: 'bash',
      status: 'ok',
    });
    child.end();
    trace.end();

    // The root span's creation fires at startTrace; the child via addChild.
    expect(events).toEqual([
      ['start', 'root'],
      ['start', 'child'],
      ['end', 'child'],
      ['end', 'root'],
      ['traceEnd', 'root'],
    ]);
  });

  it('registered processor errors do not break the traced workflow', () => {
    const brokenProcessor: TracingProcessor = {
      onSpanStart() {
        throw new Error('processor crash');
      },
      onSpanEnd() {
        throw new Error('processor crash');
      },
      onTraceEnd() {
        throw new Error('processor crash');
      },
    };
    addTracingProcessor(brokenProcessor);

    // Should not throw even though the processor throws on every hook.
    const trace = new Tracer().startTrace({ name: 'root' });
    const child = trace.rootSpan.addChild('child', {
      kind: 'tool_call',
      toolName: 'bash',
      status: 'ok',
    });
    child.end();
    trace.end();

    expect(trace.endedAt).toBeDefined();
  });

  it('setTracingProcessors replaces the whole list', () => {
    const first: TracingProcessor = {
      onSpanStart: vi.fn(),
      onSpanEnd: vi.fn(),
      onTraceEnd: vi.fn(),
    };
    const second: TracingProcessor = {
      onSpanStart: vi.fn(),
      onSpanEnd: vi.fn(),
      onTraceEnd: vi.fn(),
    };
    addTracingProcessor(first);
    setTracingProcessors([second]);

    const trace = new Tracer().startTrace({ name: 'root' });
    trace.end();

    expect(first.onSpanStart).not.toHaveBeenCalled();
    expect(second.onSpanStart).toHaveBeenCalled();
  });

  it('shutdownTracing awaits processor shutdown hooks', async () => {
    const shutdownMock = vi.fn(async () => { /* no-op */ });
    const processor: TracingProcessor = {
      onSpanStart() { /* noop */ },
      onSpanEnd() { /* noop */ },
      onTraceEnd() { /* noop */ },
      shutdown: shutdownMock,
    };
    addTracingProcessor(processor);

    await shutdownTracing();

    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('shutdownTracing tolerates processors without a shutdown hook', async () => {
    const processor: TracingProcessor = {
      onSpanStart() { /* noop */ },
      onSpanEnd() { /* noop */ },
      onTraceEnd() { /* noop */ },
    };
    addTracingProcessor(processor);

    await expect(shutdownTracing()).resolves.toBeUndefined();
  });

  it('deterministic id injection produces reproducible spans', () => {
    let spanCounter = 0;
    let traceCounter = 0;
    const tracer = new Tracer({
      now: () => 1_000,
      nextSpanId: () => `span-${++spanCounter}`,
      nextTraceId: () => `trace-${++traceCounter}`,
    });

    const trace = tracer.startTrace({ name: 'root' });
    const child = trace.rootSpan.addChild('child', {
      kind: 'tool_call',
      toolName: 'bash',
      status: 'ok',
    });

    expect(trace.id).toBe('trace-1');
    expect(trace.rootSpan.id).toBe('trace-1-root');
    expect(child.id).toBe('span-1');
    expect(child.startedAt).toBe(1_000);
  });

  it('collects nested children across 3 levels', () => {
    const trace = new Tracer().startTrace({ name: 'root' });
    const agent = trace.rootSpan.addChild('agent-1', {
      kind: 'agent',
      agentName: 'scout',
    });
    const gen = agent.addChild('gen-1', {
      kind: 'generation',
      agentName: 'scout',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    gen.end();
    agent.end();

    const collected = collectAllSpans(trace);
    expect(collected.map((s) => s.name)).toEqual(['root', 'agent-1', 'gen-1']);
    expect(gen.parentId).toBe(agent.id);
  });
});

function collectAllSpans(trace: Trace): Span[] {
  const acc: Span[] = [];
  const walk = (span: Span): void => {
    acc.push(span);
    for (const child of span.children) walk(child);
  };
  walk(trace.rootSpan);
  return acc;
}
