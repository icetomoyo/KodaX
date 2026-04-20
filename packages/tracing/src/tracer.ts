/**
 * Tracer — convenience façade that creates Traces wired to the registered
 * processors and default id generators.
 *
 * FEATURE_083 (v0.7.24): callers typically use the default tracer:
 *
 *     const trace = defaultTracer.startTrace({ name: 'coding-run' });
 *     const child = trace.rootSpan.addChild('generation', { kind: 'generation', ... });
 *     // ... do work ...
 *     child.end();
 *     trace.end();
 *
 * Advanced callers can inject a custom clock / id generator for
 * deterministic tests.
 */

import { createTrace, type Trace, type TraceOptions } from './trace.js';
import { _emitSpanStart, _emitSpanEnd, _emitTraceEnd } from './processor.js';

export interface StartTraceOptions {
  readonly id?: string;
  readonly name?: string;
  readonly rootSpanData?: TraceOptions['rootSpanData'];
  readonly metadata?: ReadonlyMap<string, unknown>;
}

export interface TracerOptions {
  readonly now?: () => number;
  readonly nextSpanId?: () => string;
  readonly nextTraceId?: () => string;
}

export class Tracer {
  private readonly options: TracerOptions;

  constructor(options: TracerOptions = {}) {
    this.options = options;
  }

  startTrace(opts: StartTraceOptions = {}): Trace {
    return createTrace({
      id: opts.id,
      name: opts.name,
      rootSpanData: opts.rootSpanData,
      metadata: opts.metadata,
      now: this.options.now,
      nextSpanId: this.options.nextSpanId,
      nextTraceId: this.options.nextTraceId,
      onSpanStart: _emitSpanStart,
      onSpanEnd: _emitSpanEnd,
      onTraceEnd: _emitTraceEnd,
    });
  }
}

/** Default tracer shared by the KodaX runtime. External callers can create their own. */
export const defaultTracer = new Tracer();
