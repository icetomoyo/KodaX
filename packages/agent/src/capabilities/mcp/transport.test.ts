import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpTransport,
  createSseTransport,
  createStdioTransport,
  createStreamableHttpTransport,
} from './transport.js';

// ---------------------------------------------------------------------------
// Minimal SSE server for testing
// ---------------------------------------------------------------------------

/** Windows can assign a dynamic port forbidden by Fetch; retry only that fixture condition. */
async function listenForFetch(server: http.Server): Promise<{ url: string }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const probe = await fetch(url);
      await probe.arrayBuffer();
      return { url };
    } catch (error) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (!(error instanceof Error && error.cause instanceof Error && error.cause.message === 'bad port')) throw error;
    }
  }
  throw new Error('Could not allocate a Fetch-compatible fixture port.');
}

function createTestSseServer(): {
  server: http.Server;
  start: () => Promise<{ url: string }>;
  stop: () => Promise<void>;
  postEndpoint: string;
  /** Messages POSTed to the endpoint by the transport. */
  receivedMessages: string[];
  authorizationHeaders: string[];
  /** Send an SSE event to the connected client. */
  sendEvent: (event: string, data: string) => void;
} {
  const receivedMessages: string[] = [];
  const authorizationHeaders: string[] = [];
  let sseResponse: http.ServerResponse | undefined;
  let postEndpoint = '';

  const sendEvent = (event: string, data: string) => {
    sseResponse?.write(`event:${event}\ndata:${data}\n\n`);
  };

  const server = http.createServer((req, res) => {
    const authorization = req.headers.authorization;
    if (authorization !== undefined) {
      authorizationHeaders.push(Array.isArray(authorization)
        ? authorization[0] ?? ''
        : authorization);
    }
    if (req.method === 'GET' && req.headers.accept?.includes('text/event-stream')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      sseResponse = res;
      // Send endpoint event.
      sendEvent('endpoint', postEndpoint);
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        receivedMessages.push(body);
        // Parse JSON-RPC and echo a response.
        try {
          const parsed = JSON.parse(body) as { id?: number; method?: string };
          if (parsed.id !== undefined) {
            const responsePayload = JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: { echo: parsed.method },
            });
            // Send as SSE message event.
            sendEvent('message', responsePayload);
          }
        } catch {
          // Ignore parse errors.
        }
        res.writeHead(202);
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    server,
    receivedMessages,
    authorizationHeaders,
    postEndpoint,
    sendEvent,
    start: async () => {
      const { url } = await listenForFetch(server);
      postEndpoint = `${url}/messages`;
      return { url };
    },
    stop: () => new Promise<void>((resolve) => {
      sseResponse?.end();
      server.close(() => resolve());
    }),
  };
}

// ---------------------------------------------------------------------------
// Minimal Streamable HTTP server for testing
// ---------------------------------------------------------------------------

function createTestStreamableHttpServer(): {
  server: http.Server;
  start: () => Promise<{ url: string }>;
  stop: () => Promise<void>;
  receivedMessages: string[];
  authorizationHeaders: string[];
  mode: 'json' | 'sse';
} {
  const receivedMessages: string[] = [];
  const authorizationHeaders: string[] = [];
  const state = { mode: 'json' as 'json' | 'sse' };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.headers.accept?.includes('text/event-stream')) {
      // Optional notification stream — return 405 to signal unsupported.
      res.writeHead(405);
      res.end();
      return;
    }

    if (req.method === 'POST') {
      const authorization = req.headers.authorization;
      authorizationHeaders.push(Array.isArray(authorization)
        ? authorization[0] ?? ''
        : authorization ?? '');
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        receivedMessages.push(body);
        try {
          const parsed = JSON.parse(body) as { id?: number; method?: string };
          const responsePayload = JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: { echo: parsed.method },
          });

          if (state.mode === 'sse') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`event:message\ndata:${responsePayload}\n\n`);
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(responsePayload);
          }
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    server,
    receivedMessages,
    authorizationHeaders,
    get mode() { return state.mode; },
    set mode(m) { state.mode = m; },
    start: () => listenForFetch(server),
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

