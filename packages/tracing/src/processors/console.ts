/**
 * ConsoleTracingProcessor — writes span lifecycle lines to stdout.
 *
 * FEATURE_083 (v0.7.24): handy for local development. Not intended for
 * production traffic.
 *
 * Output format (one line per event):
 *
 *     [span:start] traceId=... spanId=... name=... kind=...
 *     [span:end]   traceId=... spanId=... name=... kind=... durationMs=...
 *     [trace:end]  traceId=... rootName=... durationMs=...
 */

import type { Span } from '../span.js';
import type { Trace } from '../trace.js';
import type { TracingProcessor } from '../processor.js';

type WriteFn = (line: string) => void;

export interface ConsoleTracingProcessorOptions {
  /**
   * Writer override. Defaults to `process.stdout.write`. Useful in tests so
   * output goes to a capture buffer instead of the real stdout.
   */
  readonly write?: WriteFn;
}

export class ConsoleTracingProcessor implements TracingProcessor {
  private readonly write: WriteFn;

  constructor(opts: ConsoleTracingProcessorOptions = {}) {
    this.write =
      opts.write ?? ((line) => {
        if (typeof process !== 'undefined' && process.stdout) {
          process.stdout.write(line + '\n');
        }
      });
  }

  onSpanStart(span: Span): void {
    this.write(
      `[span:start] traceId=${span.traceId} spanId=${span.id} name=${span.name} kind=${span.data.kind}`,
    );
  }

  onSpanEnd(span: Span): void {
    const duration = span.endedAt !== undefined ? span.endedAt - span.startedAt : 0;
    const errPart = span.error ? ` error=${safe(span.error.message)}` : '';
    this.write(
      `[span:end]   traceId=${span.traceId} spanId=${span.id} name=${span.name} kind=${span.data.kind} durationMs=${duration}${errPart}`,
    );
  }

  onTraceEnd(trace: Trace): void {
    const duration = trace.endedAt !== undefined ? trace.endedAt - trace.startedAt : 0;
    this.write(
      `[trace:end]  traceId=${trace.id} rootName=${trace.rootSpan.name} durationMs=${duration}`,
    );
  }
}

function safe(text: string): string {
  // Keep the single-line log format; escape newlines and spaces.
  return text.replace(/\s+/g, ' ').trim();
}
