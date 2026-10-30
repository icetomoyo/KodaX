/** Minimal SSE framing; JSON schema and terminal validation remain with the native protocol. */
export async function* readCloudSSE(response: Response, signal?: AbortSignal): AsyncGenerator<unknown> {
  if (!response.body) throw new Error('SSE response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const parse = (frame: string): unknown | undefined => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    return !data || data === '[DONE]' ? undefined : JSON.parse(data) as unknown;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const event = parse(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (event !== undefined) yield event;
      }
      if (next.done) { ended = true; if (buffer.trim()) { const event = parse(buffer); if (event !== undefined) yield event; } break; }
    }
  } finally { try { if (!ended) await reader.cancel(); } finally { reader.releaseLock(); } }
}