function createSessionStreamableHttpServer(): {
  server: http.Server;
  start: () => Promise<{ url: string }>;
  stop: () => Promise<void>;
  receivedMessages: string[];
  observedSessionHeaders: string[];
  observedGetSessionHeaders: string[];
  observedProtocolHeaders: string[];
  observedGetProtocolHeaders: string[];
  deleteSessionHeaders: string[];
  deleteProtocolHeaders: string[];
  sessionId: string;
} {
  const sessionId = 'session-abc-123';
  const receivedMessages: string[] = [];
  const observedSessionHeaders: string[] = [];
  const observedGetSessionHeaders: string[] = [];
  const observedProtocolHeaders: string[] = [];
  const observedGetProtocolHeaders: string[] = [];
  const deleteSessionHeaders: string[] = [];
  const deleteProtocolHeaders: string[] = [];

  const server = http.createServer((req, res) => {
    const requestSessionId = req.headers['mcp-session-id'];
    const normalizedSessionId = Array.isArray(requestSessionId)
      ? requestSessionId[0] ?? ''
      : requestSessionId ?? '';
    const requestProtocolVersion = req.headers['mcp-protocol-version'];
    const normalizedProtocolVersion = Array.isArray(requestProtocolVersion)
      ? requestProtocolVersion[0] ?? ''
      : requestProtocolVersion ?? '';

    if (req.method === 'GET' && req.headers.accept?.includes('text/event-stream')) {
      observedGetSessionHeaders.push(normalizedSessionId);
      observedGetProtocolHeaders.push(normalizedProtocolVersion);
      if (normalizedSessionId !== sessionId) {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.end();
      return;
    }

    if (req.method === 'DELETE') {
      deleteSessionHeaders.push(normalizedSessionId);
      deleteProtocolHeaders.push(normalizedProtocolVersion);
      if (normalizedSessionId !== sessionId) {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        receivedMessages.push(body);
        try {
          const parsed = JSON.parse(body) as { id?: number; method?: string };
          if (parsed.method !== 'initialize') {
            observedSessionHeaders.push(normalizedSessionId);
            observedProtocolHeaders.push(normalizedProtocolVersion);
            if (normalizedSessionId !== sessionId) {
              res.writeHead(400);
              res.end();
              return;
            }
          }

          if (parsed.method === 'initialize') {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Mcp-Session-Id': sessionId,
            });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                serverInfo: { name: 'session-test', version: '1.0.0' },
              },
            }));
            return;
          }

          if (parsed.id === undefined) {
            res.writeHead(202);
            res.end();
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: { ok: true, method: parsed.method },
          }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    server,
    receivedMessages,
    observedSessionHeaders,
    observedGetSessionHeaders,
    observedProtocolHeaders,
    observedGetProtocolHeaders,
    deleteSessionHeaders,
    deleteProtocolHeaders,
    sessionId,
    start: () => listenForFetch(server),
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

// =========================================================================
// Tests
// =========================================================================

describe('Stdio transport', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('uses NDJSON framing by default', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-stdio-framing-'));
    tempDirs.push(tempDir);
    const rawPath = path.join(tempDir, 'stdin.txt');
    const source = `
const fs = require('node:fs');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(rawPath)}, raw);
  process.exit(0);
});
`;
    const transport = createStdioTransport({
      command: process.execPath,
      args: ['-e', source],
    });

    await transport.open({
      onMessage: () => {},
      onError: () => {},
      onClose: () => {},
    });
    const json = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
    await transport.send(json);
    await transport.close();

    await expect(readFile(rawPath, 'utf8')).resolves.toBe(`${json}\n`);
  });

  it('closes stdin subprocesses gracefully before returning', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-stdio-close-'));
    tempDirs.push(tempDir);
    const markerPath = path.join(tempDir, 'closed.txt');
    const source = `
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(markerPath)}, 'closed');
  process.exit(0);
});
`;
    const transport = createStdioTransport({
      command: process.execPath,
      args: ['-e', source],
    });

    await transport.open({
      onMessage: () => {},
      onError: () => {},
      onClose: () => {},
    });
    await transport.close();

    await expect(readFile(markerPath, 'utf8')).resolves.toBe('closed');
    expect(transport.connected).toBe(false);
  });

  it('expands environment references in stdio child variables without mutating config', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-stdio-env-reference-'));
    tempDirs.push(tempDir);
    const markerPath = path.join(tempDir, 'env.txt');
    const referenceName = 'KODAX_MCP_STDIO_ENV_REFERENCE_TEST';
    const previous = process.env[referenceName];
    process.env[referenceName] = 'resolved-value';
    const config = {
      command: process.execPath,
      args: ['-e', `
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(markerPath)}, process.env.MCP_REFERENCE_VALUE ?? '');
  process.exit(0);
});
`],
      env: {
        MCP_REFERENCE_VALUE: `prefix-\${env:${referenceName}}-suffix`,
      },
    };

    try {
      const transport = createMcpTransport(config);
      await transport.open({
        onMessage: () => {},
        onError: () => {},
        onClose: () => {},
      });
      await transport.close();

      await expect(readFile(markerPath, 'utf8')).resolves.toBe('prefix-resolved-value-suffix');
      expect(config.env.MCP_REFERENCE_VALUE).toBe(`prefix-\${env:${referenceName}}-suffix`);
    } finally {
      if (previous === undefined) delete process.env[referenceName];
      else process.env[referenceName] = previous;
    }
  });

  it('rejects an unset environment reference before starting the server', () => {
    const referenceName = 'KODAX_MCP_MISSING_ENV_REFERENCE_TEST';
    const previous = process.env[referenceName];
    delete process.env[referenceName];

    try {
      expect(() => createMcpTransport({
        command: process.execPath,
        env: { MCP_REFERENCE_VALUE: `\${env:${referenceName}}` },
      })).toThrow(new RegExp(referenceName));
    } finally {
      if (previous !== undefined) process.env[referenceName] = previous;
    }
  });

  it.each([
    '${env:}',
    '${env:INVALID-NAME}',
    '${env:UNCLOSED',
  ])('rejects malformed environment reference %s', (reference) => {
    expect(() => createMcpTransport({
      command: process.execPath,
      env: { MCP_REFERENCE_VALUE: reference },
    })).toThrow(/malformed environment reference/i);
  });

  it('expands environment references in stdio command, args, and cwd without mutating config', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-stdio-fields-env-reference-'));
    tempDirs.push(tempDir);
    const markerPath = path.join(tempDir, 'fields.txt');
    const cmdName = 'KODAX_MCP_STDIO_CMD_ENV_REFERENCE_TEST';
    const argName = 'KODAX_MCP_STDIO_ARG_ENV_REFERENCE_TEST';
    const cwdName = 'KODAX_MCP_STDIO_CWD_ENV_REFERENCE_TEST';
    const previousCmd = process.env[cmdName];
    const previousArg = process.env[argName];
    const previousCwd = process.env[cwdName];
    process.env[cmdName] = process.execPath;
    process.env[argName] = 'resolved-arg';
    process.env[cwdName] = tempDir;
    const source = `
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(markerPath)}, process.cwd() + '|' + process.argv.join('|'));
  process.exit(0);
});
`;
    const config = {
      command: '${env:' + cmdName + '}',
      args: ['-e', source, '${env:' + argName + '}'],
      cwd: '${env:' + cwdName + '}',
    };

    try {
      const transport = createMcpTransport(config);
      await transport.open({
        onMessage: () => {},
        onError: () => {},
        onClose: () => {},
      });
      await transport.close();

      const content = await readFile(markerPath, 'utf8');
      const cwdPart = content.slice(0, content.indexOf('|'));
      expect(cwdPart.toLowerCase()).toBe(tempDir.toLowerCase());
      expect(content).toContain('resolved-arg');
      expect(config.command).toBe('${env:' + cmdName + '}');
      expect(config.args[2]).toBe('${env:' + argName + '}');
      expect(config.cwd).toBe('${env:' + cwdName + '}');
    } finally {
      if (previousCmd === undefined) delete process.env[cmdName];
      else process.env[cmdName] = previousCmd;
      if (previousArg === undefined) delete process.env[argName];
      else process.env[argName] = previousArg;
      if (previousCwd === undefined) delete process.env[cwdName];
      else process.env[cwdName] = previousCwd;
    }
  });
});

