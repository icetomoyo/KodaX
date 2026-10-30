import { providerStreamEvent } from './request-extensions.js';
/** Minimal SSE framing; JSON schema and terminal validation remain with the native protocol. */
export async function* readCloudSSE(response: Response, signal?: AbortSignal,
  options?: { onDone?(): void; maxFrameBytes?: number }): AsyncGenerator<unknown> {
  if (!response.body) throw new Error('SSE response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const parse = (frame: string): unknown | undefined => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (data === '[DONE]') { options?.onDone?.(); return undefined; }
    return !data ? undefined : JSON.parse(data) as unknown;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      if (options?.maxFrameBytes !== undefined && buffer.length > options.maxFrameBytes) throw new Error('SSE operation exceeds the local processing limit.');
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const event = parse(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (event !== undefined) { providerStreamEvent(event); yield event; }
      }
      if (next.done) { ended = true; if (buffer.trim()) { const event = parse(buffer); if (event !== undefined) { providerStreamEvent(event); yield event; } } break; }
    }
  } finally { try { if (!ended) await reader.cancel(); } finally { reader.releaseLock(); } }
}
