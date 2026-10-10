import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'child_process';
import type { McpServerConfig as KodaXMcpServerConfig } from './config.js';
import { stripHardenedEnvVars } from '../../runtime/process-hardening.js';
import {
  killChildProcessTree,
  killChildProcessTreeSync,
  isCurrentProcessWindowsJobContained,
  rememberChildProcessTree,
} from '../../runtime/process-tree.js';
import { registerManagedChildProcess } from '../../runtime/managed-child-processes.js';

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
  setProtocolVersion?(version: string | undefined): void;
  close(): Promise<void>;
  readonly connected: boolean;
  /** Effective transport after auto-detection (diagnostics only). */
  readonly resolvedTransport?: string;
}

export class McpExpiredSessionError extends Error {
  constructor() {
    super('MCP Streamable HTTP session expired.');
    this.name = 'McpExpiredSessionError';
  }
}

/**
 * FEATURE_222 — the server demanded OAuth (401) or a stronger scope (403). It
 * carries the `WWW-Authenticate` header so the connect flow can discover the
 * authorization server (RFC 9728 pointer) or read the step-up scope.
 */
export class McpAuthRequiredError extends Error {
  constructor(readonly status: number, readonly wwwAuthenticate?: string) {
    super(`MCP server requires authorization (HTTP ${status}).`);
    this.name = 'McpAuthRequiredError';
  }
}

