import { createRequire } from 'node:module';
import type { KodaXResponsesSocket, KodaXResponsesSocketFactory } from '../types.js';

interface NodeSocket {
  readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): void;
  send(frame: string, callback: (error?: Error) => void): void;
  terminate(): void;
}
type SocketConstructor = new (url: string, options: { headers: Readonly<Record<string, string>>; handshakeTimeout: number;
  maxPayload: number; followRedirects: boolean; perMessageDeflate: boolean }) => NodeSocket;
/** One native WebSocket, with a bounded text-frame queue and a single consumer. */
class ResponsesSocket implements KodaXResponsesSocket {
  private readonly socket: NodeSocket;
  private readonly queue: string[] = [];
  private bufferedBytes = 0;
  private failure?: Error;
  private waiting?: { resolve(value: string): void; reject(error: Error): void };
  private readonly opened: Promise<void>;
  get closed(): boolean { return this.socket.readyState > 1 || this.failure !== undefined; }
  constructor(input: Parameters<KodaXResponsesSocketFactory>[0]) {
    // Runtime dependency is lazy and remains real when Ink's dev-only ws shim is stubbed by the CLI build.
    const WebSocket = createRequire(import.meta.url)('ws') as SocketConstructor;
    this.socket = new WebSocket(input.url, { headers: input.headers, handshakeTimeout: input.timeoutMs,
      maxPayload: 24 * 1024 * 1024, followRedirects: false, perMessageDeflate: false });
    this.opened = new Promise((resolve, reject) => {
      let opened = false;
      this.socket.on('open', () => { opened = true; resolve(); });
      this.socket.on('error', error => { const failure = error instanceof Error ? error : new Error('WebSocket transport error.'); if (!opened) reject(failure); this.fail(failure); });
      this.socket.on('close', () => { const error = new Error('WebSocket connection closed.'); if (!opened) reject(error); this.fail(error); });
      this.socket.on('unexpected-response', (_request, response) => {
        const status = response && typeof response === 'object' && 'statusCode' in response ? response.statusCode : undefined;
        const error = Object.assign(new Error(`WebSocket handshake HTTP ${String(status)}.`), { status }); reject(error); this.fail(error); this.close();
      });
    });
    this.socket.on('message', (data, binary) => {
      if (binary || (typeof data !== 'string' && !(data instanceof Uint8Array))) { this.fail(new Error('Expected WebSocket JSON text.')); this.close(); return; }
      this.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    });
    const abort = () => { this.fail(input.signal?.reason instanceof Error ? input.signal.reason : new DOMException('WebSocket aborted', 'AbortError')); this.close(); };
    input.signal?.addEventListener('abort', abort, { once: true });
    this.socket.on('close', () => input.signal?.removeEventListener('abort', abort));
    if (input.signal?.aborted) abort();
  }
  async open(): Promise<this> { await this.opened; return this; }
  send(frame: string): Promise<void> {
    return new Promise((resolve, reject) => this.socket.send(frame, error => error ? reject(error) : resolve()));
  }
  close(): void { if (this.socket.readyState < 2) this.socket.terminate(); }
  private fail(error: Error): void { this.failure ??= error; this.waiting?.reject(error); this.waiting = undefined; }
  private push(frame: string): void {
    if (this.waiting) { this.waiting.resolve(frame); this.waiting = undefined; return; }
    this.bufferedBytes += Buffer.byteLength(frame);
    if (this.bufferedBytes > 24 * 1024 * 1024) { this.fail(new Error('WebSocket event queue exceeds the processing limit.')); this.close(); return; }
    this.queue.push(frame);
  }
  async receive(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const next = this.queue.shift();
    if (next !== undefined) { this.bufferedBytes -= Buffer.byteLength(next); return next; }
    if (this.failure || this.closed) throw this.failure ?? new Error('WebSocket connection closed.');
    if (this.waiting) throw new Error('WebSocket already has an active consumer.');
    let abort = (): void => {};
    try {
      return await new Promise<string>((resolve, reject) => {
        this.waiting = { resolve, reject };
        abort = () => { this.waiting = undefined; reject(signal?.reason ?? new DOMException('WebSocket aborted', 'AbortError')); };
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      });
    } finally { signal?.removeEventListener('abort', abort); }
  }
}
export const createResponsesSocket: KodaXResponsesSocketFactory = async input => { input.signal?.throwIfAborted(); return new ResponsesSocket(input).open(); };
