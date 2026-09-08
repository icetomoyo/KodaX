import { randomUUID } from 'node:crypto';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { createMcpTestServerFixture } from '@kodax-ai/agent';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

class McpRestartProvider extends KodaXBaseProvider {
  readonly name = 'product-mcp-restart-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_MCP_RESTART_TEST_KEY', model: 'mcp-restart-test', supportsThinking: false,
  };
  constructor(private readonly toolId: string, private readonly results: string[]) { super(); }
  async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
    const last = args[0].at(-1);
    if (last?.role === 'user' && typeof last.content === 'string' && last.content.startsWith('Call the private MCP tool')) {
      return {
        textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
        toolBlocks: [{ type: 'tool_use', id: randomUUID(), name: 'mcp_call', input: { id: this.toolId.replace(':demo:', ':private:'), args: { text: 'live Host' } } }],
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

it('rebuilds per-Session MCP resources across a Host restart and drops removed sessions', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-mcp-restart-'));
  const fixture = await createMcpTestServerFixture(homeDir);
  const results: string[] = [];
  registerModelProvider('product-mcp-restart-test', () => new McpRestartProvider(fixture.toolId, results));
  vi.stubEnv('KODAX_PRODUCT_MCP_RESTART_TEST_KEY', 'test-only');
  const profile = 'mcp-restart';
  const privateConfig = { private: fixture.servers[fixture.serverId]! };

  const boot = async () => {
    const runtime = await createKodaXRuntime({ homeDir, profile, sharedDaemonHost: true });
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Could not acquire the MCP restart Host.');
    const endpointPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\kodax-mcp-restart-${randomUUID()}`
      : path.join(homeDir, 'host.sock');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: endpointPath }
      : { kind: 'unix' as const, path: endpointPath };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    const client = await connectKodaXClient({ homeDir, profile, endpoint: endpointPath });
    return { runtime, host, client };
  };

  let first = await boot();
  let survivorId = '';
  let removedId = '';
  try {
    const survivor = await first.client.sessions.create({ projectPath: homeDir, mcpServers: privateConfig });
    const removed = await first.client.sessions.create({ projectPath: homeDir, mcpServers: privateConfig });
    survivorId = survivor.id;
    removedId = removed.id;
    for (const session of [survivor, removed]) {
      await first.client.sessions.updateSettings(session.id, {
        provider: 'product-mcp-restart-test', permissionMode: 'full-access', agentMode: 'sa',
      });
    }
    const invoke = async (sessionId: string, inputId: string) => {
      results.length = 0;
      const run = await first.client.inputs.submit({ sessionId, inputId, text: `Call the private MCP tool (${inputId}).` });
      if (!run.runId) throw new Error('Expected an immediate Run.');
      await first.runtime.runs.await(run.runId);
      expect(results.join('\n')).toContain('echo:live Host');
    };
    await invoke(survivor.id, 'before-restart');
    await first.client.sessions.delete(removed.id);
  } finally {
    await first.client.disconnect();
    await first.host.close();
    await first.runtime.close();
  }

  // Restart over the same storage root: the surviving Session's private MCP
  // resources are rebuilt from the persisted Host-side record, and the
  // deleted Session leaves no rebuildable state behind.
  // A temporary executable outage must not erase the saved connection intent.
  await rename(fixture.scriptPath, `${fixture.scriptPath}.offline`);
  const unavailable = await boot();
  try {
    await unavailable.client.sessions.read(survivorId);
  } finally {
    await unavailable.client.disconnect();
    await unavailable.host.close();
    await unavailable.runtime.close();
    await rename(`${fixture.scriptPath}.offline`, fixture.scriptPath);
  }
  const second = await boot();
  try {
    const invoke = async (sessionId: string, inputId: string) => {
      results.length = 0;
      const run = await second.client.inputs.submit({ sessionId, inputId, text: `Call the private MCP tool (${inputId}).` });
      if (!run.runId) throw new Error('Expected an immediate Run.');
      await second.runtime.runs.await(run.runId);
      expect(results.join('\n')).toContain('echo:live Host');
    };
    await invoke(survivorId, 'after-restart');
    await expect(second.client.sessions.read(removedId)).rejects.toThrow();
    expect(Object.keys(await second.client.mcp.listServers())).toEqual([]);

    // Archiving releases the live resource; unarchiving rebuilds it from the
    // persisted record and the same private tool keeps working.
    await second.client.sessions.archive(survivorId);
    await second.client.sessions.unarchive(survivorId);
    await invoke(survivorId, 'after-unarchive');
  } finally {
    await second.client.disconnect();
    await second.host.close();
    await second.runtime.close();
  }

  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await awaitLatestCodingMemoryReviewDrain(5_000);
  await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
}, 180_000);