export class McpHttpStatusError extends Error {
  constructor(readonly status: number, readonly statusText: string) {
    super(`HTTP POST failed: ${status} ${statusText}`);
    this.name = 'McpHttpStatusError';
  }
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

function createContentLengthFrame(json: string): string {
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

export type StdioFraming = 'content-length' | 'ndjson';

export class McpTransportCleanupIncompleteError extends Error {
  readonly code = 'mcp_cleanup_incomplete' as const;

  constructor() {
    super('MCP stdio process-tree cleanup could not be verified.');
    this.name = 'McpTransportCleanupIncompleteError';
  }
}

export function createStdioTransport(config: {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  framing?: StdioFraming;
}): McpTransport {
  let process: ChildProcessWithoutNullStreams | undefined;
  let cleanupChild: ChildProcessWithoutNullStreams | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let buffer = Buffer.alloc(0);
  let events: McpTransportEvents | undefined;
  let framing: StdioFraming = config.framing ?? 'ndjson';
  let cleanupOnProcessExit: (() => void) | undefined;
  let removeCleanupOnProcessExit: (() => void) | undefined;
  let unregisterManagedChild: (() => void) | undefined;
  const closingChildren = new WeakSet<ChildProcessWithoutNullStreams>();

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
      if (cleanupChild !== undefined) {
        throw new McpTransportCleanupIncompleteError();
      }
      events = ev;
      buffer = Buffer.alloc(0);
      const child = spawn(config.command, config.args ?? [], {
        cwd: config.cwd,
        // FEATURE_208 (v0.7.45): strip dynamic-linker preload vars so a
        // poisoned MCP server cannot inject into the child via its own
        // config.env. No-op under KODAX_DISABLE_HARDENING=1.
        env: stripHardenedEnvVars({ ...globalThis.process.env, ...(config.env ?? {}) }),
        stdio: 'pipe',
        windowsHide: true,
        detached: globalThis.process.platform !== 'win32',
      });
      process = child;
      cleanupChild = child;
      let spawnConfirmed = false;
      child.once('spawn', () => {
        spawnConfirmed = true;
      });
      let childCleanupOnProcessExit: (() => void) | undefined;
      const removeChildCleanupOnProcessExit = (): void => {
        if (childCleanupOnProcessExit !== undefined) {
          globalThis.process.off('exit', childCleanupOnProcessExit);
        }
        if (cleanupOnProcessExit === childCleanupOnProcessExit) {
          cleanupOnProcessExit = undefined;
          removeCleanupOnProcessExit = undefined;
        }
      };
      if (!isCurrentProcessWindowsJobContained()) {
        childCleanupOnProcessExit = () => killChildProcessTreeSync(child);
        cleanupOnProcessExit = childCleanupOnProcessExit;
        removeCleanupOnProcessExit = removeChildCleanupOnProcessExit;
        globalThis.process.once('exit', childCleanupOnProcessExit);
      }
      unregisterManagedChild = registerManagedChildProcess(child, {
        kind: 'mcp-stdio',
        command: config.command,
        args: config.args,
        cwd: config.cwd,
      }, {
        manualUnregister: true,
      });
      child.stdin.on('error', (error) => {
        if (!closingChildren.has(child)) ev.onError(error);
      });

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
        rememberChildProcessTree(child);
        if (process === child) {
          process = undefined;
        }
        if (!spawnConfirmed && child.pid === undefined) {
          removeChildCleanupOnProcessExit();
          unregisterManagedChild?.();
          unregisterManagedChild = undefined;
          cleanupChild = undefined;
        }
        if (closingChildren.has(child)) {
          return;
        }
        ev.onError(error);
        ev.onClose(`Process error: ${error.message}`);
      });
      child.on('exit', (code, signal) => {
        rememberChildProcessTree(child);
        if (process === child) {
          process = undefined;
        }
        if (closingChildren.has(child)) {
          return;
        }
        ev.onClose(
          `Process exited (${code ?? 'signal'}${signal ? `:${signal}` : ''}).`,
        );
      });
    },

    async send(json) {
      const child = process;
      if (!child?.stdin.writable) {
        throw new Error('Stdio transport is not writable.');
      }
      const frame = framing === 'ndjson' ? json + '\n' : createContentLengthFrame(json);
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(frame, 'utf8', (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },

    /** Switch framing mode (used by runtime for auto-detection fallback). */
    switchFraming(mode: StdioFraming) {
      framing = mode;
      buffer = Buffer.alloc(0);
    },

    async close() {
      buffer = Buffer.alloc(0);
      const child = cleanupChild;
      if (child === undefined) return;
      if (cleanupPromise !== undefined) return cleanupPromise;
      process = undefined;
      events = undefined;
      closingChildren.add(child);
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      const attempt = (async (): Promise<void> => {
        const result = await killChildProcessTree(child, { gracefulStdinEnd: true });
        if (result.status === 'unknown') {
          // Preserve registry and host-exit recovery evidence. A natural root
          // exit does not prove that descendants are gone, so close must report
          // the same retryable failure that already blocks reopen.
          throw new McpTransportCleanupIncompleteError();
        }
        removeCleanupOnProcessExit?.();
        unregisterManagedChild?.();
        unregisterManagedChild = undefined;
        cleanupChild = undefined;
      })();
      cleanupPromise = attempt;
      try {
        await attempt;
      } finally {
        if (cleanupPromise === attempt) cleanupPromise = undefined;
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
  /** SSE `id:` field, used as the resumption cursor (Last-Event-ID). */
  id?: string;
}

interface SseParseHandlers {
  onEvent: (event: SseEvent) => void;
  /** SSE `retry:` field (milliseconds) — the server's reconnect-delay hint. */
  onRetry?: (retryMs: number) => void;
}

function parseSseChunks(
  text: string,
  remainder: string,
  handlers: SseParseHandlers | ((event: SseEvent) => void),
): string {
  const onEvent = typeof handlers === 'function' ? handlers : handlers.onEvent;
  const onRetry = typeof handlers === 'function' ? undefined : handlers.onRetry;
  let buf = remainder + text;
  let currentEvent = '';
  let currentId: string | undefined;
  let currentIdSeen = false;
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
        const event: SseEvent = { event: currentEvent || 'message', data: currentData.join('\n') };
        if (currentIdSeen) {
          event.id = currentId ?? '';
        }
        onEvent(event);
      }
      currentEvent = '';
      currentId = undefined;
      currentIdSeen = false;
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
    } else if (line.startsWith('id:')) {
      currentId = line.slice(3).trim();
      currentIdSeen = true;
    } else if (line.startsWith('retry:')) {
      const retryMs = Number(line.slice(6).trim());
      if (Number.isFinite(retryMs) && retryMs >= 0) {
        onRetry?.(retryMs);
      }
    }
  }

  // Return what remains (incomplete last line / partial event).
  // If we have accumulated data for an in-progress event, prepend that state.
  if (currentData.length > 0 || currentEvent || currentIdSeen) {
    const pending = (currentEvent ? `event:${currentEvent}\n` : '')
      + (currentIdSeen ? `id:${currentId ?? ''}\n` : '')
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
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let notificationStreamStarted = false;
  // Resumption cursor for the GET notification stream (SSE Last-Event-ID).
  let lastEventId: string | undefined;
  const DEFAULT_RECONNECT_DELAY_MS = 1_000;
  const MAX_RECONNECT_ATTEMPTS = 5;
  const CLOSE_SESSION_TIMEOUT_MS = 1_000;

  function delayBeforeReconnect(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        abortController?.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      timer.unref?.();
      abortController?.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function readMessageMethod(json: string): string | undefined {
    try {
      const payload = JSON.parse(json) as unknown;
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
        return undefined;
      }
      const method = (payload as Record<string, unknown>).method;
      return typeof method === 'string' ? method : undefined;
    } catch {
      return undefined;
    }
  }

  function readSessionId(headers: Headers): string | undefined {
    const value = headers.get('mcp-session-id');
    if (!value || !/^[\x21-\x7E]+$/.test(value)) {
      return undefined;
    }
    return value;
  }

  function captureSessionId(response: Response): void {
    const nextSessionId = readSessionId(response.headers);
    if (nextSessionId) {
      sessionId = nextSessionId;
    }
  }

  function withSessionHeaders(headers: Record<string, string>): Record<string, string> {
    return {
      ...headers,
      ...(config.headers ?? {}),
      ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
      ...(sessionId ? { 'MCP-Session-Id': sessionId } : {}),
    };
  }

  function handleExpiredSession(status: number): boolean {
    if (status !== 404 || !sessionId) {
      return false;
    }
    sessionId = undefined;
    lastEventId = undefined;
    notificationStreamStarted = false;
    isConnected = false;
    abortController?.abort();
    return true;
  }

  /**
   * Optional background SSE stream for server-initiated messages. Per the
   * 2025-11-25 transport spec a dropped stream is NOT a cancellation: the client
   * resumes via GET with a `Last-Event-ID` header, honoring the `retry` hint,
   * so missed notifications can be replayed.
   */
  async function openNotificationStream(): Promise<void> {
    let attempts = 0;
    while (abortController && !abortController.signal.aborted && isConnected) {
      let reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS;
      try {
        const headers = withSessionHeaders({ 'Accept': 'text/event-stream' });
        if (lastEventId) {
          headers['Last-Event-ID'] = lastEventId;
        }
        const response = await fetch(config.url, {
          method: 'GET',
          headers,
          signal: abortController.signal,
        });
        // A 405 means the server does not support server-initiated messages —
        // that's OK; stop trying rather than reconnect-looping.
        if (response.status === 405 || !response.ok || !response.body) {
          handleExpiredSession(response.status);
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
          remainder = parseSseChunks(decoder.decode(value, { stream: true }), remainder, {
            onEvent: (event) => {
              // A real event proves the (re)connect is healthy — reset the
              // budget so only empty / immediately-dropped streams exhaust it.
              attempts = 0;
              if (event.id !== undefined) {
                lastEventId = event.id;
              }
              if (event.event === 'message') {
                events?.onMessage(event.data);
              }
            },
            onRetry: (ms) => { reconnectDelayMs = ms; },
          });
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          return;
        }
        events?.onError(error instanceof Error ? error : new Error(String(error)));
      }

      // Stream ended (clean EOF or a recoverable error). Resume unless the
      // transport is closing or the reconnect budget is exhausted.
      if (!isConnected || !abortController || abortController.signal.aborted) {
        return;
      }
      attempts += 1;
      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        return;
      }
      await delayBeforeReconnect(reconnectDelayMs);
    }
  }

  function startNotificationStream(): void {
    if (notificationStreamStarted || !abortController) {
      return;
    }
    notificationStreamStarted = true;
    openNotificationStream().catch(() => {});
  }

  return {
    get connected() {
      return isConnected;
    },

    setProtocolVersion(version) {
      protocolVersion = version;
    },

    async open(ev) {
      events = ev;
      abortController = new AbortController();
      isConnected = true;
    },

    async send(json) {
      if (!isConnected) {
        throw new Error('Streamable HTTP transport is not connected.');
      }
      const method = readMessageMethod(json);
      const response = await fetch(config.url, {
        method: 'POST',
        headers: withSessionHeaders({
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        }),
        body: json,
        signal: abortController?.signal,
      });
      captureSessionId(response);
      if (!response.ok) {
        if (handleExpiredSession(response.status)) {
          throw new McpExpiredSessionError();
        }
        // 401 (needs auth) and 403 with a Bearer challenge (step-up) carry a
        // WWW-Authenticate header the connect flow uses to discover/elevate.
        const wwwAuthenticate = response.headers.get('www-authenticate') ?? undefined;
        if (response.status === 401 || (response.status === 403 && wwwAuthenticate)) {
          throw new McpAuthRequiredError(response.status, wwwAuthenticate);
        }
        throw new McpHttpStatusError(response.status, response.statusText);
      }
      if (method !== 'initialize') {
        startNotificationStream();
      }

      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream') && response.body) {
        // Streaming response — parse SSE events. Track event ids here too so a
        // later GET-stream resume can pick up from the right cursor.
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let remainder = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          remainder = parseSseChunks(decoder.decode(value, { stream: true }), remainder, {
            onEvent: (event) => {
              if (event.id !== undefined) {
                lastEventId = event.id;
              }
              if (event.event === 'message') {
                events?.onMessage(event.data);
              }
            },
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
      const sessionIdToClose = sessionId;
      const protocolVersionToClose = protocolVersion;
      const closeController = abortController;
      isConnected = false;
      sessionId = undefined;
      protocolVersion = undefined;
      notificationStreamStarted = false;
      abortController = undefined;
      closeController?.abort();
      if (sessionIdToClose) {
        const deleteController = new AbortController();
        const deleteTimer = setTimeout(() => {
          deleteController.abort();
        }, CLOSE_SESSION_TIMEOUT_MS);
        deleteTimer.unref?.();
        await fetch(config.url, {
          method: 'DELETE',
          headers: {
            ...(config.headers ?? {}),
            ...(protocolVersionToClose ? { 'MCP-Protocol-Version': protocolVersionToClose } : {}),
            'MCP-Session-Id': sessionIdToClose,
          },
          signal: deleteController.signal,
        }).catch(() => {}).finally(() => {
          clearTimeout(deleteTimer);
        });
      }
    },
  };
}

function shouldFallbackToLegacySse(error: unknown): boolean {
  return error instanceof McpHttpStatusError
    && (error.status === 400 || error.status === 404 || error.status === 405);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function autoHttpFallbackError(streamableError: unknown, sseError: unknown): Error {
  const error = new Error(
    `HTTP auto-detect failed. Streamable HTTP attempt: ${errorMessage(streamableError)}; `
    + `legacy SSE fallback: ${errorMessage(sseError)}`,
  );
  error.name = 'McpAutoHttpFallbackError';
  return error;
}

export function createAutoHttpTransport(config: {
  url: string;
  headers?: Record<string, string>;
  preferredTransport?: 'streamable-http' | 'sse';
}): McpTransport {
  let transport: McpTransport | undefined;
  let events: McpTransportEvents | undefined;
  let protocolVersion: string | undefined;
  let resolvedTransport: string | undefined;

  function createStreamable(): McpTransport {
    const next = createStreamableHttpTransport(config);
    next.setProtocolVersion?.(protocolVersion);
    return next;
  }

  function createSse(): McpTransport {
    const next = createSseTransport(config);
    next.setProtocolVersion?.(protocolVersion);
    return next;
  }

  return {
    get connected() {
      return transport?.connected ?? false;
    },

    get resolvedTransport() {
      return resolvedTransport ?? 'http:auto';
    },

    setProtocolVersion(version) {
      protocolVersion = version;
      transport?.setProtocolVersion?.(version);
    },

    async open(ev) {
      events = ev;
      resolvedTransport = config.preferredTransport
        ? `http:auto->${config.preferredTransport}`
        : undefined;
      transport = config.preferredTransport === 'sse'
        ? createSse()
        : createStreamable();
      await transport.open(ev);
    },

    async send(json) {
      if (!transport) {
        throw new Error('HTTP auto transport is not connected.');
      }
      try {
        await transport.send(json);
        if (!resolvedTransport) {
          resolvedTransport = 'http:auto->streamable-http';
        }
      } catch (error) {
        if (resolvedTransport || !shouldFallbackToLegacySse(error)) {
          throw error;
        }
        await transport.close();
        if (!events) {
          throw error;
        }
        transport = createSse();
        resolvedTransport = 'http:auto->sse';
        try {
          await transport.open(events);
          await transport.send(json);
        } catch (sseError) {
          throw autoHttpFallbackError(error, sseError);
        }
      }
    },

    async close() {
      await transport?.close();
      transport = undefined;
      events = undefined;
      resolvedTransport = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface McpTransportOptions {
  stdioFraming?: StdioFraming;
  httpResolvedTransport?: 'streamable-http' | 'sse';
}

function resolveEnvironmentString(value: string): string {
  let offset = 0;
  while (true) {
    const start = value.indexOf('${env:', offset);
    if (start < 0) {
      break;
    }
    const match = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/.exec(value.slice(start));
    if (!match?.[0]) {
      throw new Error('MCP configuration contains a malformed environment reference.');
    }
    offset = start + match[0].length;
  }
  return value.replace(
    /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_reference, environmentName: string) => {
      const resolved = globalThis.process.env[environmentName];
      if (resolved === undefined) {
        throw new Error(`MCP environment variable "${environmentName}" is not set.`);
      }
      return resolved;
    },
  );
}

function resolveEnvironmentReferences(
  values: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!values) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      resolveEnvironmentString(value),
    ]),
  );
}

function resolveHttpHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const resolved = resolveEnvironmentReferences(headers);
  if (!resolved) {
    return undefined;
  }
  for (const [name, value] of Object.entries(resolved)) {
    try {
      new Headers([[name, value]]);
    } catch {
      throw new Error('Invalid MCP HTTP header configuration.');
    }
  }
  return resolved;
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
        command: resolveEnvironmentString(config.command),
        args: config.args?.map(resolveEnvironmentString),
        cwd: config.cwd !== undefined ? resolveEnvironmentString(config.cwd) : undefined,
        env: resolveEnvironmentReferences(config.env),
        framing: options.stdioFraming,
      });
    }
    case 'sse': {
      if (!config.url) {
        throw new Error('MCP SSE transport requires a "url" field.');
      }
      return createSseTransport({
        url: resolveEnvironmentString(config.url),
        headers: resolveHttpHeaders(config.headers),
      });
    }
    case 'streamable-http': {
      if (!config.url) {
        throw new Error('MCP streamable-http transport requires a "url" field.');
      }
      return createStreamableHttpTransport({
        url: resolveEnvironmentString(config.url),
        headers: resolveHttpHeaders(config.headers),
      });
    }
    case 'http': {
      if (!config.url) {
        throw new Error('MCP http auto transport requires a "url" field.');
      }
      return createAutoHttpTransport({
        url: resolveEnvironmentString(config.url),
        headers: resolveHttpHeaders(config.headers),
        preferredTransport: options.httpResolvedTransport,
      });
    }
    default:
      throw new Error(`Unknown MCP transport type: ${type as string}`);
  }
}
