import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { KodaXMcpServerConfig } from '../../../types.js';

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

export interface McpTransportEvents {
  /** Called with a complete JSON-RPC message (raw JSON string). */
  onMessage(raw: string): void;
  onError(error: Error): void;
  onClose(reason: string): void;
}

export interface McpTransport {
  open(events: McpTransportEvents): Promise<void>;
  /** Send a JSON string. The transport handles framing. */
  send(json: string): Promise<void>;
  close(): Promise<void>;
  readonly connected: boolean;
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

function createContentLengthFrame(json: string): string {
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

export type StdioFraming = 'content-length' | 'ndjson';

export function createStdioTransport(config: {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  framing?: StdioFraming;
}): McpTransport {
  let process: ChildProcessWithoutNullStreams | undefined;
  let buffer = Buffer.alloc(0);
  let events: McpTransportEvents | undefined;
  let framing: StdioFraming = config.framing ?? 'content-length';

  function drainBuffer(): void {
    if (!events) {
      return;
    }
    while (buffer.length > 0) {
      if (framing === 'content-length') {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          return;
        }
        const header = buffer.subarray(0, headerEnd).toString('utf8');
        const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
        if (!lengthMatch?.[1]) {
          buffer = Buffer.alloc(0);
          events.onError(new Error('Malformed Content-Length header from MCP server.'));
          return;
        }
        const contentLength = Number(lengthMatch[1]);
        const frameEnd = headerEnd + 4 + contentLength;
        if (buffer.length < frameEnd) {
          return;
        }
        const body = buffer.subarray(headerEnd + 4, frameEnd).toString('utf8');
        buffer = buffer.subarray(frameEnd);
        events.onMessage(body);
        continue;
      }

      // NDJSON: line-delimited JSON.
      const lineEnd = buffer.indexOf(0x0A);
      if (lineEnd < 0) {
        return;
      }
      const line = buffer.subarray(0, lineEnd).toString('utf8').replace(/\r$/, '').trim();
      buffer = buffer.subarray(lineEnd + 1);
      if (line.startsWith('{')) {
        events.onMessage(line);
      }
    }
  }

  return {
    get connected() {
      return !!process;
    },

    get detectedFraming(): StdioFraming {
      return framing;
    },

    async open(ev) {
      events = ev;
      buffer = Buffer.alloc(0);
      const child = spawn(config.command, config.args ?? [], {
        cwd: config.cwd,
        env: { ...globalThis.process.env, ...(config.env ?? {}) },
        stdio: 'pipe',
        windowsHide: true,
      });
      process = child;

      // Absorb EPIPE on stdin — the server may exit before we finish writing
      // (e.g. during framing auto-detection when Content-Length is rejected).
      child.stdin.on('error', () => {});

      child.stdout.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        drainBuffer();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) {
          ev.onError(new Error(text));
        }
      });
      child.on('error', (error) => {
        process = undefined;
        ev.onError(error);
        ev.onClose(`Process error: ${error.message}`);
      });
      child.on('exit', (code, signal) => {
        process = undefined;
        ev.onClose(
          `Process exited (${code ?? 'signal'}${signal ? `:${signal}` : ''}).`,
        );
      });
    },

    async send(json) {
      if (!process?.stdin.writable) {
        throw new Error('Stdio transport is not writable.');
      }
      if (framing === 'ndjson') {
        process.stdin.write(json + '\n', 'utf8');
      } else {
        process.stdin.write(createContentLengthFrame(json), 'utf8');
      }
    },

    /** Switch framing mode (used by runtime for auto-detection fallback). */
    switchFraming(mode: StdioFraming) {
      framing = mode;
      buffer = Buffer.alloc(0);
    },

    async close() {
      buffer = Buffer.alloc(0);
      if (process) {
        process.removeAllListeners();
        process.stdout.removeAllListeners();
        process.stderr.removeAllListeners();
        process.kill();
        process = undefined;
      }
    },
  } as McpTransport & { detectedFraming: StdioFraming; switchFraming: (mode: StdioFraming) => void };
}

// ---------------------------------------------------------------------------
// SSE event parser (shared by SSE and Streamable HTTP transports)
// ---------------------------------------------------------------------------

interface SseEvent {
  event: string;
  data: string;
}

