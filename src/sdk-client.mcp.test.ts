import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { createMcpTestServerFixture } from '@kodax-ai/agent';
import { parseMcpIntegrationDocument, writeIntegrationDocument } from '@kodax-ai/repl';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
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

it('reloads the actual Host MCP provider used by subsequent model tool calls', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-mcp-'));
  const fixture = await createMcpTestServerFixture(homeDir);
  const results: string[] = [];
  registerModelProvider('product-mcp-test', () => new McpTestProvider(fixture.toolId, results));
  vi.stubEnv('KODAX_PRODUCT_MCP_TEST_KEY', 'test-only');
  const profile = 'mcp-contract';
  writeIntegrationDocument({
    domain: 'mcp', configHome: path.join(homeDir, '.kodax'),
    document: { version: 1, servers: fixture.servers }, validate: parseMcpIntegrationDocument,
  });
  const runtime = await createKodaXRuntime({ homeDir, profile, sharedDaemonHost: true });
  try {
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Could not acquire isolated MCP Host.');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-mcp-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    try {
      const client = await connectKodaXClient({ homeDir, profile, endpoint: endpoint.path });
      try {
        const session = await client.sessions.create({ projectPath: homeDir });
        await client.sessions.updateSettings(session.id, { provider: 'product-mcp-test', permissionMode: 'full-access', agentMode: 'sa' });
        const initial = await client.inputs.submit({ sessionId: session.id, inputId: 'cold-start', text: 'Call the echo MCP tool.' });
        if (!initial.runId) throw new Error('Expected an immediate Run.');
        await runtime.runs.await(initial.runId);
        expect(results.join('\n')).toContain('echo:live Host');
        expect(await client.mcp.listTools({ server: fixture.serverId }))
          .toMatchObject([{ serverId: fixture.serverId, tools: [{ id: fixture.toolId, name: 'echo_tool' }] }]);
        results.length = 0;
        writeIntegrationDocument({
          domain: 'mcp', configHome: path.join(homeDir, '.kodax'),
          document: { version: 1, servers: { retained: { command: 'unused-disabled-server', connect: 'disabled' } } },
          validate: parseMcpIntegrationDocument,
        });
        expect(await client.mcp.listServers()).toHaveProperty('retained');
        await client.mcp.upsertServer(fixture.serverId, fixture.servers[fixture.serverId]!);
        await client.mcp.reloadServers();
        const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'mcp-input', text: 'Call the echo MCP tool.' });
        if (!accepted.runId) throw new Error('Expected an immediate Run.');
        await runtime.runs.await(accepted.runId);
        expect(results.join('\n')).toContain('echo:live Host');
        const privateConfig = { private: fixture.servers[fixture.serverId]! };
        const firstPrivate = await client.sessions.create({ projectPath: homeDir, mcpServers: privateConfig });
        const secondPrivate = await client.sessions.create({ projectPath: homeDir, mcpServers: privateConfig });
        for (const privateSession of [firstPrivate, secondPrivate]) {
          await client.sessions.updateSettings(privateSession.id, { provider: 'product-mcp-test', permissionMode: 'full-access', agentMode: 'sa' });
        }
        const invokePrivate = async (sessionId: string, inputId: string) => {
          results.length = 0;
          const run = await client.inputs.submit({ sessionId, inputId, text: 'Call the private MCP tool.' });
          if (!run.runId) throw new Error('Expected an immediate Run.');
          await runtime.runs.await(run.runId);
          expect(results.join('\n')).toContain('echo:live Host');
        };
        await invokePrivate(firstPrivate.id, 'first-private');
        await client.sessions.delete(firstPrivate.id);
        await invokePrivate(secondPrivate.id, 'second-private');
        expect(Object.keys(await client.mcp.listServers())).toEqual(['retained', fixture.serverId]);
      } finally {
        await client.disconnect();
      }
    } finally {
      await host.close();
    }
  } finally {
    await runtime.close();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
});
