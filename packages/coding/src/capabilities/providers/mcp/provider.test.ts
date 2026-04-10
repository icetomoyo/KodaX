import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createExtensionRuntime } from '../../../extensions/runtime.js';
import { getMcpCachePaths } from './catalog.js';
import { registerConfiguredMcpCapabilityProvider } from './provider.js';
import { createMcpTestServerFixture } from './test-helpers.js';

describe('registerConfiguredMcpCapabilityProvider', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('registers a runtime-owned MCP provider with search, describe, execute, read, prompt, and cache support', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-provider-'));
    tempDirs.push(tempDir);
    const fixture = await createMcpTestServerFixture(tempDir);
    const runtime = createExtensionRuntime().activate();

    const provider = await registerConfiguredMcpCapabilityProvider(runtime, fixture.config);
    expect(provider).toBeDefined();
    expect(runtime.getDiagnostics().capabilityProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'mcp',
          source: expect.objectContaining({
            kind: 'runtime',
            id: 'runtime:capability:mcp',
          }),
          metadata: expect.objectContaining({
            serverCount: 1,
            toolCount: 1,
            resourceCount: 1,
            promptCount: 1,
          }),
        }),
      ]),
    );

    await expect(runtime.searchCapabilities('mcp', 'echo', { kind: 'tool' })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.toolId,
          serverId: fixture.serverId,
          kind: 'tool',
        }),
      ]),
    );
    await expect(runtime.describeCapability('mcp', fixture.toolId)).resolves.toEqual(
      expect.objectContaining({
        id: fixture.toolId,
        inputSchema: expect.any(Object),
      }),
    );
    await expect(
      runtime.executeCapability('mcp', fixture.toolId, { text: 'hello', mode: 'demo' }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: 'tool',
        content: 'echo:hello',
        structuredContent: {
          echo: 'hello',
          mode: 'demo',
        },
      }),
    );
    await expect(runtime.readCapability('mcp', fixture.resourceId)).resolves.toEqual(
      expect.objectContaining({
        kind: 'resource',
        content: 'resource:memory://guide',
      }),
    );
    await expect(runtime.getCapabilityPrompt('mcp', fixture.promptId, { topic: 'wave-d' })).resolves.toEqual(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.objectContaining({
              text: 'prompt:draft_prompt:wave-d',
            }),
          }),
        ],
      }),
    );
    await expect(runtime.getCapabilityPromptContext('mcp')).resolves.toContain('## MCP Capability Provider');

    const { indexPath, itemsPath } = getMcpCachePaths(fixture.cacheDir, fixture.serverId);
    await expect(Promise.all([
      import('node:fs/promises').then((fs) => fs.readFile(indexPath, 'utf8')),
      import('node:fs/promises').then((fs) => fs.readFile(itemsPath, 'utf8')),
    ])).resolves.toHaveLength(2);

    await runtime.dispose();
  });

  it('fails soft when one configured MCP server cannot prewarm', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-provider-broken-'));
    tempDirs.push(tempDir);
    const fixture = await createMcpTestServerFixture(tempDir);
    const runtime = createExtensionRuntime().activate();

    const provider = await registerConfiguredMcpCapabilityProvider(runtime, {
      ...fixture.config,
      servers: {
        ...(fixture.config.servers ?? {}),
        broken: {
          type: 'stdio',
          command: path.join(tempDir, 'missing-mcp-server.exe'),
          connect: 'prewarm',
          startupTimeoutMs: 1_000,
          requestTimeoutMs: 1_000,
        },
      },
    });
    expect(provider).toBeDefined();
    await expect(runtime.searchCapabilities('mcp', 'echo')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.toolId,
        }),
      ]),
    );
    await expect(runtime.getCapabilityPromptContext('mcp')).resolves.toContain('broken');
    expect(runtime.getDiagnostics().capabilityProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            serverCount: 2,
            servers: expect.arrayContaining([
              expect.objectContaining({
                serverId: 'broken',
                status: 'error',
              }),
            ]),
          }),
        }),
      ]),
    );

    await runtime.dispose();
  });
});
