import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServerRuntime } from './runtime.js';
import type { McpReverseCapabilities } from './reverse-capabilities.js';

type JsonObject = Record<string, unknown>;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-runtime-'));
  tempDirs.push(dir);
  return dir;
}

function asRecord(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function getHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function writeJsonRpcResponse(
  res: http.ServerResponse,
  id: unknown,
  result: JsonObject,
  headers: Record<string, string> = {},
): void {
  res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

async function writeScript(dir: string, source: string): Promise<string> {
  const scriptPath = path.join(dir, 'server.cjs');
  await writeFile(scriptPath, source, 'utf8');
  return scriptPath;
}

function createNdjsonServerSource(options: {
  startsPath: string;
  protocolPath?: string;
  responseProtocolVersion?: string;
}): string {
  const responseProtocolVersion = options.responseProtocolVersion ?? '2025-11-25';
  return `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(options.startsPath)}, 'start\\n');
let buffer = '';

function writeMessage(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

function writeList(id, key) {
  const result = {};
  result[key] = key === 'tools'
    ? [{ name: 'echo_tool', inputSchema: { type: 'object' } }]
    : [];
  writeMessage({ jsonrpc: '2.0', id, result });
}

function handle(message) {
  const method = message.method;
  if (method === 'initialize') {
    ${options.protocolPath
    ? `fs.writeFileSync(${JSON.stringify(options.protocolPath)}, String((message.params || {}).protocolVersion || ''));`
    : ''}
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: ${JSON.stringify(responseProtocolVersion)},
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'runtime-test', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    writeList(message.id, 'tools');
    return;
  }
  if (method === 'resources/list') {
    writeList(message.id, 'resources');
    return;
  }
  if (method === 'prompts/list') {
    writeList(message.id, 'prompts');
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) {
      return;
    }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) {
      continue;
    }
    try {
      handle(JSON.parse(line));
    } catch {
      process.exit(2);
    }
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createContentLengthServerSource(startsPath: string): string {
  return `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(startsPath)}, 'start\\n');
let buffer = Buffer.alloc(0);

function writeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}

function writeList(id, key) {
  const result = {};
  result[key] = key === 'tools'
    ? [{ name: 'legacy_tool', inputSchema: { type: 'object' } }]
    : [];
  writeMessage({ jsonrpc: '2.0', id, result });
}

