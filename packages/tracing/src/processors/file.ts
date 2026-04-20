/**
 * FileTracingProcessor — writes JSONL records to `.kodax/.traces/{traceId}.jsonl`.
 *
 * FEATURE_083 (v0.7.24): simple append-only log for offline analysis. Each
 * span start / end / trace end becomes a separate JSON line.
 *
 * The processor buffers per-trace writes to the file system; call
 * `shutdown()` on process exit to flush pending writes.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Span } from '../span.js';
import type { Trace } from '../trace.js';
import type { TracingProcessor } from '../processor.js';

interface PendingWrite {
  readonly traceId: string;
  readonly line: string;
}

export interface FileTracingProcessorOptions {
  /**
   * Directory for trace files. Defaults to `./.kodax/.traces`. Must be an
   * absolute path or resolvable relative to `process.cwd()`.
   */
  readonly traceDir?: string;
}

export class FileTracingProcessor implements TracingProcessor {
  private readonly traceDir: string;
  private readonly queues = new Map<string, PendingWrite[]>();
  // Serialises actual file system writes AND acts as the barrier that
  // `shutdown()` awaits so tests and graceful exits see all pending data
  // persisted before the promise resolves.
  private writeChain: Promise<void> = Promise.resolve();
  private ensuredDir = false;

  constructor(opts: FileTracingProcessorOptions = {}) {
    this.traceDir = opts.traceDir ?? path.join(process.cwd(), '.kodax', '.traces');
  }

  onSpanStart(span: Span): void {
    this.enqueue(span.traceId, {
      event: 'span:start',
      traceId: span.traceId,
      spanId: span.id,
      parentId: span.parentId,
      name: span.name,
      startedAt: span.startedAt,
      data: span.data,
    });
  }

  onSpanEnd(span: Span): void {
    this.enqueue(span.traceId, {
      event: 'span:end',
      traceId: span.traceId,
      spanId: span.id,
      parentId: span.parentId,
      name: span.name,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      durationMs: span.endedAt !== undefined ? span.endedAt - span.startedAt : undefined,
      data: span.data,
      error: span.error ? { message: span.error.message, stack: span.error.stack } : undefined,
    });
  }

  onTraceEnd(trace: Trace): void {
    this.enqueue(trace.id, {
      event: 'trace:end',
      traceId: trace.id,
      rootName: trace.rootSpan.name,
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      durationMs: trace.endedAt !== undefined ? trace.endedAt - trace.startedAt : undefined,
    });
    // Trigger an async flush for the completed trace so data is durable
    // without waiting for shutdown. Errors are swallowed per processor
    // contract. The returned promise is appended to `writeChain` so
    // `shutdown()` can await it.
    this.scheduleFlush(trace.id);
  }

  async shutdown(): Promise<void> {
    // Schedule flushes for any queues that have not yet been drained by an
    // onTraceEnd call (defensive — a trace might have ended-but-not-flushed
    // if the process hit shutdown mid-flight).
    for (const traceId of this.queues.keys()) {
      this.scheduleFlush(traceId);
    }
    // Finally await the entire write chain.
    await this.writeChain;
  }

  private scheduleFlush(traceId: string): void {
    this.writeChain = this.writeChain.then(() => this.flushTrace(traceId).catch(() => undefined));
  }

  private enqueue(traceId: string, record: unknown): void {
    const line = JSON.stringify(record);
    const queue = this.queues.get(traceId) ?? [];
    queue.push({ traceId, line });
    this.queues.set(traceId, queue);
  }

  private async flushTrace(traceId: string): Promise<void> {
    const queue = this.queues.get(traceId);
    if (!queue || queue.length === 0) return;
    this.queues.delete(traceId);

    if (!this.ensuredDir) {
      await fs.mkdir(this.traceDir, { recursive: true });
      this.ensuredDir = true;
    }
    const filePath = path.join(this.traceDir, `${traceId}.jsonl`);
    const payload = queue.map((item) => item.line).join('\n') + '\n';
    await fs.appendFile(filePath, payload, 'utf8');
  }
}
