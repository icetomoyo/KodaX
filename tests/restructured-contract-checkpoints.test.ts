import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CACHE_FILES, CACHE_TASK } from '../benchmark/datasets/search-entry-complex/fixture.js';
import { captureRestructuredCheckpoints } from './restructured-contract-checkpoints.js';
import { runComplexRuntime } from './first-turn-complex-runtime.js';
import type { FrozenInput } from './first-turn-eval-support.js';

vi.mock('./first-turn-complex-runtime.js', { spy: true });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(['start-plan', 'cancel-preparation'])('rejects a false Todo result without is_error at %s', async failingId => {
  vi.mocked(runComplexRuntime).mockImplementationOnce(async (_route, _directory, invoke) => {
    const input: FrozenInput = { system: 'fixture', tools: [], messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'create-plan', content: '{"ok":true,"id":"todo_1"}' },
      { type: 'tool_result', tool_use_id: 'start-plan', content: JSON.stringify({ ok: failingId !== 'start-plan' }) },
      { type: 'tool_result', tool_use_id: 'read-cache', content: 'current source' },
      { type: 'tool_result', tool_use_id: 'stale-edit', content: '[Tool Error] Anchor not found', is_error: true },
      { type: 'tool_result', tool_use_id: 'cancel-preparation', content: '{"ok":false,"reason":"blocked-by-hook"}' },
    ] }] };
    const signal = new AbortController().signal;
    await invoke(input, signal, 1, {});
    await invoke(input, signal, 2, {});
    if (failingId === 'cancel-preparation') {
      await invoke(input, signal, 3, {});
      await invoke(input, signal, 4, {});
    }
    throw new Error('Expected explicit Todo failure to stop preparation');
  });
  await expect(captureRestructuredCheckpoints('unused-no-files-created')).rejects.toThrow(`Todo operation did not succeed: ${failingId}`);
});

it('captures current plan and actual stale-anchor failure from one offline Runtime trace', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw new Error('Offline capture forbids network'); });
  vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-restructured-checkpoints-'));
  try {
    const result = await captureRestructuredCheckpoints(directory);
    expect(result.kind).toBe('offline-checkpoints-not-full-e2e');
    expect(result.checkpoints.map(item => item.id)).toEqual(['initial', 'known-plan-and-content', 'stale-anchor']);
    expect(result.counts.responses).toBe(5);
    expect(result.counts.toolCount).toBe(5);
    expect(result.fullTaskCompleted).toBe(false);
    expect(result.oraclePass).toBe(false);
    expect(result.paidProviderCalls).toBe(0);
    const [initial, known, stale] = result.checkpoints;
    for (const checkpoint of result.checkpoints) {
      expect(checkpoint.input.messages.some(message => typeof message.content === 'string' && message.content.includes(CACHE_TASK))).toBe(true);
      expect(JSON.stringify(checkpoint.input.messages)).not.toContain('## Controlled checkpoint');
      expect(checkpoint.input.system).toBe(initial!.input.system);
      expect(checkpoint.input.tools.map(tool => tool.name)).toEqual(initial!.input.tools.map(tool => tool.name));
    }
    const blocks = (index: number) => result.checkpoints[index]!.input.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    expect(blocks(1)).toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'read-cache', content: expect.stringContaining('clock() > entry.expiresAt') }));
    expect(blocks(1)).toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'start-plan', content: expect.stringContaining('"ok":true') }));
    expect(blocks(2)).toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'stale-edit', is_error: true }));
    expect(known!.input.messages.length).toBeLessThan(stale!.input.messages.length);
    expect(await fs.readFile(path.join(directory, 'workspace/packages/cache/store.js'), 'utf8')).toBe(CACHE_FILES['packages/cache/store.js']);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unsafe cleanup');
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 45000);
