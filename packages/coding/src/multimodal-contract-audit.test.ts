// Regressions for the contract gaps recorded in docs/multimodal-contract-audit.md.
// Real Worker/MCP transports and image bytes; no model requests.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';
import type Anthropic from '@anthropic-ai/sdk';
import { KodaXAnthropicCompatProvider } from '@kodax-ai/llm';
import { createAgent, microcompact, McpServerRuntime } from '@kodax-ai/agent';
import { loadHandler, shutdownConstructedHandlerWorkersForTest } from './construction/load-handler.js';
import { executeTool, getToolDefinition, toolRead, type ToolResult } from './tools/index.js';
import { wrapCodingToolAsRunnable } from './task-engine/_internal/managed-task/tool-wrappers.js';
import { recoverContextHistory } from './history-capacity-recovery.js';
import { toolMcpCall } from './tools/mcp-call.js';
import { executeRunScopedTool } from './agent-runtime/run-scoped-tools.js';
import { isToolResultErrorContent } from './agent-runtime/tool-result-classify.js';
import type { KodaXToolExecutionContext } from './types.js';
import { TOOL_OUTPUT_DIR_ENV } from './tools/truncate.js';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-contract-audit-'));
  vi.stubEnv(TOOL_OUTPUT_DIR_ENV, directory);
  vi.stubEnv('KODAX_HOME', directory);
});
afterEach(async () => {
  await shutdownConstructedHandlerWorkersForTest();
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});
const image = { type: 'image', path: '/image.png' } as const;
class ImageDeliveryProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'anthropic';
  protected readonly config = { apiKeyEnv: 'AUDIT_UNUSED_KEY', model: 'test', supportsThinking: false };
  constructor(client: unknown) { super(); this.client = client as Anthropic; }
  protected override getApiKey(): string { return 'offline-test'; }
}
function pair(content: ToolResult): KodaXMessage[] {
  return [{ role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'read', input: { path: image.path } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content }] }];
}

it('AUDIT: constructed Worker preserves a real PNG result returned by ctx.tools.read', async () => {
  const imagePath = path.join(directory, 'pixel.png');
  await fs.writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64'));
  const ctx = { backups: new Map(), executionCwd: directory };
  const expected = await executeTool('read', { path: imagePath }, ctx);
  const handler = await loadHandler({ name: 'image-wrapper', version: '1.0.0', cwd: directory }, {
    kind: 'script', language: 'javascript',
    code: 'export async function handler(input, ctx) { return await ctx.tools.read(input); }',
  }, { tools: ['read'] });
  expect(await handler({ path: imagePath }, ctx)).toEqual(expected);
});

it('AUDIT: Worker error RPC preserves a Node error code', async () => {
  const handler = await loadHandler({ name: 'failure', version: '1.0.0', cwd: directory }, {
    kind: 'script', language: 'javascript',
    code: "export async function handler() { throw Object.assign(new TypeError('bad input'), { code: 'ERR_INVALID_ARG_TYPE' }); }",
  }, { tools: [] });
  await expect(handler({}, { backups: new Map() })).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' });
});

it('AUDIT: microcompaction preserves nested image blocks as it preserves top-level images', () => {
  const history = pair([{ type: 'text', text: 'Image read.' }, image]);
  history.push({ role: 'assistant', content: 'inspected' }, { role: 'user', content: 'continue' });
  const result = microcompact(history, { enabled: true, maxAge: 1, protectedTools: [] });
  const block = result[1]?.content;
  expect(Array.isArray(block) && block[0]?.type === 'tool_result' && block[0].content).toEqual(
    expect.arrayContaining([image]));
});

it('AUDIT: capacity recovery treats text and equivalent text/image arrays consistently', async () => {
  const body = 'large evidence '.repeat(12000);
  const capacity = { currentTokens: 125541, contextWindow: 131072, reservedResponseTokens: 3000 };
  const baseline = await recoverContextHistory({ ...capacity, messages: pair(body) });
  expect(baseline.changed).toBe(true);
  const result = await recoverContextHistory({ ...capacity,
    messages: pair([{ type: 'text', text: body }, image]) });
  expect(result.changed).toBe(true);
});

