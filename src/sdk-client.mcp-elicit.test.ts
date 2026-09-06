import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { parseMcpIntegrationDocument, writeIntegrationDocument } from '@kodax-ai/repl';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

const SERVER_ID = 'shared-elicit';
const TOOL_ID = `mcp:${SERVER_ID}:tool:elicit_tool`;

/** A stdio MCP server whose tool elicits a form before answering. */
const ELICIT_SERVER_SOURCE = `let nextServerId = 100;
const pendingElicit = new Map();
const writeMessage = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');
function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    writeMessage({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {}, elicitation: {} },
      serverInfo: { name: 'kodax-elicit-server', version: '1.0.0' },
    } });
    return;
  }
  if (method === 'tools/list') {
    writeMessage({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'elicit_tool',
      description: 'Elicits a form, then echoes the outcome.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    }] } });
    return;
  }
  if (method === 'tools/call') {
    const elicId = nextServerId++;
    pendingElicit.set(elicId, id);
    writeMessage({ jsonrpc: '2.0', id: elicId, method: 'elicitation/create', params: {
      message: 'Share the draft with the Host?',
      mode: 'form',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    } });
    return;
  }
}
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method) { handleRequest(message); continue; }
    const pending = pendingElicit.get(message.id);
    if (pending !== undefined) {
      pendingElicit.delete(message.id);
      const result = message.result || {};
      const action = result.action || 'missing';
      const name = (result.content && result.content.name) || '';
      writeMessage({ jsonrpc: '2.0', id: pending, result: { content: [{
        type: 'text', text: 'elicit:' + action + ':' + name,
      }] } });
    }
  }
});
`;

class ElicitProvider extends KodaXBaseProvider {
  readonly name = 'product-mcp-elicit-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_MCP_ELICIT_TEST_KEY', model: 'mcp-elicit-test', supportsThinking: false,
  };
  constructor(private readonly results: string[]) { super(); }
  async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
    const last = args[0].at(-1);
    if (last?.role === 'user' && last.content === 'Elicit from the shared server.') {
      return {
        textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
        toolBlocks: [{ type: 'tool_use', id: randomUUID(), name: 'mcp_call', input: { id: TOOL_ID, args: { text: 'please' } } }],
      };
    }
    if (last?.role === 'user' && Array.isArray(last.content)) {
      for (const block of last.content) {
        if (block.type === 'tool_result') this.results.push(JSON.stringify(block.content));
      }
    }
    return { textBlocks: [{ type: 'text', text: 'Elicitation round finished.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

it('attributes a shared MCP server elicitation to the Session whose Run is executing', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-mcp-elicit-'));
  const scriptPath = path.join(homeDir, 'elicit-server.cjs');
  await writeFile(scriptPath, ELICIT_SERVER_SOURCE, 'utf8');
  const results: string[] = [];
  registerModelProvider('product-mcp-elicit-test', () => new ElicitProvider(results));
  vi.stubEnv('KODAX_PRODUCT_MCP_ELICIT_TEST_KEY', 'test-only');
  writeIntegrationDocument({
    domain: 'mcp', configHome: path.join(homeDir, '.kodax'),
    document: {
      version: 1,
      servers: { [SERVER_ID]: { type: 'stdio', command: process.execPath, args: [scriptPath], connect: 'prewarm' } },
    },
    validate: parseMcpIntegrationDocument,
  });
  const runtime = await createKodaXRuntime({ homeDir, profile: 'mcp-elicit', sharedDaemonHost: true });
  try {
    const paths = resolveRuntimeDaemonPaths(homeDir, 'mcp-elicit');
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Could not acquire the elicitation Host.');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-mcp-elicit-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    const first = await connectKodaXClient({ homeDir, profile: 'mcp-elicit', endpoint: endpoint.path });
    const second = await connectKodaXClient({ homeDir, profile: 'mcp-elicit', endpoint: endpoint.path });
    try {
      const active = await first.sessions.create({ projectPath: homeDir });
      await first.sessions.updateSettings(active.id, {
        provider: 'product-mcp-elicit-test', permissionMode: 'full-access', agentMode: 'sa',
      });
      const idle = await first.sessions.create({ projectPath: homeDir });
      const activeViews: ClientSessionView[] = [];
      const idleViews: ClientSessionView[] = [];
      const activeObservation = await second.sessions.observe(active.id, (view) => activeViews.push(view));
      const idleObservation = await second.sessions.observe(idle.id, (view) => idleViews.push(view));
      try {
        const run = await first.inputs.submit({
          sessionId: active.id, inputId: 'elicit-round', text: 'Elicit from the shared server.',
        });
        if (!run.runId) throw new Error('Expected an immediate Run.');

        // The shared server's elicitation surfaces inside the ACTIVE Session
        // with the asking server identified — never in the idle Session.
        await expect.poll(() => activeViews.flatMap((view) => view.interactions)
          .some((item) => item.kind === 'question_input'), { timeout: 20_000 }).toBe(true);
        const inputView = activeViews.flatMap((view) => view.interactions)
          .find((item) => item.kind === 'question_input')!;
        expect(inputView.sessionId).toBe(active.id);
        expect(inputView.options.question).toContain(SERVER_ID);
        expect(idleViews.flatMap((view) => view.interactions)).toEqual([]);

        await first.interactions.respond(inputView.requestId, {
          kind: 'question_input', text: 'kodax-shared-answer',
        });

        await expect.poll(() => activeViews.flatMap((view) => view.interactions)
          .some((item) => item.kind === 'question'), { timeout: 20_000 }).toBe(true);
        const confirm = activeViews.flatMap((view) => view.interactions)
          .find((item) => item.kind === 'question')!;
        expect(confirm.sessionId).toBe(active.id);
        await second.interactions.respond(confirm.requestId, { kind: 'question', answer: 'send' });

        await runtime.runs.await(run.runId);
        expect(results.join('\n')).toContain('elicit:accept:kodax-shared-answer');
        await expect.poll(() => activeViews.at(-1)!.interactions.length, { timeout: 20_000 }).toBe(0);
      } finally {
        activeObservation.close();
        idleObservation.close();
      }
    } finally {
      await Promise.all([first.disconnect(), second.disconnect()]);
      await host.close();
    }
  } finally {
    await runtime.close();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}, 120_000);