describe('SSE transport', () => {
  const servers: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });

  it('connects, receives endpoint event, sends JSON-RPC, receives SSE response', async () => {
    const mock = createTestSseServer();
    servers.push(mock);
    const { url } = await mock.start();
    // The endpoint URL needs to be set after the server starts.
    (mock as { postEndpoint: string }).postEndpoint = `${url}/messages`;

    const transport = createSseTransport({ url });
    const messages: string[] = [];

    await transport.open({
      onMessage: (raw) => messages.push(raw),
      onError: () => {},
      onClose: () => {},
    });

    expect(transport.connected).toBe(true);

    // Send a JSON-RPC request.
    await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test/echo', params: {} }));

    // Wait for the SSE response.
    await new Promise((r) => setTimeout(r, 200));

    expect(mock.receivedMessages.length).toBeGreaterThanOrEqual(1);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(messages[0]!) as { id: number; result: { echo: string } };
    expect(parsed.id).toBe(1);
    expect(parsed.result.echo).toBe('test/echo');

    await transport.close();
  });

  it('rebinds a fixture port rejected by Fetch before testing the SSE transport', async () => {
    const mock = createTestSseServer();
    servers.push(mock);
    const listening = vi.fn();
    mock.server.on('listening', listening);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new TypeError('fetch failed', { cause: new Error('bad port') }));
    let transport: ReturnType<typeof createSseTransport> | undefined;
    try {
      const { url } = await mock.start();
      transport = createSseTransport({ url });
      await transport.open({ onMessage: () => {}, onError: () => {}, onClose: () => {} });
      expect(transport.connected).toBe(true);
      expect(listening).toHaveBeenCalledTimes(2);
    } finally {
      await transport?.close();
      fetchSpy.mockRestore();
    }
  });

  it('surfaces other fixture startup errors without retrying', async () => {
    const mock = createTestSseServer();
    servers.push(mock);
    const listening = vi.fn();
    mock.server.on('listening', listening);
    const failure = new TypeError('fetch failed', { cause: new Error('Connection refused') });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(failure);
    try {
      await expect(mock.start()).rejects.toBe(failure);
      expect(listening).toHaveBeenCalledOnce();
      expect(mock.server.listening).toBe(false);
    } finally { fetchSpy.mockRestore(); }
  });

  it('expands environment references embedded in SSE headers', async () => {
    const mock = createTestSseServer();
    servers.push(mock);
    const { url } = await mock.start();
    (mock as { postEndpoint: string }).postEndpoint = `${url}/messages`;
    const referenceName = 'KODAX_MCP_SSE_ENV_REFERENCE_TEST';
    const previous = process.env[referenceName];
    process.env[referenceName] = 'resolved-sse-token';
    const config = {
      type: 'sse' as const,
      url,
      headers: { Authorization: `Bearer \${env:${referenceName}}` },
    };

    try {
      const transport = createMcpTransport(config);
      await transport.open({
        onMessage: () => {},
        onError: () => {},
        onClose: () => {},
      });
      await transport.close();

      expect(mock.authorizationHeaders).toContain('Bearer resolved-sse-token');
      expect(config.headers.Authorization).toBe(`Bearer \${env:${referenceName}}`);
    } finally {
      if (previous === undefined) delete process.env[referenceName];
      else process.env[referenceName] = previous;
    }
  });

  it('expands environment references embedded in the SSE url', async () => {
    const mock = createTestSseServer();
    servers.push(mock);
    const { url } = await mock.start();
    (mock as { postEndpoint: string }).postEndpoint = `${url}/messages`;
    const referenceName = 'KODAX_MCP_SSE_URL_ENV_REFERENCE_TEST';
    const previous = process.env[referenceName];
    process.env[referenceName] = url;
    const config = {
      type: 'sse' as const,
      url: '${env:' + referenceName + '}',
    };

    try {
      const transport = createMcpTransport(config);
      await transport.open({
        onMessage: () => {},
        onError: () => {},
        onClose: () => {},
      });
      await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test/echo', params: {} }));
      await new Promise((r) => setTimeout(r, 200));
      expect(mock.receivedMessages.length).toBeGreaterThanOrEqual(1);
      await transport.close();
      expect(config.url).toBe('${env:' + referenceName + '}');
    } finally {
      if (previous === undefined) delete process.env[referenceName];
      else process.env[referenceName] = previous;
    }
  });

  it('rejects an unset environment reference in the SSE url', () => {
    const referenceName = 'KODAX_MCP_MISSING_SSE_URL_ENV_REFERENCE_TEST';
    const previous = process.env[referenceName];
    delete process.env[referenceName];

    try {
      expect(() => createMcpTransport({
        type: 'sse',
        url: '${env:' + referenceName + '}',
      })).toThrow(new RegExp(referenceName));
    } finally {
      if (previous !== undefined) process.env[referenceName] = previous;
    }
  });

  it.each([
    '${env:}',
    '${env:INVALID-NAME}',
    '${env:UNCLOSED',
  ])('rejects a malformed environment reference %s in the SSE url', (reference) => {
    expect(() => createMcpTransport({
      type: 'sse',
      url: reference,
    })).toThrow(/malformed environment reference/i);
  });
});

