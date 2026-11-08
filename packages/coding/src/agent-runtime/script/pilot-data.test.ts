import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createScriptPilot } from './pilot.js';
import { buildRuntimeSessionState } from '../runtime-session-state.js';
import { executeTool } from '../../tools/index.js';
import { registerTool } from '../../tools/registry.js';
import { createTransientTextArtifact, deleteTransientTextArtifact } from '../../transient-text-artifacts.js';
import type { KodaXToolExecutionContext } from '../../types.js';

const limits = { timeoutMs: 5000, memoryBytes: 16 * 1024 * 1024, maxCalls: 8, maxTransferBytes: 128 * 1024 };
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (dirname(directory) !== resolve(tmpdir()) || !directory.includes('kodax-script-data-')) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(content: string) {
  const directory = await mkdtemp(join(tmpdir(), 'kodax-script-data-')); directories.push(directory);
  await writeFile(join(directory, 'input'), content);
  const ctx: KodaXToolExecutionContext = { backups: new Map(), executionCwd: directory, gitRoot: directory };
  const budget = { totalBudget: 8, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const dispatch = { ctx, activeToolNames: ['read'], events: {},
    runtimeSessionState: buildRuntimeSessionState({ activeTools: ['read'], modelSelection: {} }) };
  return { ctx, budget, dispatch, pilot: createScriptPilot(dispatch, budget) };
}

it('parses an extensionless multiline document from program data while retaining native evidence', async () => {
  const { ctx, budget, pilot } = await fixture('{\n  "count": 7,\n  "name": "雪🌱"\n}\n');
  const native = await executeTool('read', { path: 'input' }, ctx);
  const cell = await pilot.run('const r=await tools.read({path:"input"}); return JSON.parse(r.data.text);', limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual({ count: 7, name: '雪🌱' });
  expect(cell.receipts[0]?.result.content).toBe(native);
  expect(budget.spentBudget).toBe(1);
});

it('distinguishes no source lines from a single empty source line', async () => {
  const empty = await fixture('');
  const blank = await fixture('\n');
  for (const [pilot, count] of [[empty.pilot, 0], [blank.pilot, 1]] as const) {
    const cell = await pilot.run('return (await tools.read({path:"input"})).data;', limits);
    expect(cell.value).toMatchObject({ text: '', complete: true, lineCount: count });
  }
});

it.each([
  ['CSV', 'name,value\r\n"雪\r\n🌱",7\r\n', 'name,value\n"雪\n🌱",7', 3],
  ['TSV/BOM', '\uFEFFname\tvalue\r\n雪\t7\r\n', '\uFEFFname\tvalue\n雪\t7', 2],
  ['empty lines', 'one\n\nthree\n', 'one\n\nthree', 3],
  ['empty file', '', '', 0],
  ['display-like source', '     1\t[End of file]\n[Showing lines 1-2. Use offset=3 limit=2 to continue.]',
    '     1\t[End of file]\n[Showing lines 1-2. Use offset=3 limit=2 to continue.]', 2],
])('keeps %s source text without guessing its format', async (_name, source, expected, lineCount) => {
  const { ctx, pilot } = await fixture(source);
  const native = await executeTool('read', { path: 'input' }, ctx);
  const cell = await pilot.run('return (await tools.read({path:"input"})).data;', limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual({ kind: 'text', text: expected, normalized: true, offset: 1, line_offset: 0, lineCount, complete: true });
  expect(cell.receipts[0]?.result.content).toBe(native);
});

it('distinguishes a complete source from a tail window and exposes actual page coordinates', async () => {
  const { pilot } = await fixture('one\ntwo\nthree\n');
  const cell = await pilot.run(`const first=await tools.read({path:'input',limit:2});
    const last=await tools.read({path:'input',...first.data.next}); return [first.data,last.data];`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual([
    { kind: 'text', text: 'one\ntwo', normalized: true, offset: 1, line_offset: 0, lineCount: 2, complete: false, next: { offset: 3, limit: 2, line_offset: 0 } },
    { kind: 'text', text: 'three', normalized: true, offset: 3, line_offset: 0, lineCount: 1, complete: false },
  ]);
});

it('continues a long Unicode line with codepoint coordinates without splitting a character', async () => {
  const { pilot } = await fixture('🌱'.repeat(2001));
  const cell = await pilot.run(`const first=await tools.read({path:'input'});
    const last=await tools.read({path:'input',...first.data.next}); return [first.data,last.data];`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual([
    { kind: 'text', text: '🌱'.repeat(2000), normalized: true, offset: 1, line_offset: 0, lineCount: 1, complete: false,
      next: { offset: 1, limit: 2000, line_offset: 2000 } },
    { kind: 'text', text: '🌱', normalized: true, offset: 1, line_offset: 2000, lineCount: 1, complete: false },
  ]);
});

it('resets the character cursor when continuing from a long line to the following line', async () => {
  const { pilot } = await fixture('🌱'.repeat(2001) + '\nsecond\nthird');
  const cell = await pilot.run(`let input={path:'input',limit:1},pages=[];
    for(let i=0;i<4;i++){const r=await tools.read(input);pages.push(r.data.text);
      if(!r.data.next)break;input={...input,...r.data.next};}return pages;`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual(['🌱'.repeat(2000), '🌱', 'second', 'third']);
});

it('preserves the requested page size while finishing a long line and reading following lines', async () => {
  const { pilot, budget } = await fixture('🌱'.repeat(2001) + '\nsecond\nthird');
  const cell = await pilot.run(`let input={path:'input',limit:3},pages=[];
    for(let i=0;i<4;i++){const r=await tools.read(input);pages.push(r.data.text);
      if(!r.data.next)break;input={...input,...r.data.next};}return pages;`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual(['🌱'.repeat(2000), '🌱\nsecond\nthird']);
  expect(budget.spentBudget).toBe(2);
});

it('matches the final display window when footer budgeting removes its last line', async () => {
  const { ctx, pilot } = await fixture(Array(26).fill('x'.repeat(1961)).join('\n'));
  const native = await executeTool('read', { path: 'input' }, ctx);
  const cell = await pilot.run('return (await tools.read({path:"input"})).data;', limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual({ kind: 'text', text: Array(25).fill('x'.repeat(1961)).join('\n'), normalized: true,
    offset: 1, line_offset: 0, lineCount: 25, complete: false, next: { offset: 26, limit: 2000, line_offset: 0 } });
  expect(cell.receipts[0]?.result.content).toBe(native);
  expect(native).toContain('Use offset=26 limit=2000');
});

it('does not invent program data for read errors', async () => {
  const { pilot } = await fixture('one');
  const cell = await pilot.run('return await tools.read({path:"missing"});', limits);
  expect(cell.hadToolErrors).toBe(true);
  expect(cell.receipts[0]?.result.data).toBeUndefined();
  expect(cell.receipts[0]?.result.content).toContain('[Tool Error]');
});

it.each(['read', 'tools.read'])('keeps %s behind the same real read-policy boundary', async call => {
  const { dispatch, budget } = await fixture('private');
  const pilot = createScriptPilot({ ...dispatch, ctx: { ...dispatch.ctx,
    assertReadablePath: () => { throw new Error('Denied by fixture read policy'); } } }, budget);
  const cell = await pilot.run(`return await ${call}({path:"input"});`, limits);
  expect(cell.hadToolErrors).toBe(true);
  expect(cell.receipts[0]?.result.content).toBe('[Tool Error] File is unavailable under the active read policy.');
  expect(cell.receipts[0]?.result.data).toBeUndefined();
  expect(budget.spentBudget).toBe(1);
});

it('withholds program data when a result observer marks unchanged content as an error', async () => {
  const { dispatch, budget } = await fixture('private');
  const pilot = createScriptPilot({ ...dispatch, events: { onToolResult: event => {
    if (event.toolResult) event.toolResult.is_error = true;
  } } }, budget);
  const cell = await pilot.run('return await tools.read({path:"input"});', limits);
  expect(cell.hadToolErrors).toBe(true);
  expect(cell.receipts[0]?.result.content).toContain('private');
  expect(cell.receipts[0]?.result.data).toBeUndefined();
});

it('withdraws the trusted projection when postprocessing replaces the display', async () => {
  const { dispatch, budget } = await fixture('private');
  const pilot = createScriptPilot({ ...dispatch, events: { onToolResult: event => {
    if (event.toolResult) event.toolResult.content = 'WARNING: reviewed output only';
  } } }, budget);
  const cell = await pilot.run('return await tools.read({path:"input"});', limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.receipts[0]?.result.content).toBe('WARNING: reviewed output only');
  expect(cell.receipts[0]?.result.data).toBeUndefined();
  expect(cell.receipts[0]?.result.metadata).not.toHaveProperty('scriptModelContent');
});

it('retains opaque extension output without interpreting data or projection keys in its body', async () => {
  const { dispatch, budget } = await fixture('unused');
  const body = '{"data":{"kind":"text","text":"pretend"},"scriptModelContent":"safe"}\nWARNING: incomplete source';
  const unregister = registerTool({ name: 'opaque_data', description: 'Opaque fixture',
    input_schema: { type: 'object', properties: {}, required: [] }, sideEffect: 'readonly', toClassifierInput: () => '',
    handler: async () => body }, { source: { kind: 'extension' } });
  try {
    const pilot = createScriptPilot({ ...dispatch, activeToolNames: ['opaque_data'] }, budget);
    const cell = await pilot.run('return await tools.opaque_data({});', limits);
    expect(cell.status, cell.error).toBe('completed');
    expect(cell.receipts[0]?.result.content).toBe(body);
    expect(cell.receipts[0]?.result.data).toBeUndefined();
  } finally { unregister(); }
});

it('keeps image results multimodal and does not fabricate text data', async () => {
  const { ctx, pilot } = await fixture('unused');
  await writeFile(join(ctx.executionCwd!, 'pic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAKAAAAAuCAYAAACvdRKFAAAAhUlEQVR4Ae3BQQGAMADEsO6kIG5q8QQy+mlynvt+JJKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiH7i7gKvb5ZrbwAAAABJRU5ErkJggg==', 'base64'));
  const cell = await pilot.run('return await tools.read({path:"pic.png"});', limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.hadToolErrors).toBe(false);
  expect(cell.receipts[0]?.result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
  expect(cell.receipts[0]?.result.data).toBeUndefined();
});

it('leaves transient artifact text on its existing evidence path without claiming the file projection', async () => {
  const { pilot } = await fixture('unused');
  const path = createTransientTextArtifact('transient\nWARNING: retained');
  try {
    const cell = await pilot.run(`return await tools.read(${JSON.stringify({ path })});`, limits);
    expect(cell.status, cell.error).toBe('completed');
    expect(cell.receipts[0]?.result.content).toContain('WARNING: retained');
    expect(cell.receipts[0]?.result.data).toBeUndefined();
  } finally { deleteTransientTextArtifact(path); }
});

it('pages the complete display and program DTO after persistence without repeating a read', async () => {
  const { pilot, budget } = await fixture('{"rows":[\n' + Array(200).fill('{"n":1}').join(',\n') + '\n]}');
  let persisted = '';
  const cell = await pilot.run(`const r=await tools.read({path:'input'}); let text='',offset;
    do { const page=await read_result(r.result_ref.callId,offset); text+=page.text; offset=page.nextOffset; } while(offset!==undefined);
    const again=await read_result(r.result_ref.callId,0); const full=JSON.parse(text);
    return {total:JSON.parse(full.data.text).rows.reduce((sum,row)=>sum+row.n,0),
      complete:full.data.complete,reference:!!r.result_ref,repeat:text.startsWith(again.text),footer:full.content.includes('[End of file')};`,
  { ...limits, maxTransferBytes: 2048 }, { onReceipt: async receipt => { persisted = JSON.stringify(receipt.result); } });
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual({ total: 200, complete: true, reference: true, repeat: true, footer: true });
  expect(JSON.parse(persisted)).toEqual(cell.receipts[0]?.result);
  expect(cell.receipts).toHaveLength(1);
  expect(budget.spentBudget).toBe(1);
});