function handle(message) {
  const method = message.method;
  if (method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'legacy-runtime-test', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    writeList(message.id, 'tools');
    return;
  }
  if (method === 'resources/list') {
    writeList(message.id, 'resources');
    return;
  }
  if (method === 'prompts/list') {
    writeList(message.id, 'prompts');
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer[0] === 0x7B) {
    process.exit(3);
  }
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) {
      process.exit(4);
    }
    const length = Number(match[1]);
    const frameEnd = headerEnd + 4 + length;
    if (buffer.length < frameEnd) {
      return;
    }
    const body = buffer.subarray(headerEnd + 4, frameEnd).toString('utf8');
    buffer = buffer.subarray(frameEnd);
    handle(JSON.parse(body));
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createCapabilityServerSource(options: {
  pongPath: string;
  numberPongPath?: string;
  cancelPath: string;
}): string {
  return `
const fs = require('node:fs');
let buffer = '';

function writeMessage(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

function handle(message) {
  // Response from the client (e.g. our ping's pong) — no method, has result.
  if (message.method === undefined && message.id !== undefined && message.result !== undefined) {
    if (message.id === 'srv-ping') {
      fs.writeFileSync(${JSON.stringify(options.pongPath)}, 'pong');
    }
    if (message.id === 42 && ${options.numberPongPath ? 'true' : 'false'}) {
      fs.writeFileSync(${JSON.stringify(options.numberPongPath ?? '')}, 'pong-number');
    }
    return;
  }
  const method = message.method;
  if (method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'cap-test', version: '1.0.0' },
      },
    });
    // Proactively ping the client; the spec requires an empty-result reply.
    writeMessage({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' });
    writeMessage({ jsonrpc: '2.0', id: 42, method: 'ping' });
    return;
  }
  if (method === 'notifications/cancelled') {
    fs.appendFileSync(${JSON.stringify(options.cancelPath)}, JSON.stringify(message.params) + '\\n');
    return;
  }
  if (method === 'tools/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { tools: [
      {
        name: 'safe_tool',
        inputSchema: { type: 'object' },
        icons: [{ src: 'https://example.com/i.png' }, { src: 'javascript:bad' }],
        execution: { taskSupport: 'optional' },
      },
      { name: 'task_only', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
    ] } });
    return;
  }
  if (method === 'resources/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { resources: [] } });
    return;
  }
  if (method === 'prompts/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { prompts: [] } });
    return;
  }
  // tools/call is intentionally left unanswered so the client times out and
  // (per spec) emits notifications/cancelled.
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) {
      return;
    }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) {
      continue;
    }
    try {
      handle(JSON.parse(line));
    } catch {
      process.exit(2);
    }
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createUnsupportedRequestsServerSource(recordPath: string): string {
  return `
const fs = require('node:fs');
let buffer = '';

function writeMessage(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

function record(payload) {
  fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(payload) + '\\n');
}

function handle(message) {
  if (message.method === undefined && message.id !== undefined) {
    record(message);
    return;
  }
  if (message.method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'unsupported-requests-test', version: '1.0.0' },
      },
    });
    writeMessage({ jsonrpc: '2.0', id: 'roots-1', method: 'roots/list' });
    writeMessage({ jsonrpc: '2.0', id: 'sampling-1', method: 'sampling/createMessage', params: {} });
    writeMessage({ jsonrpc: '2.0', id: 'elicitation-1', method: 'elicitation/create', params: {} });
    return;
  }
  if (message.method === 'tools/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    return;
  }
  if (message.method === 'resources/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { resources: [] } });
    return;
  }
  if (message.method === 'prompts/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { prompts: [] } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) {
      return;
    }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) {
      continue;
    }
    try {
      handle(JSON.parse(line));
    } catch {
      process.exit(2);
    }
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createRootsServerSource(recordPath: string): string {
  return `
const fs = require('node:fs');
let buffer = '';
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function record(p){ fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === undefined && m.id !== undefined) { record(m); return; } // client response
  if (m.method === 'initialize') {
    record(m); // capture the negotiated capabilities
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'roots-test', version: '1.0.0' } } });
    writeMessage({ jsonrpc: '2.0', id: 'roots-1', method: 'roots/list' });
    return;
  }
  if (m.method === 'tools/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }); return; }
  if (m.method === 'resources/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { resources: [] } }); return; }
  if (m.method === 'prompts/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { prompts: [] } }); }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createElicitationServerSource(recordPath: string): string {
  return `
const fs = require('node:fs');
let buffer = '';
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function record(p){ fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === undefined && m.id !== undefined) { record(m); return; } // client response
  if (m.method === 'initialize') {
    record(m);
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'elicit-test', version: '1.0.0' } } });
    writeMessage({ jsonrpc: '2.0', id: 'elicit-1', method: 'elicitation/create', params: { mode: 'form', message: 'Your name?', requestedSchema: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] } } });
    return;
  }
  if (m.method === 'tools/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }); return; }
  if (m.method === 'resources/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { resources: [] } }); return; }
  if (m.method === 'prompts/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { prompts: [] } }); }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createUrlElicitationServerSource(recordPath: string): string {
  return `
const fs = require('node:fs');
let buffer = '';
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function record(p){ fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === undefined && m.id !== undefined) { record(m); return; } // client response
  if (m.method === 'initialize') {
    record(m);
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'url-elicit-test', version: '1.0.0' } } });
    writeMessage({ jsonrpc: '2.0', id: 'url-1', method: 'elicitation/create', params: { mode: 'url', message: 'Authorize', url: 'https://auth.example.test/grant', elicitationId: 'flow-1' } });
    return;
  }
  if (m.method === undefined) { return; }
  if (m.method === 'tools/list'){
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
    // After the catalog round-trip, signal the url elicitation completed.
    writeMessage({ jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId: 'flow-1' } });
    return;
  }
  if (m.method === 'resources/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { resources: [] } }); return; }
  if (m.method === 'prompts/list'){
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { prompts: [] } });
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createSamplingServerSource(recordPath: string): string {
  return `
const fs = require('node:fs');
let buffer = '';
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function record(p){ fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === undefined && m.id !== undefined) { record(m); return; } // client response
  if (m.method === 'initialize') {
    record(m);
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'sampling-test', version: '1.0.0' } } });
    writeMessage({ jsonrpc: '2.0', id: 'sample-1', method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], systemPrompt: 'Be brief', maxTokens: 16, modelPreferences: { hints: [{ name: 'fast' }] } } });
    return;
  }
  if (m.method === 'tools/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }); return; }
  if (m.method === 'resources/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { resources: [] } }); return; }
  if (m.method === 'prompts/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { prompts: [] } }); }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createUrlRetryToolServerSource(
  recordPath: string,
  options: { elicitationId?: string; emitCompletion?: boolean; completionDelayMs?: number } = {},
): string {
  const elicitationIdField = options.elicitationId
    ? `, elicitationId: ${JSON.stringify(options.elicitationId)}`
    : '';
  const emitCompletion = options.emitCompletion && options.elicitationId
    ? `setTimeout(function(){ writeMessage({ jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId: ${JSON.stringify(options.elicitationId)} } }); }, ${options.completionDelayMs ?? 200});`
    : '';
  return `
const fs = require('node:fs');
let buffer = '';
let toolCalls = 0;
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function record(p){ fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === undefined && m.id !== undefined) { record(m); return; } // client response
  if (m.method === 'initialize') {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'url-retry-test', version: '1.0.0' } } });
    return;
  }
  if (m.method === 'tools/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'login_tool', inputSchema: { type: 'object' } }] } }); return; }
  if (m.method === 'resources/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { resources: [] } }); return; }
  if (m.method === 'prompts/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { prompts: [] } }); return; }
  if (m.method === 'tools/call'){
    toolCalls += 1;
    record({ kind: 'tools/call', n: toolCalls });
    if (toolCalls === 1) {
      writeMessage({ jsonrpc: '2.0', id: m.id, error: { code: -32042, message: 'authorization required', data: { elicitation: { mode: 'url', url: 'https://auth.example.test/grant', message: 'Authorize'${elicitationIdField} } } } });
      ${emitCompletion}
      return;
    }
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'logged in' }] } });
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createOptionalListsUnsupportedServerSource(): string {
  return `
let buffer = '';
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === 'initialize') {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'optional-lists-test', version: '1.0.0' } } });
    return;
  }
  if (m.method === 'tools/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } }); return; }
  if (m.method === 'resources/list'){
    writeMessage({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'resources/list not supported' } });
    return;
  }
  if (m.method === 'prompts/list'){
    writeMessage({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'prompts/list not supported' } });
    return;
  }
  if (m.method === 'tools/call'){
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'called' }] } });
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createResourcesOnlyServerSource(): string {
  return `
let buffer = '';
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === 'initialize') {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { resources: {} }, serverInfo: { name: 'resources-only-test', version: '1.0.0' } } });
    return;
  }
  if (m.method === 'tools/list'){
    writeMessage({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'tools not supported' } });
    return;
  }
  if (m.method === 'resources/list'){
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { resources: [{ uri: 'data://one', name: 'one', mimeType: 'text/plain' }] } });
    return;
  }
  if (m.method === 'prompts/list'){
    writeMessage({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'prompts not supported' } });
    return;
  }
  if (m.method === 'resources/read'){
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { contents: [{ type: 'text', text: 'resource text' }] } });
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createPartialCatalogFailureServerSource(): string {
  return `
let buffer = '';
let toolsListCalls = 0;
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === 'initialize') {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'partial-catalog-test', version: '1.0.0' } } });
    return;
  }
  if (m.method === 'tools/list') {
    toolsListCalls += 1;
    if (toolsListCalls === 1) {
      writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'complete_tool', inputSchema: { type: 'object' } }] } });
      return;
    }
    if (!m.params || !m.params.cursor) {
      writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'partial_tool', inputSchema: { type: 'object' } }], nextCursor: 'page-2' } });
      return;
    }
    writeMessage({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'catalog page 2 failed' } });
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createCatalogIntegrityServerSource(
  mode: 'malformed'
    | 'missing-identifier'
    | 'missing-resource-uri'
    | 'null-cursor'
    | 'repeated-cursor'
    | 'duplicate-entry'
    | 'list-changed-during-pagination',
): string {
  return `
let buffer = '';
let toolsListCalls = 0;
const mode = ${JSON.stringify(mode)};
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === 'initialize') {
    const capabilities = mode === 'missing-resource-uri' ? { resources: {} } : { tools: {} };
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities, serverInfo: { name: 'catalog-integrity-test', version: '1.0.0' } } });
    return;
  }
  if (mode === 'missing-resource-uri' && m.method === 'resources/list') {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { resources: [{ name: 'not-a-readable-uri' }] } });
    return;
  }
  if (m.method !== 'tools/list') return;
  toolsListCalls += 1;
  if (mode === 'list-changed-during-pagination') {
    if (toolsListCalls === 1) {
      writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'stable_tool', inputSchema: { type: 'object' } }] } });
      return;
    }
    if (toolsListCalls === 2) {
      writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'possibly_stale_one', inputSchema: { type: 'object' } }], nextCursor: 'page-2' } });
      return;
    }
    writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'possibly_stale_two', inputSchema: { type: 'object' } }] } });
    return;
  }
  if (mode === 'malformed') {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: {} } });
    return;
  }
  if (mode === 'missing-identifier') {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [{ inputSchema: { type: 'object' } }] } });
    return;
  }
  if (mode === 'null-cursor') {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [], nextCursor: null } });
    return;
  }
  if (mode === 'repeated-cursor') {
    if (toolsListCalls > 2) {
      writeMessage({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'server safeguard tripped' } });
      return;
    }
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'one', inputSchema: { type: 'object' } }], nextCursor: 'same-cursor' } });
    return;
  }
  if (!m.params || !m.params.cursor) {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'one', inputSchema: { type: 'object' } }], nextCursor: 'page-2' } });
    return;
  }
  writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'one', inputSchema: { type: 'object' } },
    { name: 'two', inputSchema: { type: 'object' } },
  ] } });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) return;
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createWhitespaceContentServerSource(): string {
  return `
let buffer = '';
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === 'initialize') {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'whitespace-content-test', version: '1.0.0' } } });
    return;
  }
  if (m.method === 'tools/list') {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'whitespace_tool', inputSchema: { type: 'object' } },
      { name: 'multi_tool', inputSchema: { type: 'object' } },
    ] } });
    return;
  }
  if (m.method === 'resources/list') {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { resources: [
      { uri: 'data://whitespace', mimeType: 'text/plain' },
      { uri: 'data://multi', mimeType: 'text/plain' },
    ] } });
    return;
  }
  if (m.method === 'tools/call') {
    const content = m.params.name === 'multi_tool'
      ? [{ type: 'text', text: 'first tool body' }, { type: 'text', text: 'second tool body' }]
      : [{ type: 'text', text: '  tool line\\n    nested\\n' }];
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { content } });
    return;
  }
  if (m.method === 'resources/read') {
    const contents = m.params.uri === 'data://multi'
      ? [{ type: 'text', text: 'first resource body' }, { type: 'text', text: 'second resource body' }]
      : [{ type: 'text', text: '\\n  yaml:\\n    nested: true\\n' }];
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { contents } });
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

