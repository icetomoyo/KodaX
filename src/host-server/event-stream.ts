/**
 * The HTTP carriage of v2, for a network that lets no WebSocket through. A
 * client opens a connection with `POST /v2/events` and reads the Host's frames
 * from the answer as server-sent events. Its first event names the stream; the
 * client sends its own frames with `POST /v2/messages`, whose body is that
 * name and then one frame per line. One stream is one connection, as one
 * WebSocket would be, so the listener treats both alike.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';

/** A comment line goes down this often, so a proxy does not end a stream it thinks is idle. */
const HEARTBEAT_MS = 15_000;

/** What the listener needs of a connection, whichever way it is carried. */
export interface HostWire {
  /** Bytes written to the connection that the client has not taken yet. */
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code: number, reason: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
}

export interface EventStreamWire extends HostWire {
  /** A frame the client posted for this stream. */
  deliver(frame: string): void;
}

/** The headers of a stream. Proxies that hold back a response until it ends are asked not to. */
export function eventStreamHeaders(extra: OutgoingHttpHeaders): OutgoingHttpHeaders {
  return {
    ...extra,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store, no-transform',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  };
}

/** One server-sent event. A line break in `data` would end its line, so each line becomes its own `data` line. */
export function eventStreamEvent(data: string, event?: string): string {
  return `${event !== undefined ? `event: ${event}\n` : ''}data: ${data.split(/\r\n|\r|\n/).join('\ndata: ')}\n\n`;
}

/** Carries one connection on a stream whose headers are already written. */
export function createEventStreamWire(request: IncomingMessage, response: ServerResponse): EventStreamWire {
  const messages: Array<(data: Buffer, isBinary: boolean) => void> = [];
  const closes: Array<() => void> = [];
  request.socket.setNoDelay(true);
  const heartbeat = setInterval(() => response.write(':\n\n'), HEARTBEAT_MS);
  heartbeat.unref();
  // Ends both ways: the Host ended the answer, or the client went away.
  response.on('close', () => {
    clearInterval(heartbeat);
    for (const listener of closes) listener();
  });
  return {
    get bufferedAmount() {
      return response.writableLength;
    },
    send(data, callback) {
      response.write(eventStreamEvent(data), error => callback(error ?? undefined));
    },
    close(code, reason) {
      if (!response.writableEnded) response.end(eventStreamEvent(JSON.stringify({ code, reason }), 'close'));
    },
    terminate() {
      response.destroy();
    },
    on(event: 'message' | 'close' | 'error', listener: ((data: Buffer, isBinary: boolean) => void) | (() => void)) {
      if (event === 'message') messages.push(listener);
      else if (event === 'close') closes.push(listener as () => void);
    },
    deliver(frame) {
      const data = Buffer.from(frame, 'utf8');
      for (const listener of messages) listener(data, false);
    },
  };
}

/** The body of a request, or `undefined` once it runs past `limit` bytes. */
export function readRequestBody(request: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      if (size > limit) return;
      size += chunk.length;
      if (size > limit) resolve(undefined);
      else chunks.push(chunk);
    });
    request.on('end', () => {
      if (size <= limit) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}
