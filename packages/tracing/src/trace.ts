/**
 * Trace — the root container for a single user-visible workflow.
 *
 * FEATURE_083 (v0.7.24): a Trace wraps a root span and all its descendants.
 * The Runner.run(agent, ...) entry creates a trace per run by default;
 * consumers can nest runs under an existing trace via `Runner.run(agent, input, { trace })`.
 */

import { SpanImpl, type Span, type SpanError } from './span.js';
import type { SpanData } from './span-data.js';

export interface Trace {
  readonly id: string;
  readonly startedAt: number;
  readonly rootSpan: Span;
  readonly metadata: ReadonlyMap<string, unknown>;
  end(): void;
  readonly endedAt?: number;
  readonly error?: SpanError;
}

export interface TraceOptions {
  readonly id?: string;
  readonly name?: string;
  readonly rootSpanData?: SpanData;
  readonly metadata?: ReadonlyMap<string, unknown>;
  readonly now?: () => number;
  readonly nextSpanId?: () => string;
  readonly nextTraceId?: () => string;
  readonly onSpanStart?: (span: Span) => void;
  readonly onSpanEnd?: (span: Span) => void;
  readonly onTraceEnd?: (trace: Trace) => void;
}

let _traceCounter = 0;
function defaultNextTraceId(): string {
  _traceCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `trace-${Date.now()}-${_traceCounter}-${rand}`;
}

/**
 * In-memory Trace implementation. External consumers can replace this with
 * an adapter (OpenTelemetry Trace, Langfuse trace) by registering their own
 * `TracingProcessor`.
 */
export function createTrace(opts: TraceOptions = {}): Trace {
  const now = opts.now ?? (() => Date.now());
  const id = opts.id ?? (opts.nextTraceId ?? defaultNextTraceId)();
  const startedAt = now();
  const name = opts.name ?? 'trace';
  const metadata = opts.metadata ?? new Map<string, unknown>();
  const rootData: SpanData = opts.rootSpanData ?? {
    kind: 'agent',
    agentName: name,
  };

  let ended = false;
  let endedAt: number | undefined;
  let traceError: SpanError | undefined;

  const rootSpan = new SpanImpl({
    id: `${id}-root`,
    traceId: id,
    name,
    data: rootData,
    startedAt,
    now,
    nextSpanId: opts.nextSpanId,
    onChildCreated: opts.onSpanStart,
    onSpanEnd: opts.onSpanEnd,
  });

  // The root span counts as "started" for processor notification.
  if (opts.onSpanStart) {
    opts.onSpanStart(rootSpan);
  }

  const trace: Trace = {
    id,
    startedAt,
    rootSpan,
    metadata,
    get endedAt() {
      return endedAt;
    },
    get error() {
      return traceError ?? rootSpan.error;
    },
    end(): void {
      if (ended) return;
      ended = true;
      endedAt = now();
      rootSpan.end();
      if (opts.onTraceEnd) {
        opts.onTraceEnd(trace);
      }
    },
  };
  return trace;
}