describe('Streamable HTTP transport', () => {
  const servers: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });

  it('sends JSON-RPC and receives JSON response', async () => {
    const mock = createTestStreamableHttpServer();
    mock.mode = 'json';
    servers.push(mock);
    const { url } = await mock.start();

    const transport = createStreamableHttpTransport({ url });
    const messages: string[] = [];

    await transport.open({
      onMessage: (raw) => messages.push(raw),
      onError: () => {},
      onClose: () => {},
    });

    await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test/json', params: {} }));

    // send() should have delivered the response synchronously via onMessage.
    expect(messages).toHaveLength(1);
    const parsed = JSON.parse(messages[0]!) as { id: number; result: { echo: string } };
    expect(parsed.id).toBe(1);
    expect(parsed.result.echo).toBe('test/json');

    await transport.close();
  });

  it.each(['streamable-http', 'http'] as const)(
    'expands environment references embedded in %s headers',
    async (type) => {
      const mock = createTestStreamableHttpServer();
      servers.push(mock);
      const { url } = await mock.start();
      const referenceName = 'KODAX_MCP_HTTP_ENV_REFERENCE_TEST';
      const previous = process.env[referenceName];
      process.env[referenceName] = 'resolved-token';
      const config = {
        type,
        url,
        headers: { Authorization: `Bearer \${env:${referenceName}}` },
      };

      try {
        const transport = createMcpTransport(config);
        await transport.open({
          onMessage: () => {},
          onError: () => {},
          onClose: () => {},
        });
        await transport.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'test/headers',
          params: {},
        }));
        await transport.close();

        expect(mock.authorizationHeaders).toContain('Bearer resolved-token');
        expect(config.headers.Authorization).toBe(`Bearer \${env:${referenceName}}`);
      } finally {
        if (previous === undefined) delete process.env[referenceName];
        else process.env[referenceName] = previous;
      }
    },
  );

  it('rejects an unset environment reference in HTTP headers', () => {
    const referenceName = 'KODAX_MCP_MISSING_HTTP_ENV_REFERENCE_TEST';
    const previous = process.env[referenceName];
    delete process.env[referenceName];

    try {
      expect(() => createMcpTransport({
        type: 'http',
        url: 'https://example.test/mcp',
        headers: { Authorization: `Bearer \${env:${referenceName}}` },
      })).toThrow(new RegExp(referenceName));
    } finally {
      if (previous !== undefined) process.env[referenceName] = previous;
    }
  });

  it('rejects invalid resolved HTTP headers without exposing their values', () => {
    const referenceName = 'KODAX_MCP_INVALID_HTTP_ENV_REFERENCE_TEST';
    const previous = process.env[referenceName];
    process.env[referenceName] = 'review-secret\nvalue';

    try {
      let thrown: unknown;
      try {
        createMcpTransport({
          type: 'streamable-http',
          url: 'https://example.test/mcp',
          headers: { Authorization: `Bearer \${env:${referenceName}}` },
        });
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/invalid.*header/i);
      expect((thrown as Error).message).not.toContain('review-secret');
      expect((thrown as Error).message).not.toContain('value');
    } finally {
      if (previous === undefined) delete process.env[referenceName];
      else process.env[referenceName] = previous;
    }
  });

  it('sends JSON-RPC and receives SSE streamed response', async () => {
    const mock = createTestStreamableHttpServer();
    mock.mode = 'sse';
    servers.push(mock);
    const { url } = await mock.start();

    const transport = createStreamableHttpTransport({ url });
    const messages: string[] = [];

    await transport.open({
      onMessage: (raw) => messages.push(raw),
      onError: () => {},
      onClose: () => {},
    });

    await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'test/sse', params: {} }));

    expect(messages).toHaveLength(1);
    const parsed = JSON.parse(messages[0]!) as { id: number; result: { echo: string } };
    expect(parsed.id).toBe(2);
    expect(parsed.result.echo).toBe('test/sse');

    await transport.close();
  });

  it('persists session and protocol headers on later POST, GET, and DELETE requests', async () => {
    const mock = createSessionStreamableHttpServer();
    servers.push(mock);
    const { url } = await mock.start();

    const transport = createStreamableHttpTransport({ url });
    const messages: string[] = [];

    await transport.open({
      onMessage: (raw) => messages.push(raw),
      onError: () => {},
      onClose: () => {},
    });

    await transport.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    }));
    transport.setProtocolVersion?.('2025-11-25');
    await transport.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }));
    await transport.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    await transport.close();

    expect(messages).toHaveLength(2);
    expect(mock.observedSessionHeaders).toEqual([
      mock.sessionId,
      mock.sessionId,
    ]);
    expect(mock.observedProtocolHeaders).toEqual([
      '2025-11-25',
      '2025-11-25',
    ]);
    expect(mock.observedGetSessionHeaders).toContain(mock.sessionId);
    expect(mock.observedGetProtocolHeaders).toContain('2025-11-25');
    expect(mock.deleteSessionHeaders).toEqual([mock.sessionId]);
    expect(mock.deleteProtocolHeaders).toEqual(['2025-11-25']);
  });

  it('bounds session DELETE during close when the server never responds', async () => {
    const sessionId = 'hanging-delete-session';
    const deleteSessionHeaders: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          const parsed = JSON.parse(body) as { id?: number };
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': sessionId,
          });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              serverInfo: { name: 'hanging-delete', version: '1.0.0' },
            },
          }));
        });
        return;
      }

      if (req.method === 'DELETE') {
        const requestSessionId = req.headers['mcp-session-id'];
        deleteSessionHeaders.push(Array.isArray(requestSessionId)
          ? requestSessionId[0] ?? ''
          : requestSessionId ?? '');
        return;
      }

      res.writeHead(405);
      res.end();
    });

    servers.push({
      stop: () => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    });
    const url = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    const transport = createStreamableHttpTransport({ url });
    await transport.open({ onMessage: () => {}, onError: () => {}, onClose: () => {} });
    await transport.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    }));

    const startedAt = Date.now();
    await transport.close();

    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(deleteSessionHeaders).toEqual([sessionId]);
  });
});

