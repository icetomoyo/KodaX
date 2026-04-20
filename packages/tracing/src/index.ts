/**
 * @kodax/tracing — Trace / Span / SpanData / TracingProcessor.
 *
 * FEATURE_083 (v0.7.24): unified tracing substrate for KodaX. Standalone so
 * external SDK consumers can wire KodaX into OpenTelemetry, Langfuse or a
 * custom sink without pulling @kodax/core or @kodax/coding.
 *
 * The `Runner` (FEATURE_080/v0.7.23) accepts an optional tracer; the SA
 * path emits `AgentSpan` / `GenerationSpan` / `ToolCallSpan` as of Slice 8.
 *
 * @experimental API shape locked at v0.8.0.
 */

export type {
  AgentSpanData,
  GenerationSpanData,
  ToolCallSpanData,
  HandoffSpanData,
  CompactionSpanData,
  GuardrailSpanData,
  EvidenceSpanData,
  FanoutSpanData,
  SpanData,
} from './span-data.js';

export type { Span, SpanError, SpanImplOptions } from './span.js';
export { SpanImpl } from './span.js';

export type { Trace, TraceOptions } from './trace.js';
export { createTrace } from './trace.js';

export type { StartTraceOptions, TracerOptions } from './tracer.js';
export { Tracer, defaultTracer } from './tracer.js';

export type { TracingProcessor } from './processor.js';
export {
  addTracingProcessor,
  setTracingProcessors,
  shutdownTracing,
  _getRegisteredProcessors,
  _emitSpanStart,
  _emitSpanEnd,
  _emitTraceEnd,
} from './processor.js';

export type { ConsoleTracingProcessorOptions } from './processors/console.js';
export { ConsoleTracingProcessor } from './processors/console.js';

export type { FileTracingProcessorOptions } from './processors/file.js';
export { FileTracingProcessor } from './processors/file.js';
