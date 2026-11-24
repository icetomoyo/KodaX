/**
 * The link to a Host over plain HTTP, for a network that lets no WebSocket
 * through. The Host's frames come down one stream of server-sent events; this
 * client's frames go up in POSTs, one at a time so they arrive in order, each
 * carrying what queued while the one before was out. No Node dependency: it
 * uses the global `fetch` of a browser, or of Node.
 */
import type { HostRpcDial, HostRpcLinkEvents } from './client.js';
import type { HostLinkClose } from './close.js';

/** Frames sent together in one POST, unless a single frame is bigger alone. */
const BATCH_BYTES = 1024 * 1024;
/** How a link that ended without a word from the Host reads: a WebSocket's abnormal closure. */
const LOST: HostLinkClose = { code: 1006, reason: '' };

export interface HostHttpLinkOptions {
  /** `POST` here opens the stream. */
  readonly eventsUrl: string;
  /** `POST` here sends frames. */
  readonly messagesUrl: string;
  /** A Host that has not opened the stream by then is given up on. */
  readonly openTimeoutMs: number;
}

/** A link over HTTP. It rejects when the stream does not open, such as behind a proxy that holds it back. */
export function dialHostHttp(options: HostHttpLinkOptions): HostRpcDial {
  return events => new Promise((resolve, reject) => {
    const aborter = new AbortController();
    const queue: string[] = [];
    let name: string | undefined;
    let sending = false;
    let ended = false;
    const end = (close: HostLinkClose | undefined, failure?: Error): void => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      aborter.abort();
      if (name === undefined) reject(failure ?? new Error('The Host ended the HTTP stream before it opened.'));
      else events.end(close);
    };
    const deadline = setTimeout(() => {
      end(undefined, new Error(`The Host did not open the HTTP stream within ${options.openTimeoutMs} ms.`));
    }, options.openTimeoutMs);

    const pump = async (): Promise<void> => {
      if (sending || ended || queue.length === 0) return;
      sending = true;
      const batch = takeBatch(queue);
      try {
        const answer = await fetch(options.messagesUrl, {
          method: 'POST', body: `${name}\n${batch.join('\n')}`, credentials: 'include', signal: aborter.signal,
        });
        if (!answer.ok) throw new Error(`The Host refused frames with HTTP ${answer.status}.`);
      } catch {
        // A frame that may not have arrived leaves the connection unsure; it ends, as a WebSocket that broke would.
        end(LOST);
        return;
      } finally {
        sending = false;
      }
      void pump();
    };
    const opened = (stream: string): void => {
      name = stream;
      clearTimeout(deadline);
      resolve({
        send(frame) {
          if (ended) return;
          queue.push(frame);
          void pump();
        },
        close: () => end(undefined),
      });
    };

    void (async () => {
      const answer = await fetch(options.eventsUrl, {
        method: 'POST', body: '', credentials: 'include', signal: aborter.signal,
      });
      if (!answer.ok || answer.body === null) throw new Error(`The Host refused the HTTP stream with HTTP ${answer.status}.`);
      await readEvents(answer.body, async (event, data) => {
        if (ended) return;
        if (event === 'open' && name === undefined) {
          opened(readStreamName(data));
          // What follows waits until the caller holds the link and sent its first frame, as on a WebSocket,
          // so a close that came in the same chunk ends a connection rather than a dial.
          await new Promise(next => setTimeout(next, 0));
        } else if (event === 'close') end(readClose(data));
        else if (event === 'message' && name !== undefined) events.frame(data);
      });
      end(LOST);
    })().catch((error: unknown) => end(LOST, error instanceof Error ? error : new Error(String(error))));
  });
}

/** The frames that go in the next POST: the first always, and those after it while the batch stays under its size. */
function takeBatch(queue: string[]): string[] {
  let bytes = 0;
  let count = 0;
  while (count < queue.length) {
    bytes += queue[count]!.length * 3 + 1;
    if (count > 0 && bytes > BATCH_BYTES) break;
    count += 1;
  }
  return queue.splice(0, count);
}

type EventsListener = (event: string, data: string) => void | Promise<void>;

/** Reads server-sent events until the stream ends. Comment lines, the Host's heartbeat, are skipped. */
async function readEvents(body: ReadableStream<Uint8Array>, listener: EventsListener): Promise<void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  let event = 'message';
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffered += value;
    // A chunk can end mid-line, and a `\r` at its end might be the first half of `\r\n`.
    const held = buffered.endsWith('\r') ? '\r' : '';
    const lines = buffered.slice(0, buffered.length - held.length).split(/\r\n|\r|\n/);
    buffered = (lines.pop() ?? '') + held;
    for (const line of lines) {
      if (line === '') {
        if (data.length > 0) await listener(event, data.join('\n'));
        event = 'message';
        data = [];
      } else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
      else if (line.startsWith('event:')) event = line.slice(6).trim();
    }
  }
}

function readStreamName(data: string): string {
  const { stream } = JSON.parse(data) as { stream?: unknown };
  if (typeof stream !== 'string' || stream === '') throw new Error('The Host opened an HTTP stream without a name.');
  return stream;
}

function readClose(data: string): HostLinkClose {
  const { code, reason } = JSON.parse(data) as { code?: unknown; reason?: unknown };
  return { code: typeof code === 'number' ? code : LOST.code, reason: typeof reason === 'string' ? reason : '' };
}
