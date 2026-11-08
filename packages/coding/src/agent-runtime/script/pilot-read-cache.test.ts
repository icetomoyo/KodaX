import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { isRunnableTool } from '@kodax-ai/agent';
import { createScriptPilot } from './pilot.js';
import { closeScriptModelSession, withScriptModelTool } from './model.js';
import type { ScriptCellResult } from './cell.js';
import { buildRuntimeSessionState } from '../runtime-session-state.js';
import { executeTool } from '../../tools/index.js';
import { createReadFileStateCache } from '../../multi-instance/read-file-state-cache.js';
import { createContentHashCache } from '../../multi-instance/content-hash-cache.js';
import type { KodaXToolExecutionContext } from '../../types.js';

const limits = { timeoutMs: 5000, memoryBytes: 16 * 1024 * 1024, maxCalls: 8, maxTransferBytes: 128 * 1024 };
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (dirname(directory) !== resolve(tmpdir()) || !directory.includes('kodax-script-read-cache-')) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'kodax-script-read-cache-')); directories.push(directory);
  const file = join(directory, 'data.txt');
  await writeFile(file, 'PRIVATE-PAYLOAD\nvalue=42\n');
  const cache = createReadFileStateCache({ disabled: false });
  const hashes = createContentHashCache();
  const ctx: KodaXToolExecutionContext = { backups: new Map(), executionCwd: directory, gitRoot: directory,
    readFileStateCache: cache, contentHashCache: hashes };
  const budget = { totalBudget: 8, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const activeToolNames = ['read', 'write', 'edit'];
  const dispatch = { ctx, activeToolNames, events: {},
    runtimeSessionState: buildRuntimeSessionState({ activeTools: activeToolNames, modelSelection: {} }) };
  return { file, ctx, cache, hashes, budget, dispatch, pilot: createScriptPilot(dispatch, budget) };
}

it('gives each guest real file data even after native observation and across cells', async () => {
  const { ctx, cache, budget, pilot } = await fixture();
  const input = { path: 'data.txt' };
  const full = await executeTool('read', input, ctx);
  expect(full).toContain('PRIVATE-PAYLOAD');
  expect(await executeTool('read', input, ctx)).toContain('[Read Cache]');
  for (let cell = 0; cell < 2; cell++) {
    const result = await pilot.run('return [(await tools.read({path:"data.txt"})).content,(await tools.read({path:"data.txt"})).content];', limits);
    expect(result.status, result.error).toBe('completed');
    expect(result.value).toEqual([full, full]);
    expect(result.receipts).toHaveLength(2);
  }
  expect(cache.size()).toBe(1); // Guest reads do not clear prior native observations.
  expect(await executeTool('read', input, ctx)).toContain('[Read Cache]');
  expect(budget.spentBudget).toBe(4);
});

it('does not mark selected guest data as model-observed before a later native read', async () => {
  const { ctx, cache, budget, pilot } = await fixture();
  let cell: ScriptCellResult | undefined;
  const model = withScriptModelTool({ name: 'fixture', instructions: '' }, ctx, pilot.tools, async code => {
    cell = { ...await pilot.run(code, limits), cellId: 'selected-cache-cell' };
    return cell;
  }, () => cell?.receipts[0]);
  try {
    const entry = model.tools?.find(tool => tool.name === 'script_exec');
    if (!entry || !isRunnableTool(entry)) throw new Error('Missing Script entry');
    const response = await entry.execute({ selected_output: true,
      code: 'const data=await tools.read({path:"data.txt"}); return {hasValue:data.content.includes("value=42")};' }, { agent: model });
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(response.content)).toContain('contentOmitted');
    expect(JSON.stringify(response.content)).not.toContain('PRIVATE-PAYLOAD');
    expect(cell?.receipts[0]?.result.content).toContain('PRIVATE-PAYLOAD');
    expect(cache.size()).toBe(0);
    expect(await executeTool('read', { path: 'data.txt' }, ctx)).toContain('PRIVATE-PAYLOAD');
    expect(cache.size()).toBe(1);
    expect(budget.spentBudget).toBe(1);
  } finally { await closeScriptModelSession(model); }
});

it.each(['write', 'edit'])('invalidates native observations after guest %s while keeping native mutation safety', async name => {
  const { file, ctx, cache, hashes, budget, pilot } = await fixture();
  await executeTool('read', { path: 'data.txt' }, ctx);
  expect(cache.size()).toBe(1);
  const input = name === 'write'
    ? { path: 'data.txt', content: 'PRIVATE-PAYLOAD\nvalue=43\n' }
    : { path: 'data.txt', old_string: 'value=42', new_string: 'value=43' };
  const result = await pilot.run(`return await tools.${name}(${JSON.stringify(input)});`, limits);
  expect(result.status, result.error).toBe('completed');
  expect(result.hadToolErrors).toBe(false);
  expect(cache.size()).toBe(0); // Explicit invalidation, independent of mtime resolution.
  expect(await readFile(file, 'utf8')).toBe('PRIVATE-PAYLOAD\nvalue=43\n');
  expect(hashes.checkStale(file)).toMatchObject({ kind: 'fresh', stale: false });
  expect(await executeTool('read', { path: 'data.txt' }, ctx)).toContain('value=43');
  expect(budget.spentBudget).toBe(1);
});

it('keeps the content-hash fence for guest read then edit across cells, including external changes', async () => {
  const { file, hashes, budget, pilot } = await fixture();
  const read = await pilot.run('return (await tools.read({path:"data.txt"})).content;', limits);
  expect(read.value).toContain('PRIVATE-PAYLOAD');
  expect(hashes.checkStale(file)).toMatchObject({ kind: 'fresh', stale: false });
  const edited = await pilot.run('return await tools.edit({path:"data.txt",old_string:"value=42",new_string:"value=43"});', limits);
  expect(edited.hadToolErrors).toBe(false);
  await writeFile(file, 'PRIVATE-PAYLOAD\nvalue=peer\n');
  const refused = await pilot.run('return await tools.edit({path:"data.txt",old_string:"value=peer",new_string:"value=lost"});', limits);
  expect(refused.hadToolErrors).toBe(true);
  expect(refused.receipts[0]?.result.content).toContain('changed');
  expect(await readFile(file, 'utf8')).toBe('PRIVATE-PAYLOAD\nvalue=peer\n');
  expect(budget.spentBudget).toBe(3);
});
