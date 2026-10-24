import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { captureReadonlySearchInput } from './first-turn-unfamiliar-search.js';
import { projectLocalSearchInput } from './deferred-repo-lsp-support.js';
import { restoreSearchCheckpoint } from './first-turn-unfamiliar-search.js';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';

it('restores the exact pending request without replaying tools or accepting altered input', () => {
  const input: FrozenInput = { system: 'unchanged', tools: [], messages: [{ role: 'user', content: 'task and actual receipts' }] };
  const result = { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use' as const, id: 'pending', name: 'read', input: { path: 'src/index.ts' } }], stopReason: 'tool_use' as const };
  const evidence = { inputHash: inputHash(input), result, error: null };
  expect(restoreSearchCheckpoint(input, evidence)).toEqual(input.messages);
  expect(() => restoreSearchCheckpoint({ ...input, system: 'answer hint' }, evidence)).toThrow('Checkpoint input changed');
  expect(() => restoreSearchCheckpoint(input, { ...evidence, error: 'timeout' })).toThrow('successful pending');
  expect(() => restoreSearchCheckpoint(input, { ...evidence, result: { ...result, toolBlocks: [], stopReason: 'end_turn' } })).toThrow('successful pending');
});

it('captures a pinned, complete Git subtree through real AMA without network or answer injection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-unfamiliar-capture-'));
  const source = path.join(root, 'source');
  vi.stubEnv('ZHIPU_CODING_API_KEY', 'offline-only');
  const fetcher = vi.fn(() => { throw new Error('No network allowed'); });
  vi.stubGlobal('fetch', fetcher);
  try {
    await fs.mkdir(path.join(source, 'packages/tui/src'), { recursive: true });
    await fs.writeFile(path.join(source, 'packages/tui/package.json'), '{"name":"sample-tui","type":"module"}\n');
    await fs.writeFile(path.join(source, 'packages/tui/README.md'), 'Terminal utilities.\n');
    await fs.writeFile(path.join(source, 'packages/tui/src/index.ts'), 'export const specialValue = 512;\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true }).trim();
    git('init', '-q'); git('add', '--all');
    git('-c', 'user.name=Eval', '-c', 'user.email=eval@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    const revision = git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(source, 'packages/tui/src/index.ts'), 'uncommitted content must not leak');
    const captured = await captureReadonlySearchInput(path.join(root, 'capture'), '只读定位实现，不修改文件。', source, revision);
    expect(Object.keys(captured.files)).toHaveLength(3);
    expect(await fs.readFile(path.join(captured.workspace, 'src/index.ts'), 'utf8')).toBe('export const specialValue = 512;\n');
    expect(captured.input.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['grep', 'glob', 'read', 'spawn_agent', 'todo_create']));
    expect(captured.input.tools.some(tool => tool.name === 'code_search')).toBe(false);
    const candidate = projectLocalSearchInput(captured.input, true);
    expect(candidate.system).toBe(captured.input.system);
    expect(candidate.messages).toBe(captured.input.messages);
    expect(candidate).toBe(captured.input);
    expect(JSON.stringify(captured.input.messages)).not.toContain('specialValue = 512');
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-unfamiliar-capture-')) throw new Error('Unsafe cleanup');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);
