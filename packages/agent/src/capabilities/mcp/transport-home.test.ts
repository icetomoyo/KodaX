import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { setAgentConfigHome } from '../../runtime/agent-home.js';
import { createMcpTransport } from './transport.js';

it('binds a delayed stdio connection to its Host home and retains it for close', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-private-home-'));
  const configHome = path.join(root, 'private');
  setAgentConfigHome(path.join(root, 'default'));
  const transport = createMcpTransport({ type: 'stdio', command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
  }, { configHome });
  try {
    await transport.open({ onMessage() {}, onClose() {}, onError(error) { throw error; } });
    expect((await readdir(path.join(configHome, 'runtime', 'processes', 'children'))).filter(name => name.endsWith('.json')).length).toBeGreaterThan(0);
  } finally {
    await transport.close();
    setAgentConfigHome(undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
