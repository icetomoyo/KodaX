import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createExtensionRuntime } from '../extensions/runtime.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { registerConfiguredMcpCapabilityProvider } from '../capabilities/providers/mcp/provider.js';
import { createMcpTestServerFixture } from '../capabilities/providers/mcp/test-helpers.js';
import {
  toolMcpCall,
  toolMcpDescribe,
  toolMcpGetPrompt,
  toolMcpReadResource,
  toolMcpSearch,
} from './index.js';

describe('MCP retrieval tools', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('searches, describes, invokes, and reads MCP capabilities through the shared extension runtime', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-tools-'));
    tempDirs.push(tempDir);
    const fixture = await createMcpTestServerFixture(tempDir);
    const runtime = createExtensionRuntime().activate();
    await registerConfiguredMcpCapabilityProvider(runtime, fixture.servers, { cacheDir: fixture.cacheDir });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      gitRoot: tempDir,
      extensionRuntime: runtime,
    };

    const searchOutput = await toolMcpSearch({ query: 'echo', server: fixture.serverId }, ctx);
    expect(searchOutput).toContain('Retrieval result for mcp_search');
    expect(searchOutput).toContain(fixture.toolId);

    const describeOutput = await toolMcpDescribe({ id: fixture.toolId }, ctx);
    expect(describeOutput).toContain('Retrieval result for mcp_describe');
    expect(describeOutput).toContain('Echo Tool');
    expect(describeOutput).toContain(fixture.serverId);

    const callOutput = await toolMcpCall({ id: fixture.toolId, args: { text: 'hello', mode: 'demo' } }, ctx);
    expect(callOutput).toContain('Retrieval result for mcp_call');
    expect(callOutput).toContain('echo:hello');
    expect(callOutput).toContain('"mode":"demo"');

    const readOutput = await toolMcpReadResource({ id: fixture.resourceId }, ctx);
    expect(readOutput).toContain('Retrieval result for mcp_read_resource');
    expect(readOutput).toContain('resource:memory://guide');

    const promptOutput = await toolMcpGetPrompt({ id: fixture.promptId, args: { topic: 'test' } }, ctx);
    expect(promptOutput).toContain('Retrieval result for mcp_get_prompt');
    expect(promptOutput).toContain('prompt:draft_prompt:test');

    await runtime.dispose();
  });
});
