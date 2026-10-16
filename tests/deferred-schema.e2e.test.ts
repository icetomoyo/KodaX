import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXRuntime } from '../src/sdk-runtime.js';

it('discovers a deferred builtin and executes its real handler through the managed bridge', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-deferred-e2e-'));
  const marker = 'fixture-token-6049';
  let reads = 0;
  const server = createServer((_request, response) => { reads++; response.writeHead(200, { 'content-type': 'text/plain' }); response.end(marker); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
  const url = `http://127.0.0.1:${address.port}/source`;
  const command = 'node --test verify-fetch.test.mjs';
  await writeFile(path.join(root, 'verify-fetch.test.mjs'), `import {test} from 'node:test';import assert from 'node:assert/strict';test('fixture endpoint',async()=>{assert.equal(await (await fetch(${JSON.stringify(url)})).text(),${JSON.stringify(marker)});});`);
  let requests = 0;
  class DiscoveryProvider extends KodaXBaseProvider {
    readonly name = 'deferred-e2e';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_DEFERRED_E2E_KEY', model: 'fixture', supportsThinking: false };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      const round = requests++;
      if (round > 3) throw new Error('Four-response graph exceeded.');
      expect(args[1].map(tool => tool.name)).toContain('web_fetch');
      const prior = JSON.stringify(args[0].at(-1));
      if (round === 1) expect(prior).toContain('parameters');
      if (round === 2) expect(prior).toContain(marker);
      if (round === 3) expect(prior).toMatch(/Exit(?: code)?: 0/);
      const call = [
        { name: 'tool_search', input: { query: 'select:web_fetch' } },
        { name: 'tool_call', input: { name: 'web_fetch', input: { url } } },
        { name: 'bash', input: { command } },
      ][round];
      return call ? { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
        toolBlocks: [{ type: 'tool_use', id: `call-${round}`, ...call }] }
        : { textBlocks: [{ type: 'text', text: 'Fetched the fixture and the independent Node test passed.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  const unregister = registerModelProvider('deferred-e2e', () => new DiscoveryProvider());
  vi.stubEnv('KODAX_DEFERRED_E2E_KEY', 'test-only');
  const runtime = await createKodaXRuntime({ homeDir: path.join(root, 'home'), defaultProvider: 'deferred-e2e' });
  try {
    const session = await runtime.sessions.create({ projectPath: root });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
    const run = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: 'Discover web_fetch, read the fixture, then run its Node test.',
      options: { provider: 'deferred-e2e', agentMode: 'ama', lsp: false,
        context: { executionCwd: root, repoIntelligenceMode: 'off', toolVisibilityPolicy: tool => ['tool_search', 'tool_call', 'web_fetch', 'bash'].includes(tool.name) } } });
    const result = await run.result;
    expect(result.phase, JSON.stringify({ error: result.error, requests, reads })).toBe('completed');
    expect(requests).toBe(4);
    expect(reads).toBe(2);
    expect(await readFile(path.join(root, 'verify-fetch.test.mjs'), 'utf8')).toContain(marker);
  } finally {
    await runtime.close(); unregister(); vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