it.each(['mcp_call', 'run-scoped'])('AUDIT: %s propagates upstream MCP isError', async (route) => {
  const ctx = { backups: new Map(), executionCwd: directory,
    extensionRuntime: { executeCapability: async () => ({ kind: 'tool',
      content: [{ type: 'text', text: 'Operation denied by server.' }], metadata: { isError: true } }) },
  } as unknown as KodaXToolExecutionContext;
  const result = route === 'mcp_call' ? await toolMcpCall({ id: 'mcp:test:tool:read' }, ctx)
    : await executeRunScopedTool(ctx, { name: 'host_read', description: 'test',
      inputSchema: { type: 'object', properties: {} }, capabilityId: 'mcp:test:tool:read',
      sideEffect: 'readonly', planModeAllowed: true }, {});
  expect(isToolResultErrorContent(result)).toBe(true);
});

it('AUDIT: managed direct read marks a returned error envelope as isError', async () => {
  const tool = wrapCodingToolAsRunnable(getToolDefinition('read')!, toolRead,
    { backups: new Map(), executionCwd: directory });
  const result = await tool.execute({ path: path.join(directory, 'does-not-exist.png') },
    { agent: createAgent({ name: 'audit', instructions: '' }) });
  expect(result.content).toContain('[Tool Error]');
  expect(result.isError).toBe(true);
});

it('AUDIT: MCP transport retains native image blocks rather than JSON text', async () => {
  const serverPath = path.join(directory, 'image-server.cjs');
  await fs.writeFile(serverPath, `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result = {};
      if (message.method === 'initialize') result = { protocolVersion: '2025-11-25',
        capabilities: { tools: {} }, serverInfo: { name: 'audit', version: '1' } };
      if (message.method === 'tools/list') result = { tools: [{ name: 'image', inputSchema: { type: 'object' } }] };
      if (message.method === 'tools/call') result = { content: [
        { type: 'text', text: 'Image follows' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=' } ] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    });
  `);
  const runtime = new McpServerRuntime('audit', { type: 'stdio', command: process.execPath,
    args: [serverPath], startupTimeoutMs: 2000, requestTimeoutMs: 2000 }, path.join(directory, 'cache'));
  try {
    const result = await runtime.callTool('image', {});
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
    if (typeof result.content === 'string') throw new Error('Expected native image content.');
    const imageBlock = result.content?.find((item) => item.type === 'image');
    expect(imageBlock?.path).toContain(path.join(directory, 'media', 'mcp'));
    expect(await fs.readFile(imageBlock!.path)).toEqual(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64'));
    await runtime.dispose();
    const restarted = new McpServerRuntime('audit', { type: 'stdio', command: process.execPath,
      args: [serverPath], startupTimeoutMs: 2000, requestTimeoutMs: 2000 }, path.join(directory, 'cache'));
    try {
      expect((await restarted.callTool('image', {})).content).toEqual(result.content);
      expect((await fs.readFile(imageBlock!.path)).length).toBe(68);
      const ctx = { backups: new Map(), executionCwd: directory,
        extensionRuntime: { executeCapability: async () => ({ kind: 'tool', ...result }) },
      } as unknown as KodaXToolExecutionContext;
      const content = await toolMcpCall({ id: 'mcp:audit:tool:image' }, ctx);
      const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'seen' }],
        usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' });
      await new ImageDeliveryProvider({ messages: { create } }).complete(pair(content), [], 'Inspect');
      const wire = create.mock.calls[0]?.[0].messages;
      expect(JSON.stringify(wire)).toContain('"type":"base64"');
      expect(JSON.stringify(wire)).toContain('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
      expect(JSON.stringify(wire)).not.toContain(imageBlock!.path);
    } finally { await restarted.dispose(); }
  } finally { await runtime.dispose(); }
});
