import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createMcpTestServerFixture, setAgentConfigHome } from '@kodax-ai/agent';
import { parseMcpIntegrationDocument, writeIntegrationDocument } from '@kodax-ai/repl';
import { createKodaXRuntime, type KodaXRuntime } from "../tests/runtime-fixture.js";

it.each(['lazy', 'prewarm'] as const)('keeps SDK MCP %s process registration in the Host home', async connect => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-mcp-home-'));
  const homeDir = path.join(root, 'sdk');
  const configHome = path.join(homeDir, '.kodax');
  const fixture = await createMcpTestServerFixture(root);
  setAgentConfigHome(path.join(root, 'default'));
  let runtime: KodaXRuntime | undefined;
  try {
    writeIntegrationDocument({ domain: 'mcp', configHome, validate: parseMcpIntegrationDocument,
      document: { version: 1, servers: { [fixture.serverId]: { ...fixture.servers[fixture.serverId]!, connect } } },
    });
    runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
    expect(await runtime.mcp.listTools({ server: fixture.serverId })).toMatchObject([{ serverId: fixture.serverId }]);
    const registrations = await readdir(path.join(configHome, 'runtime', 'processes', 'children'));
    expect(registrations.some(name => name.endsWith('.json'))).toBe(true);
  } finally {
    await runtime?.close();
    setAgentConfigHome(undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
