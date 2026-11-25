import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { createMcpTestServerFixture } from '@kodax-ai/agent';
import { parseMcpIntegrationDocument, writeIntegrationDocument } from '@kodax-ai/repl';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import type { ClientInteraction, ClientSessionView } from '@kodax-ai/coding/client-contract';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from "../tests/runtime-fixture.js";
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

class McpTestProvider extends KodaXBaseProvider {
  readonly name = 'product-mcp-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_MCP_TEST_KEY', model: 'mcp-test', supportsThinking: false,
  };
  constructor(private readonly toolId: string, private readonly results: string[]) { super(); }
  async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
    const last = args[0].at(-1);
    const echoText = typeof last?.content === 'string' ? /^Echo: (.+)$/.exec(last.content)?.[1] : undefined;
    if (last?.role === 'user' && echoText !== undefined) {
      return {
        textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
        toolBlocks: [{ type: 'tool_use', id: randomUUID(), name: 'mcp_call', input: { id: this.toolId, args: { text: echoText } } }],
      };
    }
    if (last?.role === 'user' && (last.content === 'Call the echo MCP tool.' || last.content === 'Call the private MCP tool.')) {
      const toolId = last.content === 'Call the private MCP tool.' ? this.toolId.replace(':demo:', ':private:') : this.toolId;
      return {
        textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
        toolBlocks: [{ type: 'tool_use', id: randomUUID(), name: 'mcp_call', input: { id: toolId, args: { text: 'live Host' } } }],
      };
    }
    if (last?.role === 'user' && Array.isArray(last.content)) {
      for (const block of last.content) {
        if (block.type === 'tool_result') this.results.push(JSON.stringify(block.content));
      }
    }
    return { textBlocks: [{ type: 'text', text: 'MCP request finished.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

let homeDir: string;
let fixture: Awaited<ReturnType<typeof createMcpTestServerFixture>>;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>> | undefined;
let client: Awaited<ReturnType<typeof connectKodaXClient>> | undefined;
let unregisterProvider: (() => void) | undefined;
let results: string[];

beforeEach(async () => {
  runtime = undefined;
  host = undefined;
  client = undefined;
  unregisterProvider = undefined;
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-mcp-'));
  fixture = await createMcpTestServerFixture(homeDir);
  const currentResults: string[] = [];
  const toolId = fixture.toolId;
  results = currentResults;
  unregisterProvider = registerModelProvider('product-mcp-test', () => new McpTestProvider(toolId, currentResults));
  vi.stubEnv('KODAX_PRODUCT_MCP_TEST_KEY', 'test-only');
  writeIntegrationDocument({
    domain: 'mcp', configHome: path.join(homeDir, '.kodax'),
    document: { version: 1, servers: fixture.servers }, validate: parseMcpIntegrationDocument,
  });
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated MCP Host.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-mcp-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
});

afterEach(async () => {
  try {
    await client?.disconnect();
  } finally {
    try {
      await host?.close();
    } finally {
      try {
        await runtime?.close();
      } finally {
        await awaitLatestCodingMemoryReviewDrain(5_000);
        unregisterProvider?.();
        vi.unstubAllEnvs();
        await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  }
});

it('reloads the actual Host MCP provider used by subsequent model tool calls', async () => {
  const session = await client!.sessions.create({ projectPath: homeDir });
  await client!.sessions.updateSettings(session.id, { provider: 'product-mcp-test', permissionMode: 'full-access' });
  const initial = await client!.inputs.submit({ sessionId: session.id, inputId: 'cold-start', text: 'Call the echo MCP tool.' });
  if (!initial.runId) throw new Error('Expected an immediate Run.');
  await runtime!.runs.await(initial.runId);
  expect(results.join('\n')).toContain('echo:live Host');
  expect(await client!.mcp.listTools({ server: fixture.serverId }))
    .toMatchObject([{ serverId: fixture.serverId, tools: [{ id: fixture.toolId, name: 'echo_tool' }] }]);
  results.length = 0;
  writeIntegrationDocument({
    domain: 'mcp', configHome: path.join(homeDir, '.kodax'),
    document: { version: 1, servers: { retained: { command: 'unused-disabled-server', connect: 'disabled' } } },
    validate: parseMcpIntegrationDocument,
  });
  expect(await client!.mcp.listServers()).toHaveProperty('retained');
  await client!.mcp.upsertServer(fixture.serverId, fixture.servers[fixture.serverId]!);
  await client!.mcp.reloadServers();
  const accepted = await client!.inputs.submit({ sessionId: session.id, inputId: 'mcp-input', text: 'Call the echo MCP tool.' });
  if (!accepted.runId) throw new Error('Expected an immediate Run.');
  await runtime!.runs.await(accepted.runId);
  expect(results.join('\n')).toContain('echo:live Host');
  expect(Object.keys(await client!.mcp.listServers())).toEqual(['retained', fixture.serverId]);
});

it('keeps the second session MCP provider usable after deleting the first private session', async () => {
  const privateConfig = { private: fixture.servers[fixture.serverId]! };
  const firstPrivate = await client!.sessions.create({ projectPath: homeDir, mcpServers: privateConfig });
  const secondPrivate = await client!.sessions.create({ projectPath: homeDir, mcpServers: privateConfig });
  for (const privateSession of [firstPrivate, secondPrivate]) {
    await client!.sessions.updateSettings(privateSession.id, { provider: 'product-mcp-test', permissionMode: 'full-access' });
  }
  const invokePrivate = async (sessionId: string, inputId: string) => {
    results.length = 0;
    const run = await client!.inputs.submit({ sessionId, inputId, text: 'Call the private MCP tool.' });
    if (!run.runId) throw new Error('Expected an immediate Run.');
    await runtime!.runs.await(run.runId);
    expect(results.join('\n')).toContain('echo:live Host');
  };
  await invokePrivate(firstPrivate.id, 'first-private');
  await client!.sessions.delete(firstPrivate.id);
  await invokePrivate(secondPrivate.id, 'second-private');
  expect(Object.keys(await client!.mcp.listServers())).toEqual([fixture.serverId]);
});

function pendingPermission(views: readonly ClientSessionView[]): ClientInteraction | undefined {
  return views.at(-1)?.interactions.find((item) => item.kind === 'permission');
}

async function echoInMode(
  mode: 'plan' | 'accept-edits',
  text: string,
  options: { readOnly?: boolean; sessionId?: string; onPermission?: (permission: ClientInteraction) => Promise<void> } = {},
): Promise<{ sessionId: string; prompted: boolean }> {
  if (options.readOnly) {
    const server = fixture.servers[fixture.serverId]!;
    await client!.mcp.upsertServer(fixture.serverId, { ...server, args: [...(server.args ?? []), '--read-only'] });
    await client!.mcp.reloadServers();
  }
  const sessionId = options.sessionId ?? (await client!.sessions.create({ projectPath: homeDir })).id;
  await client!.sessions.updateSettings(sessionId, { provider: 'product-mcp-test', permissionMode: mode });
  const views: ClientSessionView[] = [];
  const observation = await client!.sessions.observe(sessionId, (view) => views.push(view));
  let prompted = false;
  try {
    const run = await client!.inputs.submit({ sessionId, inputId: randomUUID(), text: `Echo: ${text}` });
    if (!run.runId) throw new Error('Expected an immediate Run.');
    const finished = runtime!.runs.await(run.runId);
    const permission = await Promise.race([
      finished.then(() => undefined),
      expect.poll(() => pendingPermission(views), { timeout: 15_000 }).toBeTruthy().then(() => pendingPermission(views)),
    ]);
    if (permission) {
      prompted = true;
      await options.onPermission?.(permission);
    }
    await finished;
  } finally {
    observation.close();
  }
  return { sessionId, prompted };
}

it('asks before an unannotated MCP tool in accept-edits, and a session grant covers other arguments', async () => {
  const first = await echoInMode('accept-edits', 'first', {
    onPermission: async (permission) => {
      if (permission.kind !== 'permission') throw new Error(`Expected permission, got ${permission.kind}`);
      expect(permission.options.toolName).toBe('mcp_call');
      const suggestion = permission.options.grantSuggestions?.find((item) => item.kind === 'session');
      if (!suggestion) throw new Error('Expected a session grant suggestion.');
      await client!.interactions.respond(permission.requestId, {
        kind: 'permission', decision: { type: 'allow_session', suggestionId: suggestion.id },
      });
    },
  });
  expect(first.prompted).toBe(true);
  expect(results.join('\n')).toContain('echo:first');
  const second = await echoInMode('accept-edits', 'second', { sessionId: first.sessionId });
  expect(second.prompted).toBe(false);
  expect(results.join('\n')).toContain('echo:second');
});

it('runs a readOnlyHint MCP tool in accept-edits without asking', async () => {
  const run = await echoInMode('accept-edits', 'read-only', { readOnly: true });
  expect(run.prompted).toBe(false);
  expect(results.join('\n')).toContain('echo:read-only');
});

it('lets plan mode call a readOnlyHint MCP tool and blocks an unannotated one', async () => {
  await echoInMode('plan', 'mutating');
  expect(results.join('\n')).not.toContain('echo:mutating');
  expect(results.join('\n')).toContain('plan mode');
  results.length = 0;
  await echoInMode('plan', 'planning-read', { readOnly: true });
  expect(results.join('\n')).toContain('echo:planning-read');
});
