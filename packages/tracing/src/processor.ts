/**
 * TracingProcessor — sink for span/trace lifecycle events.
 *
 * FEATURE_083 (v0.7.24): minimal processor contract modeled after
 * openai-agents-python. External adapters (OpenTelemetry, Langfuse, custom
 * telemetry) implement this interface and register via
 * `addTracingProcessor` / `setTracingProcessors`.
 *
 * Lifecycle:
 *   - `onSpanStart(span)` fires when a span is created and attached to its
 *     parent. Called synchronously; implementations should defer I/O.
 *   - `onSpanEnd(span)` fires on `span.end()`. The span's `endedAt`,
 *     `error`, and final children list are authoritative at this point.
 *   - `onTraceEnd(trace)` fires on `trace.end()` after the root span ends.
 *   - `shutdown()` is optional; called when the host wants processors to
 *     flush pending work (e.g. batch buffers).
 */

import type { Span } from './span.js';
import type { Trace } from './trace.js';

export interface TracingProcessor {
  onSpanStart(span: Span): void;
  onSpanEnd(span: Span): void;
  onTraceEnd(trace: Trace): void;
  shutdown?(): Promise<void>;
}

const processors: TracingProcessor[] = [];

/**
 * Register a tracing processor. Returns an unregister function.
 *
 * Consumers typically call this at app startup:
 *
 *     addTracingProcessor(new ConsoleTracingProcessor());
 */
export function addTracingProcessor(p: TracingProcessor): () => void {
  processors.push(p);
  return () => {
    const idx = processors.indexOf(p);
    if (idx >= 0) {
      processors.splice(idx, 1);
    }
  };
}

/**
 * Replace the current processor list. Useful in tests where you want a
 * deterministic set of sinks.
 */
export function setTracingProcessors(ps: TracingProcessor[]): void {
  processors.splice(0, processors.length, ...ps);
}

/** @internal */
export function _getRegisteredProcessors(): readonly TracingProcessor[] {
  return processors;
}

/** @internal */
export function _emitSpanStart(span: Span): void {
  for (const p of processors) {
    try {
      p.onSpanStart(span);
    } catch {
      // Swallow processor errors — a broken processor must not break the
      // traced workflow.
    }
  }
}

/** @internal */
export function _emitSpanEnd(span: Span): void {
  for (const p of processors) {
    try {
      p.onSpanEnd(span);
    } catch {
      // See _emitSpanStart.
    }
  }
}

/** @internal */
export function _emitTraceEnd(trace: Trace): void {
  for (const p of processors) {
    try {
      p.onTraceEnd(trace);
    } catch {
      // See _emitSpanStart.
    }
  }
}

/**
 * Flush-and-shutdown all registered processors. Callers can await this on
 * process shutdown.
 */
export async function shutdownTracing(): Promise<void> {
  await Promise.all(
    processors.map(async (p) => {
      if (p.shutdown) {
        try {
          await p.shutdown();
        } catch {
          // Best-effort shutdown; a failing processor does not block others.
        }
      }
    }),
  );
}