describe('Streamable HTTP notification stream resumption', () => {
  it('resumes a dropped GET stream with Last-Event-ID, honors retry, and clears empty ids', async () => {
    const sessionId = 'resume-session';
    const getLastEventIds: string[] = [];
    let getCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          const parsed = JSON.parse(body) as { id?: number };
          if (parsed.id === undefined) {
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }));
        });
        return;
      }
      if (req.method === 'GET') {
        getCount += 1;
        const header = req.headers['last-event-id'];
        getLastEventIds.push(Array.isArray(header) ? (header[0] ?? '') : (header ?? ''));
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (getCount === 1) {
          // Emit one event then drop the stream; the client must resume.
          res.write('retry: 50\nid: evt-1\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/x","params":{}}\n\n');
          res.end();
          return;
        }
        if (getCount === 2) {
          // Empty id resets the resume cursor; the next GET must not carry evt-1.
          res.write('retry: 50\nid:\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/y","params":{}}\n\n');
          res.end();
          return;
        }
        // Later GETs stay open; the test closes the transport to end them.
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const url = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    const messages: string[] = [];
    const transport = createStreamableHttpTransport({ url });
    await transport.open({
      onMessage: (message) => messages.push(message),
      onError: () => {},
      onClose: () => {},
    });

    try {
      // A non-initialize POST starts the background notification GET stream.
      await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));

      await expect.poll(() => getLastEventIds.length, { timeout: 2_000 }).toBeGreaterThanOrEqual(3);
      expect(getLastEventIds[0]).toBe('');
      expect(getLastEventIds[1]).toBe('evt-1');
      expect(getLastEventIds[2]).toBe('');
      expect(messages.some((message) => message.includes('notifications/x'))).toBe(true);
      expect(messages.some((message) => message.includes('notifications/y'))).toBe(true);
    } finally {
      await transport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('stops reconnecting after the budget when the stream yields no events', async () => {
    const sessionId = 'empty-eof-session';
    let getCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          const parsed = JSON.parse(body) as { id?: number };
          if (parsed.id === undefined) {
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }));
        });
        return;
      }
      if (req.method === 'GET') {
        getCount += 1;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        // retry-only (no data event): shortens the reconnect delay without
        // resetting the attempt budget, so the loop MUST terminate at the cap.
        res.write('retry: 20\n\n');
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const url = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    const transport = createStreamableHttpTransport({ url });
    await transport.open({ onMessage: () => {}, onError: () => {}, onClose: () => {} });

    try {
      await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
      // Initial GET + at most MAX_RECONNECT_ATTEMPTS (5) reconnects = 6 total.
      await expect.poll(() => getCount, { timeout: 3_000 }).toBe(6);
      // It must not keep reconnecting past the budget.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(getCount).toBe(6);
    } finally {
      await transport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