async function createRuntime(
  dir: string,
  scriptPath: string,
  startupTimeoutMs = 1_000,
  requestTimeoutMs = 1_000,
  reverse?: McpReverseCapabilities,
): Promise<McpServerRuntime> {
  return new McpServerRuntime(
    'test-server',
    {
      type: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      connect: 'lazy',
      startupTimeoutMs,
      requestTimeoutMs,
    },
    path.join(dir, 'cache'),
    reverse,
  );
}

async function startHttpServer(
  handler: http.RequestListener,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = http.createServer(handler);
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return {
    url,
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

describe('McpServerRuntime protocol compatibility', () => {
  it('connects to standard stdio NDJSON servers on the first attempt', async () => {
    const dir = await createTempDir();
    const startsPath = path.join(dir, 'starts.txt');
    const protocolPath = path.join(dir, 'protocol.txt');
    const scriptPath = await writeScript(dir, createNdjsonServerSource({
      startsPath,
      protocolPath,
    }));
    const runtime = await createRuntime(dir, scriptPath);

    try {
      await runtime.refreshCatalog(true);
    } finally {
      await runtime.dispose();
    }

    const starts = await readFile(startsPath, 'utf8');
    const requestedVersion = await readFile(protocolPath, 'utf8');
    expect(starts.trim().split('\n')).toHaveLength(1);
    expect(requestedVersion).toBe('2025-11-25');
    expect(runtime.getDiagnostics().tools).toBe(1);
  });

  it('keeps Content-Length as a fallback for legacy stdio servers', async () => {
    const dir = await createTempDir();
    const startsPath = path.join(dir, 'starts.txt');
    const scriptPath = await writeScript(dir, createContentLengthServerSource(startsPath));
    const runtime = await createRuntime(dir, scriptPath);

    try {
      await runtime.refreshCatalog(true);
    } finally {
      await runtime.dispose();
    }

    const starts = await readFile(startsPath, 'utf8');
    expect(starts.trim().split('\n')).toHaveLength(2);
    expect(runtime.getDiagnostics().tools).toBe(1);
  });

  it('does not restart a disposed initializer using another framing', async () => {
    const dir = await createTempDir();
    const startsPath = path.join(dir, 'starts.txt');
    const enteredPath = path.join(dir, 'entered.txt');
    const scriptPath = await writeScript(dir, createNdjsonServerSource({ startsPath }).replace(
      "if (method === 'initialize') {",
      `if (method === 'initialize') { fs.writeFileSync(${JSON.stringify(enteredPath)}, 'entered'); return;`,
    ));
    const runtime = new McpServerRuntime('disposed', {
      type: 'stdio', command: process.execPath, args: [scriptPath], startupTimeoutMs: 10_000,
    }, path.join(dir, 'cache'));
    const reading = runtime.getCatalog(true).then(() => 'completed', error => String(error));
    try {
      await vi.waitFor(async () => expect(await readFile(enteredPath, 'utf8')).toBe('entered'), { timeout: 5_000 });
      await runtime.dispose();
      expect.soft(await reading).toContain('disposed during request');
      expect((await readFile(startsPath, 'utf8')).trim().split('\n')).toEqual(['start']);
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects unsupported server protocol versions instead of trying another framing', async () => {
    const dir = await createTempDir();
    const startsPath = path.join(dir, 'starts.txt');
    const scriptPath = await writeScript(dir, createNdjsonServerSource({
      startsPath,
      responseProtocolVersion: '2099-01-01',
    }));
    const runtime = await createRuntime(dir, scriptPath);

    await expect(runtime.refreshCatalog(true)).rejects.toThrow(/Unsupported MCP protocol version/);
    await runtime.dispose();

    const starts = await readFile(startsPath, 'utf8');
    expect(starts.trim().split('\n')).toHaveLength(1);
  });

  it('sends the negotiated protocol version on streamable HTTP follow-up requests', async () => {
    const dir = await createTempDir();
    const observedProtocolHeaders: string[] = [];
    let initializeProtocolVersion = '';
    const sessionId = 'session-one';
    const server = await startHttpServer(async (req, res) => {
      if (req.method === 'GET') {
        observedProtocolHeaders.push(getHeaderValue(req.headers['mcp-protocol-version']));
        res.writeHead(405);
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      const payload = asRecord(JSON.parse(await readRequestBody(req)));
      const method = typeof payload?.method === 'string' ? payload.method : '';

      if (method === 'initialize') {
        const params = asRecord(payload?.params);
        initializeProtocolVersion = typeof params?.protocolVersion === 'string'
          ? params.protocolVersion
          : '';
        writeJsonRpcResponse(
          res,
          payload?.id,
          {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'http-test', version: '1.0.0' },
          },
          { 'MCP-Session-Id': sessionId },
        );
        return;
      }

      observedProtocolHeaders.push(getHeaderValue(req.headers['mcp-protocol-version']));
      if (getHeaderValue(req.headers['mcp-session-id']) !== sessionId) {
        res.writeHead(400);
        res.end();
        return;
      }
      if (observedProtocolHeaders.at(-1) !== '2025-11-25') {
        res.writeHead(400);
        res.end();
        return;
      }

      if (payload?.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }

      const key = method === 'tools/list'
        ? 'tools'
        : method === 'resources/list'
          ? 'resources'
          : 'prompts';
      writeJsonRpcResponse(res, payload.id, { [key]: [] });
    });

    const runtime = new McpServerRuntime(
      'http-test',
      {
        type: 'streamable-http',
        url: server.url,
        connect: 'lazy',
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      path.join(dir, 'cache'),
    );

    try {
      await runtime.refreshCatalog(true);
    } finally {
      await runtime.dispose();
      await server.stop();
    }

    expect(initializeProtocolVersion).toBe('2025-11-25');
    expect(observedProtocolHeaders.length).toBeGreaterThan(0);
    expect(observedProtocolHeaders.every((header) => header === '2025-11-25')).toBe(true);
  });

  it('auto-detects type:http as Streamable HTTP when POST initialize succeeds', async () => {
    const dir = await createTempDir();
    let initializeProtocolVersion = '';
    const server = await startHttpServer(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      const payload = asRecord(JSON.parse(await readRequestBody(req)));
      const method = typeof payload?.method === 'string' ? payload.method : '';
      if (method === 'initialize') {
        const params = asRecord(payload?.params);
        initializeProtocolVersion = typeof params?.protocolVersion === 'string'
          ? params.protocolVersion
          : '';
        writeJsonRpcResponse(res, payload?.id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'http-auto-streamable-test', version: '1.0.0' },
        });
        return;
      }
      if (payload?.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const key = method === 'tools/list'
        ? 'tools'
        : method === 'resources/list'
          ? 'resources'
          : 'prompts';
      writeJsonRpcResponse(res, payload.id, { [key]: [] });
    });

    const runtime = new McpServerRuntime(
      'http-auto-streamable-test',
      {
        type: 'http',
        url: server.url,
        connect: 'lazy',
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      path.join(dir, 'cache'),
    );

    try {
      await runtime.refreshCatalog(true);
      expect(initializeProtocolVersion).toBe('2025-11-25');
      expect(runtime.getDiagnostics().resolvedTransport).toBe('http:auto->streamable-http');
    } finally {
      await runtime.dispose();
      await server.stop();
    }
  });

  it('auto-detects type:http as legacy SSE when POST initialize returns 405', async () => {
    const dir = await createTempDir();
    let rootPostCount = 0;
    let endpointPostCount = 0;
    let getCount = 0;
    let sseResponse: http.ServerResponse | undefined;
    const server = await startHttpServer(async (req, res) => {
      if (req.method === 'GET' && req.headers.accept?.includes('text/event-stream')) {
        getCount += 1;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        sseResponse = res;
        res.write('event: endpoint\n');
        res.write('data: /message?sessionId=legacy\n\n');
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/message')) {
        endpointPostCount += 1;
        const payload = asRecord(JSON.parse(await readRequestBody(req)));
        const method = typeof payload?.method === 'string' ? payload.method : '';
        if (payload?.id !== undefined) {
          const result = method === 'initialize'
            ? {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {}, resources: {}, prompts: {} },
              serverInfo: { name: 'http-auto-sse-test', version: '1.0.0' },
            }
            : {
              [method === 'tools/list'
                ? 'tools'
                : method === 'resources/list'
                  ? 'resources'
                  : 'prompts']: [],
            };
          sseResponse?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result })}\n\n`);
        }
        res.writeHead(202);
        res.end();
        return;
      }
      if (req.method === 'POST') {
        rootPostCount += 1;
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const runtime = new McpServerRuntime(
      'http-auto-sse-test',
      {
        type: 'http',
        url: server.url,
        connect: 'lazy',
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      path.join(dir, 'cache'),
    );

    try {
      await runtime.refreshCatalog(true);
      expect(rootPostCount).toBe(1);
      expect(getCount).toBe(1);
      expect(endpointPostCount).toBeGreaterThan(0);
      expect(runtime.getDiagnostics().resolvedTransport).toBe('http:auto->sse');

      await runtime.refreshCatalog(true);
      expect(rootPostCount).toBe(1);
      expect(getCount).toBe(2);
      expect(runtime.getDiagnostics().resolvedTransport).toBe('http:auto->sse');
    } finally {
      await runtime.dispose();
      sseResponse?.end();
      await server.stop();
    }
  });

  it('does not fall back from type:http to SSE on authentication failures', async () => {
    const dir = await createTempDir();
    let postCount = 0;
    let getCount = 0;
    const server = await startHttpServer(async (req, res) => {
      if (req.method === 'GET') {
        getCount += 1;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end();
        return;
      }
      if (req.method === 'POST') {
        postCount += 1;
        await readRequestBody(req);
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer resource_metadata="https://auth.example.test/.well-known/oauth-protected-resource"' });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const runtime = new McpServerRuntime(
      'http-auto-auth-test',
      {
        type: 'http',
        url: server.url,
        connect: 'lazy',
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      path.join(dir, 'cache'),
    );

    try {
      await expect(runtime.refreshCatalog(true)).rejects.toThrow(/requires authorization/);
      expect(postCount).toBe(1);
      expect(getCount).toBe(0);
    } finally {
      await runtime.dispose();
      await server.stop();
    }
  });

  it('reports both Streamable HTTP and SSE errors when type:http auto-detect fully fails', async () => {
    const dir = await createTempDir();
    const server = await startHttpServer(async (_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const runtime = new McpServerRuntime(
      'http-auto-mismatch-test',
      {
        type: 'http',
        url: server.url,
        connect: 'lazy',
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      path.join(dir, 'cache'),
    );

    try {
      await expect(runtime.refreshCatalog(true)).rejects.toThrow(
        /Streamable HTTP attempt: HTTP POST failed: 404.*legacy SSE fallback: SSE connection failed: 404/s,
      );
    } finally {
      await runtime.dispose();
      await server.stop();
    }
  });

  it('uses the negotiated older protocol version in streamable HTTP follow-up headers', async () => {
    const dir = await createTempDir();
    const observedProtocolHeaders: string[] = [];
    let initializeCapabilities: JsonObject | undefined;
    const sessionId = 'session-legacy-version';
    const server = await startHttpServer(async (req, res) => {
      if (req.method === 'GET') {
        observedProtocolHeaders.push(getHeaderValue(req.headers['mcp-protocol-version']));
        res.writeHead(405);
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      const payload = asRecord(JSON.parse(await readRequestBody(req)));
      const method = typeof payload?.method === 'string' ? payload.method : '';

      if (method === 'initialize') {
        const params = asRecord(payload?.params);
        initializeCapabilities = asRecord(params?.capabilities);
        writeJsonRpcResponse(
          res,
          payload?.id,
          {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'http-legacy-version-test', version: '1.0.0' },
          },
          { 'MCP-Session-Id': sessionId },
        );
        return;
      }

      observedProtocolHeaders.push(getHeaderValue(req.headers['mcp-protocol-version']));
      if (getHeaderValue(req.headers['mcp-session-id']) !== sessionId) {
        res.writeHead(400);
        res.end();
        return;
      }
      if (observedProtocolHeaders.at(-1) !== '2025-06-18') {
        res.writeHead(400);
        res.end();
        return;
      }

      if (payload?.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }

      const key = method === 'tools/list'
        ? 'tools'
        : method === 'resources/list'
          ? 'resources'
          : 'prompts';
      writeJsonRpcResponse(res, payload.id, { [key]: [] });
    });

    const runtime = new McpServerRuntime(
      'http-legacy-version-test',
      {
        type: 'streamable-http',
        url: server.url,
        connect: 'lazy',
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      path.join(dir, 'cache'),
    );

    try {
      await runtime.refreshCatalog(true);
    } finally {
      await runtime.dispose();
      await server.stop();
    }

    expect(initializeCapabilities).toEqual({});
    expect(observedProtocolHeaders.length).toBeGreaterThan(0);
    expect(observedProtocolHeaders.every((header) => header === '2025-06-18')).toBe(true);
  });

  it('reinitializes streamable HTTP when a session expires during a request', async () => {
    const dir = await createTempDir();
    let initializeCount = 0;
    let activeSessionId = '';
    let expiredOnce = false;
    const server = await startHttpServer(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      const payload = asRecord(JSON.parse(await readRequestBody(req)));
      const method = typeof payload?.method === 'string' ? payload.method : '';

      if (method === 'initialize') {
        initializeCount += 1;
        activeSessionId = `session-${initializeCount}`;
        writeJsonRpcResponse(
          res,
          payload?.id,
          {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'http-expire-test', version: '1.0.0' },
          },
          { 'MCP-Session-Id': activeSessionId },
        );
        return;
      }

      if (
        getHeaderValue(req.headers['mcp-session-id']) !== activeSessionId
        || getHeaderValue(req.headers['mcp-protocol-version']) !== '2025-11-25'
      ) {
        res.writeHead(400);
        res.end();
        return;
      }

      if (method === 'tools/list' && !expiredOnce) {
        expiredOnce = true;
        res.writeHead(404);
        res.end();
        return;
      }

      if (payload?.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }

      const key = method === 'tools/list'
        ? 'tools'
        : method === 'resources/list'
          ? 'resources'
          : 'prompts';
      writeJsonRpcResponse(res, payload.id, { [key]: [] });
    });

    const runtime = new McpServerRuntime(
      'http-expire-test',
      {
        type: 'streamable-http',
        url: server.url,
        connect: 'lazy',
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      path.join(dir, 'cache'),
    );

    try {
      await runtime.refreshCatalog(true);
    } finally {
      await runtime.dispose();
      await server.stop();
    }

    expect(initializeCount).toBe(2);
    expect(expiredOnce).toBe(true);
  });

  it('answers server pings, surfaces sanitized icons + taskSupport, and cancels on timeout', async () => {
    const dir = await createTempDir();
    const pongPath = path.join(dir, 'pong.txt');
    const numberPongPath = path.join(dir, 'pong-number.txt');
    const cancelPath = path.join(dir, 'cancel.txt');
    const scriptPath = await writeScript(dir, createCapabilityServerSource({
      pongPath,
      numberPongPath,
      cancelPath,
    }));
    const runtime = await createRuntime(dir, scriptPath);

    try {
      const catalog = await runtime.getCatalog(true);

      const safe = catalog.descriptors.find((descriptor) => descriptor.name === 'safe_tool');
      // The javascript: icon is dropped; only the https one survives.
      expect(safe?.icons).toEqual([{ src: 'https://example.com/i.png' }]);
      expect(safe?.taskSupport).toBe('optional');
      expect(
        catalog.descriptors.find((descriptor) => descriptor.name === 'task_only')?.taskSupport,
      ).toBe('required');

      // The client must answer the server's ping with an empty result.
      await expect
        .poll(() => readFile(pongPath, 'utf8').catch(() => ''))
        .toBe('pong');
      await expect
        .poll(() => readFile(numberPongPath, 'utf8').catch(() => ''))
        .toBe('pong-number');

      // A task-required tool fails fast with a clear error (no tools/call sent).
      await expect(runtime.callTool('task_only', {})).rejects.toThrow(/only runs as a task/);

      // A normal call times out; the client emits notifications/cancelled.
      await expect(runtime.callTool('safe_tool', {})).rejects.toThrow(/timed out/);
      await expect
        .poll(() => readFile(cancelPath, 'utf8').catch(() => ''))
        .toMatch(/"requestId"/);
    } finally {
      await runtime.dispose();
    }
  });

  it('loads the catalog before direct calls so task-required tools fail fast', async () => {
    const dir = await createTempDir();
    const pongPath = path.join(dir, 'pong.txt');
    const cancelPath = path.join(dir, 'cancel.txt');
    const scriptPath = await writeScript(dir, createCapabilityServerSource({ pongPath, cancelPath }));
    const runtime = await createRuntime(dir, scriptPath, 1_000, 100);

    try {
      await expect(runtime.callTool('task_only', {})).rejects.toThrow(/only runs as a task/);
    } finally {
      await runtime.dispose();
    }
  });

  it('treats unsupported optional resources/prompts lists as empty and still calls tools', async () => {
    const dir = await createTempDir();
    const scriptPath = await writeScript(dir, createOptionalListsUnsupportedServerSource());
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000);

    try {
      await runtime.refreshCatalog(true);
      expect(runtime.getDiagnostics().tools).toBe(1);
      expect(runtime.getDiagnostics().resources).toBe(0);
      expect(runtime.getDiagnostics().prompts).toBe(0);

      const result = await runtime.callTool('echo', {});
      expect(result.content).toBe('called');
      expect(result.metadata).toEqual({
        serverId: 'test-server',
        isError: false,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('loads resources-only servers that do not implement tools/list', async () => {
    const dir = await createTempDir();
    const scriptPath = await writeScript(dir, createResourcesOnlyServerSource());
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000);

    try {
      await runtime.refreshCatalog(true);
      expect(runtime.getDiagnostics().tools).toBe(0);
      expect(runtime.getDiagnostics().resources).toBe(1);
      expect(runtime.getDiagnostics().prompts).toBe(0);

      const result = await runtime.readResource('data://one', {});
      expect(result.content).toBe('resource text');
      expect(result.structuredContent).toBeUndefined();
      expect(result.metadata).toEqual({ serverId: 'test-server' });
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects an incomplete paginated catalog refresh and preserves the last complete snapshot', async () => {
    const dir = await createTempDir();
    const scriptPath = await writeScript(dir, createPartialCatalogFailureServerSource());
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000);

    try {
      await runtime.refreshCatalog(true);
      expect((await runtime.getCachedCatalog())?.descriptors.map((entry) => entry.name))
        .toEqual(['complete_tool']);

      await expect(runtime.refreshCatalog()).rejects.toThrow(/catalog page 2 failed/);
      expect((await runtime.getCachedCatalog())?.descriptors.map((entry) => entry.name))
        .toEqual(['complete_tool']);
      expect(runtime.getDiagnostics()).toEqual(expect.objectContaining({
        dirty: true,
        status: 'error',
        tools: 1,
      }));
    } finally {
      await runtime.dispose();
    }

    const diskReader = await createRuntime(dir, scriptPath, 1_000, 1_000);
    try {
      expect((await diskReader.getCachedCatalog())?.descriptors.map((entry) => entry.name))
        .toEqual(['complete_tool']);
    } finally {
      await diskReader.dispose();
    }
  });

  it('coalesces concurrent model-facing discovery into one catalog refresh', async () => {
    const dir = await createTempDir();
    const runtime = new McpServerRuntime(
      'coalesced',
      { type: 'stdio', command: path.join(dir, 'not-used.exe') },
      dir,
    );
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refresh = vi.spyOn(runtime, 'refreshCatalog').mockImplementation(() => refreshGate);

    const first = runtime.getDiscoveryCatalog();
    const second = runtime.getDiscoveryCatalog();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    releaseRefresh?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ freshness: 'live', complete: true }),
      expect.objectContaining({ freshness: 'live', complete: true }),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed list payloads instead of treating them as a complete empty catalog', async () => {
    const dir = await createTempDir();
    const scriptPath = await writeScript(dir, createCatalogIntegrityServerSource('malformed'));
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000);

    try {
      await expect(runtime.refreshCatalog(true)).rejects.toThrow(/invalid tools\/list response/i);
      expect(runtime.getDiagnostics()).toEqual(expect.objectContaining({
        dirty: true,
        status: 'error',
        tools: 0,
      }));
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects capability entries with no callable identifier instead of inventing one', async () => {
    const dir = await createTempDir();
    const scriptPath = await writeScript(dir, createCatalogIntegrityServerSource('missing-identifier'));
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000);

    try {
      await expect(runtime.refreshCatalog(true)).rejects.toThrow(/tools\/list entry.*name/i);
      expect(runtime.getDiagnostics().tools).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects resource entries with no URI instead of treating a display name as readable', async () => {
    const dir = await createTempDir();
    const scriptPath = await writeScript(dir, createCatalogIntegrityServerSource('missing-resource-uri'));
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000);

    try {
      await expect(runtime.refreshCatalog(true)).rejects.toThrow(/resources\/list entry.*uri/i);
      expect(runtime.getDiagnostics().resources).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects cyclic list cursors before an MCP server can keep discovery paging', async () => {
    const dir = await createTempDir();
    const scriptPath = await writeScript(dir, createCatalogIntegrityServerSource('repeated-cursor'));
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000);

    try {
      await expect(runtime.refreshCatalog(true)).rejects.toThrow(/repeated pagination cursor/i);
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects an explicit null pagination cursor instead of treating it as completion', async () => {
    const dir = await createTempDir();
    const scriptPath = await writeScript(dir, createCatalogIntegrityServerSource('null-cursor'));
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000);

    try {
      await expect(runtime.refreshCatalog(true)).rejects.toThrow(/nextCursor must be a non-empty string/i);
    } finally {
      await runtime.dispose();
    }
  });

  it('does not overwrite a list-changed notification received during paginated discovery', async () => {
    const dir = await createTempDir();
    const scriptPath = await writeScript(
      dir,
      createCatalogIntegrityServerSource('list-changed-during-pagination'),
    );
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000);

    try {
      await runtime.refreshCatalog(true);
      await expect(runtime.refreshCatalog()).rejects.toThrow(/catalog changed during discovery/i);
      expect((await runtime.getCachedCatalog())?.descriptors.map((entry) => entry.name))
        .toEqual(['stable_tool']);
      expect(runtime.getDiagnostics()).toEqual(expect.objectContaining({
        dirty: true,
        status: 'error',
        tools: 1,
      }));
    } finally {
      await runtime.dispose();
    }
  });

  it('deduplicates capabilities repeated across list pages', async () => {
    const dir = await createTempDir();
    const scriptPath = await writeScript(dir, createCatalogIntegrityServerSource('duplicate-entry'));
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000);

    try {
      await runtime.refreshCatalog(true);
      expect((await runtime.getCachedCatalog())?.descriptors.map((entry) => entry.name))
        .toEqual(['one', 'two']);
    } finally {
      await runtime.dispose();
    }
  });

  it('preserves leading indentation and trailing newlines in MCP text content', async () => {
    const dir = await createTempDir();
    const scriptPath = await writeScript(dir, createWhitespaceContentServerSource());
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000);

    try {
      await runtime.refreshCatalog(true);
      await expect(runtime.callTool('whitespace_tool', {})).resolves.toEqual(expect.objectContaining({
        content: '  tool line\n    nested\n',
      }));
      await expect(runtime.readResource('data://whitespace', {})).resolves.toEqual(expect.objectContaining({
        content: '\n  yaml:\n    nested: true\n',
      }));
      await expect(runtime.callTool('multi_tool', {})).resolves.toEqual(expect.objectContaining({
        content: 'first tool body\n\nsecond tool body',
      }));
      await expect(runtime.readResource('data://multi', {})).resolves.toEqual(expect.objectContaining({
        content: 'first resource body\n\nsecond resource body',
      }));
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects unadvertised server-to-client capabilities with method-not-found', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'unsupported.jsonl');
    const scriptPath = await writeScript(dir, createUnsupportedRequestsServerSource(recordPath));
    const runtime = await createRuntime(dir, scriptPath);

    try {
      await runtime.refreshCatalog(true);
      await expect
        .poll(() => readFile(recordPath, 'utf8').catch(() => ''))
        .toContain('elicitation-1');
    } finally {
      await runtime.dispose();
    }

    const responses = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line)));
    expect(responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'roots-1', error: expect.objectContaining({ code: -32601 }) }),
      expect.objectContaining({ id: 'sampling-1', error: expect.objectContaining({ code: -32601 }) }),
      expect.objectContaining({ id: 'elicitation-1', error: expect.objectContaining({ code: -32601 }) }),
    ]));
  });

  it('FEATURE_222 Slice A: advertises roots + serves roots/list from injected workspace roots', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'roots.jsonl');
    const scriptPath = await writeScript(dir, createRootsServerSource(recordPath));
    const reverse: McpReverseCapabilities = {
      listRoots: () => [{ uri: 'file:///workspace/proj', name: 'proj' }],
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      await expect
        .poll(() => readFile(recordPath, 'utf8').catch(() => ''))
        .toContain('roots-1');
    } finally {
      await runtime.dispose();
    }

    const records = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line)));

    // initialize advertised the roots capability
    const initialize = records.find((r) => r?.method === 'initialize');
    const advertised = asRecord(asRecord(initialize?.params)?.capabilities);
    expect(advertised?.roots).toEqual({ listChanged: false });

    // roots/list was answered with the injected file:// root (not -32601)
    const rootsResponse = records.find((r) => r?.id === 'roots-1' && r?.method === undefined);
    expect(asRecord(rootsResponse?.result)?.roots).toEqual([
      { uri: 'file:///workspace/proj', name: 'proj' },
    ]);
  });

  it('FEATURE_222 Slice B: advertises form elicitation + routes elicitation/create to the injected elicit', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'elicit.jsonl');
    const scriptPath = await writeScript(dir, createElicitationServerSource(recordPath));
    const seen: unknown[] = [];
    const reverse: McpReverseCapabilities = {
      elicit: async (request) => {
        seen.push(request);
        return { action: 'accept', content: { username: 'alice' } };
      },
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      await expect
        .poll(() => readFile(recordPath, 'utf8').catch(() => ''))
        .toContain('elicit-1');
    } finally {
      await runtime.dispose();
    }

    const records = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line)));

    // advertised form elicitation (not url)
    const initialize = records.find((r) => r?.method === 'initialize');
    const advertised = asRecord(asRecord(initialize?.params)?.capabilities);
    expect(advertised?.elicitation).toEqual({ form: {} });

    // the request reached the host elicit callback as a parsed form request
    expect(seen).toEqual([{ mode: 'form', serverId: 'test-server', message: 'Your name?', requestedSchema: expect.objectContaining({ type: 'object' }) }]);

    // the client responded accept + content (not -32601)
    const response = records.find((r) => r?.id === 'elicit-1' && r?.method === undefined);
    expect(response?.result).toEqual({ action: 'accept', content: { username: 'alice' } });
  });

  it('FEATURE_222 Slice C: advertises url elicitation, routes url requests, and forwards completion', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'url-elicit.jsonl');
    const scriptPath = await writeScript(dir, createUrlElicitationServerSource(recordPath));
    const seen: unknown[] = [];
    const completed: string[] = [];
    const reverse: McpReverseCapabilities = {
      elicit: async (request) => {
        seen.push(request);
        // host showed the URL + got consent (anti-phishing UI is host-side)
        return { action: 'accept', content: {} };
      },
      elicitationModes: { form: true, url: true },
      onElicitationComplete: (id) => completed.push(id),
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      await expect.poll(() => completed.length > 0).toBe(true);
    } finally {
      await runtime.dispose();
    }

    const records = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line)));

    // advertised both form + url
    const initialize = records.find((r) => r?.method === 'initialize');
    const advertised = asRecord(asRecord(initialize?.params)?.capabilities);
    expect(advertised?.elicitation).toEqual({ form: {}, url: {} });

    // the url request reached the host elicit with mode + url + elicitationId
    expect(seen).toEqual([
      { mode: 'url', serverId: 'test-server', message: 'Authorize', url: 'https://auth.example.test/grant', elicitationId: 'flow-1' },
    ]);

    // the completion notification was forwarded to the host
    expect(completed).toEqual(['flow-1']);
  });

  it('FEATURE_222 Slice C: rejects url elicitation when the host did not opt in', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'url-elicit-disabled.jsonl');
    const scriptPath = await writeScript(dir, createUrlElicitationServerSource(recordPath));
    const seen: unknown[] = [];
    const reverse: McpReverseCapabilities = {
      elicit: async (request) => {
        seen.push(request);
        return { action: 'accept', content: {} };
      },
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      await expect
        .poll(() => readFile(recordPath, 'utf8').catch(() => ''))
        .toContain('url-1');
    } finally {
      await runtime.dispose();
    }

    const records = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line)));

    const initialize = records.find((r) => r?.method === 'initialize');
    const advertised = asRecord(asRecord(initialize?.params)?.capabilities);
    expect(advertised?.elicitation).toEqual({ form: {} });
    expect(seen).toEqual([]);

    const response = records.find((r) => r?.id === 'url-1' && r?.method === undefined);
    expect(response?.error).toEqual(expect.objectContaining({ code: -32601 }));
  });

  it('FEATURE_222 Slice D seam: advertises sampling + routes sampling/createMessage to the injected sampler', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'sampling.jsonl');
    const scriptPath = await writeScript(dir, createSamplingServerSource(recordPath));
    const seen: unknown[] = [];
    const reverse: McpReverseCapabilities = {
      sample: async (request) => {
        seen.push(request);
        return {
          role: 'assistant',
          content: { type: 'text', text: 'sampled' },
          model: 'test-model',
          stopReason: 'endTurn',
        };
      },
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      await expect
        .poll(() => readFile(recordPath, 'utf8').catch(() => ''))
        .toContain('sample-1');
    } finally {
      await runtime.dispose();
    }

    const records = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line)));

    const initialize = records.find((r) => r?.method === 'initialize');
    const advertised = asRecord(asRecord(initialize?.params)?.capabilities);
    expect(advertised?.sampling).toEqual({});

    expect(seen).toEqual([expect.objectContaining({
      serverId: 'test-server',
      systemPrompt: 'Be brief',
      maxTokens: 16,
      messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
      modelPreferences: { hints: [{ name: 'fast' }] },
    })]);

    const response = records.find((r) => r?.id === 'sample-1' && r?.method === undefined);
    expect(response?.result).toEqual({
      role: 'assistant',
      content: { type: 'text', text: 'sampled' },
      model: 'test-model',
      stopReason: 'endTurn',
    });
  });

  it('FEATURE_222 Slice C: -32042 → url consent → retries tools/call and succeeds', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'url-retry.jsonl');
    const scriptPath = await writeScript(dir, createUrlRetryToolServerSource(recordPath));
    const seen: unknown[] = [];
    const reverse: McpReverseCapabilities = {
      elicit: async (request) => {
        seen.push(request);
        return { action: 'accept', content: {} };
      },
      elicitationModes: { form: true, url: true },
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      const result = await runtime.callTool('login_tool', {});
      expect(result.content).toContain('logged in');
    } finally {
      await runtime.dispose();
    }

    // The host saw a url elicitation carrying the server's URL + message.
    expect(seen).toEqual([
      expect.objectContaining({ mode: 'url', url: 'https://auth.example.test/grant', message: 'Authorize' }),
    ]);
    // tools/call was attempted exactly twice (initial -32042, then the retry).
    const callRecords = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line)))
      .filter((r) => r?.kind === 'tools/call');
    expect(callRecords).toHaveLength(2);
  });

  it('FEATURE_222 Slice C: -32042 → user declines → tools/call throws (no retry)', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'url-decline.jsonl');
    const scriptPath = await writeScript(dir, createUrlRetryToolServerSource(recordPath));
    const reverse: McpReverseCapabilities = {
      elicit: async () => ({ action: 'decline' }),
      elicitationModes: { form: true, url: true },
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      await expect(runtime.callTool('login_tool', {})).rejects.toThrow(/authorization required/);
    } finally {
      await runtime.dispose();
    }

    const callRecords = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line)))
      .filter((r) => r?.kind === 'tools/call');
    expect(callRecords).toHaveLength(1);
  });

  it('FEATURE_222 Slice C: -32042 is surfaced unchanged when the host lacks url elicitation', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'url-no-host.jsonl');
    const scriptPath = await writeScript(dir, createUrlRetryToolServerSource(recordPath));
    const seen: unknown[] = [];
    const reverse: McpReverseCapabilities = {
      // form-only host: url elicitation is not advertised, so the closure must
      // not run — the original error propagates.
      elicit: async (request) => {
        seen.push(request);
        return { action: 'accept', content: {} };
      },
      elicitationModes: { form: true },
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      await expect(runtime.callTool('login_tool', {})).rejects.toThrow(/authorization required/);
    } finally {
      await runtime.dispose();
    }

    expect(seen).toEqual([]);
  });

  it('FEATURE_222 Slice C: waits for the completion notification before retrying', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'url-wait.jsonl');
    const scriptPath = await writeScript(dir, createUrlRetryToolServerSource(recordPath, {
      elicitationId: 'flow-7',
      emitCompletion: true,
    }));
    const seen: unknown[] = [];
    const reverse: McpReverseCapabilities = {
      elicit: async (request) => {
        seen.push(request);
        return { action: 'accept', content: {} };
      },
      elicitationModes: { form: true, url: true },
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      const result = await runtime.callTool('login_tool', {});
      expect(result.content).toContain('logged in');
    } finally {
      await runtime.dispose();
    }

    expect(seen).toEqual([
      expect.objectContaining({ mode: 'url', url: 'https://auth.example.test/grant', elicitationId: 'flow-7' }),
    ]);
  });

  it('FEATURE_222 Slice C: consumes completion that arrives before consent returns', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'url-early-complete.jsonl');
    const scriptPath = await writeScript(dir, createUrlRetryToolServerSource(recordPath, {
      elicitationId: 'flow-early',
      emitCompletion: true,
      completionDelayMs: 0,
    }));
    const seen: unknown[] = [];
    const reverse: McpReverseCapabilities = {
      elicit: (request) => new Promise((resolve) => {
        seen.push(request);
        setTimeout(() => resolve({ action: 'accept', content: {} }), 100);
      }),
      elicitationModes: { form: true, url: true },
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      const result = await runtime.callTool('login_tool', {});
      expect(result.content).toContain('logged in');
    } finally {
      await runtime.dispose();
    }

    expect(seen).toEqual([
      expect.objectContaining({ mode: 'url', url: 'https://auth.example.test/grant', elicitationId: 'flow-early' }),
    ]);
  });

  it('FEATURE_222 Slice C: dispose releases a pending url completion wait', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'url-dispose.jsonl');
    const scriptPath = await writeScript(dir, createUrlRetryToolServerSource(recordPath, {
      elicitationId: 'flow-dispose',
    }));
    const seen: unknown[] = [];
    const reverse: McpReverseCapabilities = {
      elicit: async (request) => {
        seen.push(request);
        return { action: 'accept', content: {} };
      },
      elicitationModes: { form: true, url: true },
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    await runtime.refreshCatalog(true);
    const call = runtime.callTool('login_tool', {}).catch((error: unknown) => error);
    await expect.poll(() => seen.length).toBe(1);

    await runtime.dispose();

    const error = await call;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not connected|disposed/i);
  });
});
