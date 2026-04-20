/**
 * Span — a single timed unit of work inside a Trace.
 *
 * FEATURE_083 (v0.7.24): minimal Span implementation modeled after the
 * openai-agents-python Trace/Span pattern.
 *
 * Design constraints:
 *   - Span creation must be cheap (no await, no serialisation). Processors
 *     do their own batching / flushing.
 *   - `addChild()` is synchronous and immediately visible in the Trace tree.
 *   - `end()` is idempotent; calling it twice is a no-op.
 *   - `error` is an optional field that sets a flag on the span without
 *     throwing. The consumer decides how to surface errors.
 */

import type { SpanData } from './span-data.js';

export interface SpanError {
  readonly message: string;
  readonly stack?: string;
  readonly data?: unknown;
}

/**
 * Public Span interface. Concrete implementation is `SpanImpl`.
 */
export interface Span {
  readonly id: string;
  readonly traceId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly data: SpanData;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly error?: SpanError;
  readonly children: readonly Span[];
  addChild(name: string, data: SpanData): Span;
  setError(err: SpanError | Error): void;
  end(): void;
}

export interface SpanImplOptions {
  readonly id: string;
  readonly traceId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly data: SpanData;
  readonly startedAt?: number;
  readonly now?: () => number;
  readonly nextSpanId?: () => string;
  readonly onChildCreated?: (span: Span) => void;
  readonly onSpanEnd?: (span: Span) => void;
}

export class SpanImpl implements Span {
  readonly id: string;
  readonly traceId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly data: SpanData;
  readonly startedAt: number;
  private _endedAt?: number;
  private _error?: SpanError;
  private readonly _children: Span[] = [];
  private readonly now: () => number;
  private readonly nextSpanId: () => string;
  private readonly onChildCreated?: (span: Span) => void;
  private readonly onSpanEnd?: (span: Span) => void;
  private _ended = false;

  constructor(opts: SpanImplOptions) {
    this.id = opts.id;
    this.traceId = opts.traceId;
    this.parentId = opts.parentId;
    this.name = opts.name;
    this.data = opts.data;
    this.now = opts.now ?? (() => Date.now());
    this.startedAt = opts.startedAt ?? this.now();
    this.nextSpanId = opts.nextSpanId ?? defaultNextSpanId;
    this.onChildCreated = opts.onChildCreated;
    this.onSpanEnd = opts.onSpanEnd;
  }

  get endedAt(): number | undefined {
    return this._endedAt;
  }

  get error(): SpanError | undefined {
    return this._error;
  }

  get children(): readonly Span[] {
    return this._children;
  }

  addChild(name: string, data: SpanData): Span {
    const child = new SpanImpl({
      id: this.nextSpanId(),
      traceId: this.traceId,
      parentId: this.id,
      name,
      data,
      now: this.now,
      nextSpanId: this.nextSpanId,
      onChildCreated: this.onChildCreated,
      onSpanEnd: this.onSpanEnd,
    });
    this._children.push(child);
    if (this.onChildCreated) {
      this.onChildCreated(child);
    }
    return child;
  }

  setError(err: SpanError | Error): void {
    if (err instanceof Error) {
      this._error = { message: err.message, stack: err.stack };
    } else {
      this._error = err;
    }
  }

  end(): void {
    if (this._ended) return;
    this._ended = true;
    this._endedAt = this.now();
    if (this.onSpanEnd) {
      this.onSpanEnd(this);
    }
  }
}

let _spanCounter = 0;
function defaultNextSpanId(): string {
  _spanCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `span-${Date.now()}-${_spanCounter}-${rand}`;
}