function parseSseChunks(
  text: string,
  remainder: string,
  onEvent: (event: SseEvent) => void,
): string {
  let buf = remainder + text;
  let currentEvent = '';
  const currentData: string[] = [];

  while (true) {
    const lineEnd = buf.indexOf('\n');
    if (lineEnd < 0) {
      break;
    }
    const line = buf.slice(0, lineEnd).replace(/\r$/, '');
    buf = buf.slice(lineEnd + 1);

    if (line === '') {
      // End of event block.
      if (currentData.length > 0) {
        onEvent({ event: currentEvent || 'message', data: currentData.join('\n') });
      }
      currentEvent = '';
      currentData.length = 0;
      continue;
    }
    if (line.startsWith(':')) {
      continue; // Comment.
    }
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      currentData.push(line.slice(5).trimStart());
    }
    // id: and retry: lines are ignored for now.
  }

  // Return what remains (incomplete last line / partial event).
  // If we have accumulated data for an in-progress event, prepend that state.
  if (currentData.length > 0 || currentEvent) {
    const pending = (currentEvent ? `event:${currentEvent}\n` : '')
      + currentData.map((d) => `data:${d}\n`).join('');
    return pending + buf;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// SSE transport
//
// Protocol (MCP over SSE):
//   1. Client opens GET to `url` with Accept: text/event-stream.
//   2. Server sends an `endpoint` SSE event with the POST URL.
//   3. Client POSTs JSON-RPC messages to that endpoint.
//   4. Server sends JSON-RPC responses as `message` SSE events.
// ---------------------------------------------------------------------------

export function createSseTransport(config: {
  url: string;
  headers?: Record<string, string>;
}): McpTransport {
  let abortController: AbortController | undefined;
  let postEndpoint: string | undefined;
  let events: McpTransportEvents | undefined;
  let isConnected = false;

  function resolveEndpointUrl(endpoint: string): string {
    try {
      return new URL(endpoint, config.url).href;
    } catch {
      return endpoint;
    }
  }

  let endpointResolve: (() => void) | undefined;
  const endpointReady = new Promise<void>((resolve) => { endpointResolve = resolve; });

  async function readSseStream(response: Response): Promise<void> {
    const body = response.body;
    if (!body) {
      events?.onError(new Error('SSE response has no body.'));
      return;
    }
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let remainder = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const text = decoder.decode(value, { stream: true });
        remainder = parseSseChunks(text, remainder, (event) => {
          if (event.event === 'endpoint') {
            postEndpoint = resolveEndpointUrl(event.data.trim());
            endpointResolve?.();
            return;
          }
          if (event.event === 'message') {
            events?.onMessage(event.data);
          }
        });
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        events?.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
    isConnected = false;
    events?.onClose('SSE stream ended.');
  }

  return {
    get connected() {
      return isConnected;
    },

    async open(ev) {
      events = ev;
      abortController = new AbortController();

      const response = await fetch(config.url, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          ...(config.headers ?? {}),
        },
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }
      isConnected = true;

      // Read SSE stream in the background (does not block open()).
      readSseStream(response).catch((error) => {
        events?.onError(error instanceof Error ? error : new Error(String(error)));
      });

      // Wait for the endpoint event (resolved by readSseStream when it arrives).
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('SSE server did not send an endpoint event within 10 s.')), 10_000);
      });
      await Promise.race([endpointReady, timeout]);
    },

    async send(json) {
      if (!postEndpoint || !isConnected) {
        throw new Error('SSE transport is not connected.');
      }
      const response = await fetch(postEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.headers ?? {}),
        },
        body: json,
        signal: abortController?.signal,
      });
      if (!response.ok) {
        throw new Error(`SSE POST failed: ${response.status} ${response.statusText}`);
      }
    },

    async close() {
      isConnected = false;
      postEndpoint = undefined;
      abortController?.abort();
      abortController = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport
//
// Protocol (MCP over Streamable HTTP):
//   1. Client POSTs JSON-RPC to `url`.
//   2. Server responds with either:
//      - Content-Type: application/json  →  single JSON-RPC response.
//      - Content-Type: text/event-stream →  SSE stream of JSON-RPC messages.
//   3. Client can GET `url` to open an SSE stream for server-initiated
//      notifications / requests (optional, started during open()).
// ---------------------------------------------------------------------------

export function createStreamableHttpTransport(config: {
  url: string;
  headers?: Record<string, string>;
}): McpTransport {
  let abortController: AbortController | undefined;
  let events: McpTransportEvents | undefined;
  let isConnected = false;

  /** Optional background SSE stream for server-initiated messages. */
  async function openNotificationStream(): Promise<void> {
    if (!abortController) {
      return;
    }
    try {
      const response = await fetch(config.url, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          ...(config.headers ?? {}),
        },
        signal: abortController.signal,
      });
      // A 405 means the server does not support server-initiated messages — that's OK.
      if (response.status === 405 || !response.ok || !response.body) {
        return;
      }
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let remainder = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        remainder = parseSseChunks(decoder.decode(value, { stream: true }), remainder, (event) => {
          if (event.event === 'message') {
            events?.onMessage(event.data);
          }
        });
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        events?.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  return {
    get connected() {
      return isConnected;
    },

    async open(ev) {
      events = ev;
      abortController = new AbortController();
      isConnected = true;
      // Fire-and-forget: server notification stream (optional).
      openNotificationStream().catch(() => {});
    },

    async send(json) {
      if (!isConnected) {
        throw new Error('Streamable HTTP transport is not connected.');
      }
      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...(config.headers ?? {}),
        },
        body: json,
        signal: abortController?.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP POST failed: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream') && response.body) {
        // Streaming response — parse SSE events.
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let remainder = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          remainder = parseSseChunks(decoder.decode(value, { stream: true }), remainder, (event) => {
            if (event.event === 'message') {
              events?.onMessage(event.data);
            }
          });
        }
        return;
      }

      // Regular JSON response.
      const text = await response.text();
      if (text.trim()) {
        events?.onMessage(text);
      }
    },

    async close() {
      isConnected = false;
      abortController?.abort();
      abortController = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface McpTransportOptions {
  stdioFraming?: StdioFraming;
}

export function createMcpTransport(
  config: KodaXMcpServerConfig,
  options: McpTransportOptions = {},
): McpTransport {
  const type = config.type ?? 'stdio';
  switch (type) {
    case 'stdio': {
      if (!config.command) {
        throw new Error('MCP stdio transport requires a "command" field.');
      }
      return createStdioTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: config.env,
        framing: options.stdioFraming,
      });
    }
    case 'sse': {
      if (!config.url) {
        throw new Error('MCP SSE transport requires a "url" field.');
      }
      return createSseTransport({
        url: config.url,
        headers: config.headers,
      });
    }
    case 'streamable-http': {
      if (!config.url) {
        throw new Error('MCP streamable-http transport requires a "url" field.');
      }
      return createStreamableHttpTransport({
        url: config.url,
        headers: config.headers,
      });
    }
    default:
      throw new Error(`Unknown MCP transport type: ${type as string}`);
  }
}
