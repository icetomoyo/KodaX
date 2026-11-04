import { expect, it, vi } from 'vitest';
import type { RunnableTool } from '@kodax-ai/agent';
import { withScriptModelTool, canReadWithModelTools, projectScriptModelTools, getScriptModelContracts, buildScriptModelDescription, closeScriptModelSession } from './model.js';
import { fitToolSchemasToContext } from '../tool-exposure-planner.js';
import { getToolDefinition } from '../../tools/index.js';
import type { ScriptCellResult } from './cell.js';

it('discloses outer async helper lifetime in the callable code contract', async () => {
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [],
    async () => ({ status: 'completed', receipts: [], hadToolErrors: false }));
  try {
    const entry = agent.tools!.find(tool => tool.name === 'script_exec')!;
    expect(JSON.stringify(entry.input_schema)).toMatch(/await or return.*async helper calls.*cell body/i);
  } finally { await closeScriptModelSession(agent); }
});

it.each([false, true])('references a displayed source copy without changing explicit returns (selected: %s)', async selected => {
  const sourceContent = '  Opaque source: 雪\tkeep the exact spacing.\r\n'.repeat(30);
  const leaf = { content: `Display header\n${sourceContent}\nDisplay footer`, sourceContent };
  const cell: ScriptCellResult = { cellId: 'source-copy', status: 'completed', hadToolErrors: false,
    value: { originalText: sourceContent }, receipts: [{ id: 1, name: 'host.data', input: {}, result: leaf }] };
  const before = structuredClone(cell);
  const run = vi.fn(async () => cell);
  const read = vi.fn(() => ({ status: 'settled', text: JSON.stringify({ result: leaf }) }));
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], run, read);
  try {
    const entry = agent.tools!.find(tool => tool.name === 'script_exec') as RunnableTool;
    const response = await entry.execute({ code: 'return suppliedSource;', selected_output: selected }, { agent });
    const visible = JSON.parse(String(response.content));
    expect(visible.receipts[0].result).not.toHaveProperty('sourceContent');
    expect(visible.receipts[0].result).toMatchObject({ sourceContentOmitted: true,
      original: { cell_id: 'source-copy', call_id: 1 }, content: leaf.content });
    expect(visible.value).toEqual({ originalText: sourceContent });
    expect(Buffer.byteLength(String(response.content))).toBeLessThan(Buffer.byteLength(JSON.stringify(before)));
    expect(read).not.toHaveBeenCalled();
    const reader = agent.tools!.find(tool => tool.name === 'script_read') as RunnableTool;
    const original = JSON.parse(String((await reader.execute({ cell_id: 'source-copy', call_id: 1 }, { agent })).content));
    expect(JSON.parse(original.text).result.sourceContent).toBe(sourceContent);
    expect(run).toHaveBeenCalledOnce();
    expect(cell).toEqual(before);
  } finally { await closeScriptModelSession(agent); }
});

it.each([
  { name: 'missing reader', source: 'source body '.repeat(40), displayed: true, readable: false, omitted: false },
  { name: 'undisplayed text', source: 'source body '.repeat(40), displayed: false, readable: true, omitted: false },
  { name: 'whitespace', source: ' '.repeat(400), displayed: false, readable: true, omitted: false },
  { name: 'empty text', source: '', displayed: true, readable: true, omitted: false },
  { name: 'small text', source: 'x', displayed: true, readable: true, omitted: false },
  { name: 'blocks', source: [{ type: 'text' as const, text: 'opaque block\n'.repeat(40) }], displayed: true, readable: true, omitted: true },
  { name: 'undisplayed blocks', source: [{ type: 'text' as const, text: 'opaque block\n'.repeat(40) }], displayed: false, readable: true, omitted: false },
  { name: 'empty blocks', source: [], displayed: true, readable: true, omitted: false },
])('preserves the source visibility and byte boundary for $name', async test => {
  const content = !test.displayed ? 'Display omitted the source.' : typeof test.source === 'string'
    ? `Header\n${test.source}\nFooter` : [{ type: 'text' as const, text: 'Header' }, ...test.source];
  const leaf = { content, sourceContent: test.source };
  const cell: ScriptCellResult = { cellId: 'source-boundary', status: 'completed', hadToolErrors: false,
    value: { copiedSource: test.source }, receipts: [{ id: 1, name: 'source.tool', input: {}, result: leaf }] };
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async () => cell,
    test.readable ? () => ({ status: 'settled', text: JSON.stringify({ result: leaf }) }) : undefined);
  try {
    const response = await (agent.tools![0] as RunnableTool).execute({ code: 'return suppliedSource;', selected_output: true }, { agent });
    const visible = JSON.parse(String(response.content));
    const receipt = visible.receipts[0].result;
    if (test.omitted) expect(receipt).toMatchObject({ sourceContentOmitted: true,
      original: { cell_id: 'source-boundary', call_id: 1 } });
    else expect(receipt.sourceContent).toEqual(test.source);
    expect(receipt.content).toEqual(content);
    expect(visible.value).toEqual({ copiedSource: test.source });
  } finally { await closeScriptModelSession(agent); }
});

it('rejects overlapping cells recoverably and separates cancellation request from completed cleanup', async () => {
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async (_code, caller, scope) => {
    signal = caller.abortSignal;
    await new Promise<void>(resolve => { finish = resolve; });
    return { cellId: scope.cellId, status: 'cancelled', receipts: [], hadToolErrors: false };
  });
  const exec = agent.tools!.find(tool => tool.name === 'script_exec') as RunnableTool;
  const wait = agent.tools!.find(tool => tool.name === 'script_wait') as RunnableTool;
  const first = JSON.parse(String((await exec.execute({ code: 'pending', yield_time_ms: 0 }, { agent })).content));
  expect(first).toMatchObject({ status: 'running', cleanupComplete: false });
  expect((await exec.execute({ code: 'overlap' }, { agent })).isError).toBe(true);
  expect((await wait.execute({ cell_id: first.cellId, cursor: -1, cancel: true }, { agent })).isError).toBe(true);
  expect(signal?.aborted).toBe(false);
  expect(JSON.parse(String((await wait.execute({ cell_id: first.cellId, cancel: true, yield_time_ms: 0 }, { agent })).content)))
    .toMatchObject({ status: 'cancelling', cleanupComplete: false });
  expect(signal?.aborted).toBe(true);
  finish();
  expect(JSON.parse(String((await wait.execute({ cell_id: first.cellId }, { agent })).content)))
    .toMatchObject({ status: 'cancelled', cleanupComplete: true });
  await closeScriptModelSession(agent);
});

it('returns one complete copy of an identical guest value and leaf result without losing actual call evidence', async () => {
  const leaf = { content: 'File written: generated.txt\n  (1 lines)', isError: false,
    metadata: { toolCall: { type: 'tool_use', id: 'leaf-1', name: 'write',
      input: { path: 'generated.txt', content: 'Computed at runtime, not a literal argument in the script.'.repeat(20) } },
      editRecoveryMessages: [], artifact: 'preserved-artifact' } };
  const cell: ScriptCellResult = { status: 'completed', hadToolErrors: false, value: structuredClone(leaf),
    receipts: [{ id: 1, name: 'write', input: { path: 'generated.txt' }, result: leaf }] };
  const original = structuredClone(cell);
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async () => cell);
  const output = await (agent.tools![0] as RunnableTool).execute({ code: 'return await tools.write(computedInput);' }, { agent });
  if (typeof output.content !== 'string') throw new Error('Expected text receipt');
  const visible = JSON.parse(output.content);
  expect(visible).not.toHaveProperty('value');
  expect(visible.value_from_receipt).toEqual({ id: 1, field: 'result' });
  expect(visible.receipts.find((receipt: { id: number }) => receipt.id === visible.value_from_receipt.id).result).toEqual(original.value);
  expect(visible.receipts[0].result).toEqual(leaf);
  expect(output.isError).toBe(false);
  expect(output.content.length).toBeLessThan(JSON.stringify({ ...cell, receipts: [{ id: 1, name: 'write', result: leaf }] }).length);
  expect(cell).toEqual(original);
});

it.each([false, true])('omits only derived receipt text with readable originals, preserving selected values and output (selected: %s)', async selected => {
  const text = 'Program data, not display framing.\n'.repeat(40);
  const leaf = { content: `     1\t${text}\n[Showing lines 3-4. Continue with offset=5]`,
    data: { kind: 'text' as const, text, normalized: true as const, offset: 3, line_offset: 0, lineCount: 2, complete: false,
      next: { offset: 5, limit: 2 } },
    metadata: { scriptModelContent: '[Showing lines 3-4. Continue with offset=5]', warning: 'Source remains incomplete' } };
  const cell: ScriptCellResult = { cellId: 'readable-data', status: 'completed', hadToolErrors: false,
    value: structuredClone(leaf), outputs: [text], receipts: [{ id: 1, name: 'read', input: { path: 'source.txt' }, result: leaf }] };
  const original = structuredClone(cell);
  const readOriginal = vi.fn(() => ({ status: 'settled', text: JSON.stringify({ result: leaf }) }));
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async () => cell, readOriginal);
  try {
    const entry = agent.tools!.find(tool => tool.name === 'script_exec') as RunnableTool;
    const response = await entry.execute({ code: 'return result;', selected_output: selected }, { agent });
    const visible = JSON.parse(String(response.content));
    expect(visible.receipts[0].result.data).toEqual({ kind: 'text', normalized: true, offset: 3, line_offset: 0, lineCount: 2,
      complete: false, next: { offset: 5, limit: 2 }, textOmitted: true, original: { cell_id: 'readable-data', call_id: 1 } });
    expect(visible.receipts[0].result.content).toBe(selected ? leaf.metadata.scriptModelContent : leaf.content);
    expect(visible.receipts[0].result.metadata.warning).toBe('Source remains incomplete');
    expect(visible.value.data).toEqual(leaf.data);
    expect(visible.outputs).toEqual([text]);
    expect(visible).not.toHaveProperty('value_from_receipt');
    const reader = agent.tools!.find(tool => tool.name === 'script_read') as RunnableTool;
    const page = JSON.parse(String((await reader.execute({ cell_id: 'readable-data', call_id: 1 }, { agent })).content));
    expect(JSON.parse(page.text).result).toEqual(leaf);
    expect(cell).toEqual(original);
  } finally { await closeScriptModelSession(agent); }
});

it.each([false, true])('keeps derived text when a usable original read path is unavailable (reader: %s)', async reader => {
  const leaf = { content: '     1\tOriginal text\n[End of file]',
    data: { kind: 'text' as const, text: 'Original text', normalized: true as const, offset: 1, line_offset: 0, lineCount: 1, complete: true },
    metadata: { scriptModelContent: '[End of file]' } };
  const cell: ScriptCellResult = { ...(reader ? {} : { cellId: 'no-reader' }), status: 'completed', hadToolErrors: false,
    receipts: [{ id: 1, name: 'read', input: {}, result: leaf }] };
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async () => cell,
    reader ? () => ({ result: leaf }) : undefined);
  try {
    const response = await (agent.tools![0] as RunnableTool).execute({ code: 'return null;', selected_output: true }, { agent });
    expect(JSON.parse(String(response.content)).receipts[0].result).toEqual(leaf);
  } finally { await closeScriptModelSession(agent); }
});

it('keeps error bodies and mandatory evidence when derived text has a complete original read path', async () => {
  const leaf = { content: '[Tool Error] source failed after partial text; WARNING retain original', isError: true,
    data: { kind: 'text' as const, text: 'partial text', normalized: true as const, offset: 7, line_offset: 0, lineCount: 1, complete: false,
      next: { offset: 8, limit: 1 } }, metadata: { scriptModelContent: 'Do not hide the error' } };
  const cell: ScriptCellResult = { cellId: 'error-data', status: 'failed', hadToolErrors: true, error: 'Source unavailable',
    value: { selected: 'partial text' }, receipts: [{ id: 1, name: 'read', input: {}, result: leaf }] };
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async () => cell, () => ({ result: leaf }));
  try {
    const response = await (agent.tools![0] as RunnableTool).execute({ code: 'return summary;', selected_output: true }, { agent });
    const visible = JSON.parse(String(response.content));
    expect(visible.receipts[0].result.content).toBe(leaf.content);
    expect(visible.receipts[0].result.data).toMatchObject({ complete: false, next: { offset: 8, limit: 1 }, textOmitted: true });
    expect(visible.value).toEqual({ selected: 'partial text' });
    expect(visible).toMatchObject({ status: 'failed', hadToolErrors: true, error: 'Source unavailable' });
    expect(response.isError).toBe(true);
  } finally { await closeScriptModelSession(agent); }
});

it.each([false, true])('omits displayed structured duplicates without changing opaque evidence or explicit values (selected: %s)', async selected => {
  const value = { points: Array.from({ length: 40 }, (_, index) => [index, index + 1]), units: 'source-defined' };
  const leaf = { content: `Opaque source warning: retain exactly.\nStructured content:\n${JSON.stringify(value)}`,
    data: { kind: 'json' as const, value }, metadata: { warning: 'Source is provisional' } };
  const cell: ScriptCellResult = { cellId: 'json-original', status: 'completed', hadToolErrors: false,
    value: structuredClone(leaf), outputs: [JSON.stringify(value)],
    receipts: [{ id: 1, name: 'geometry.sample-grid', input: { scale: 2 }, result: leaf }] };
  const original = structuredClone(cell);
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async () => cell,
    () => ({ status: 'settled', text: JSON.stringify({ result: leaf }) }));
  try {
    const response = await (agent.tools![0] as RunnableTool).execute({ code: 'return result;', selected_output: selected }, { agent });
    const visible = JSON.parse(String(response.content));
    expect(visible.receipts[0].result.data).toEqual({ kind: 'json', valueOmitted: true, original: { cell_id: 'json-original', call_id: 1 } });
    expect(visible.receipts[0].result.content).toBe(leaf.content);
    expect(visible.receipts[0].result.metadata).toEqual(leaf.metadata);
    expect(visible.value.data).toEqual(leaf.data);
    expect(visible.outputs).toEqual([JSON.stringify(value)]);
    expect(visible).not.toHaveProperty('value_from_receipt');
    const reader = agent.tools!.find(tool => tool.name === 'script_read') as RunnableTool;
    const page = JSON.parse(String((await reader.execute({ cell_id: 'json-original', call_id: 1 }, { agent })).content));
    expect(JSON.parse(page.text).result).toEqual(leaf);
    expect(cell).toEqual(original);
  } finally { await closeScriptModelSession(agent); }
});

it('keeps a small displayed JSON value instead of increasing bytes with an original reference', async () => {
  const leaf = { content: 'Structured content:\n0', data: { kind: 'json' as const, value: 0 } };
  const readOriginal = vi.fn(() => ({ result: leaf }));
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [],
    async () => ({ cellId: '84b24ad2-7e0f-4fb7-a395-5fe9a6c9ca70', status: 'completed', hadToolErrors: false,
      receipts: [{ id: 1, name: 'lookup', input: {}, result: leaf }] }), readOriginal);
  try {
    const response = await (agent.tools![0] as RunnableTool).execute({ code: 'return null;' }, { agent });
    const data = JSON.parse(String(response.content)).receipts[0].result.data;
    expect(data).toEqual({ kind: 'json', value: 0 });
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(Buffer.byteLength(JSON.stringify(leaf.data)));
    expect(readOriginal).not.toHaveBeenCalled();
  } finally { await closeScriptModelSession(agent); }
});

it.each([null, '', ' \t\n', { unseen: Array(80).fill(42) }])('retains structured values absent from the presented body (%j)', async value => {
  const leaf = { content: 'Opaque caveat only.', data: { kind: 'json' as const, value } };
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [],
    async () => ({ cellId: 'not-displayed', status: 'completed', hadToolErrors: false,
      receipts: [{ id: 1, name: 'lookup', input: {}, result: leaf }] }), () => ({ result: leaf }));
  try {
    const response = await (agent.tools![0] as RunnableTool).execute({ code: 'return null;', selected_output: true }, { agent });
    expect(JSON.parse(String(response.content)).receipts[0].result).toEqual(leaf);
  } finally { await closeScriptModelSession(agent); }
});

it.each([false, 0, [], [1, 'two'], 'source value'].map(value => ({ value })))(
  'keeps small scalar and array values directly without increasing receipt bytes ($value)', async ({ value }) => {
  const leaf = { content: `Structured content:\n${typeof value === 'string' ? value : JSON.stringify(value)}`, data: { kind: 'json' as const, value } };
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [],
    async () => ({ cellId: 'json-kinds', status: 'completed', hadToolErrors: false, value,
      receipts: [{ id: 1, name: 'lookup', input: {}, result: leaf }] }), () => ({ result: leaf }));
  try {
    const response = await (agent.tools![0] as RunnableTool).execute({ code: 'return sourceValue;', selected_output: true }, { agent });
    const visible = JSON.parse(String(response.content));
    expect(visible.receipts[0].result.data).toEqual(leaf.data);
    expect(Buffer.byteLength(JSON.stringify(visible.receipts[0].result.data))).toBeLessThanOrEqual(Buffer.byteLength(JSON.stringify(leaf.data)));
    expect(visible.value).toEqual(value);
    const reader = agent.tools!.find(tool => tool.name === 'script_read') as RunnableTool;
    expect(JSON.parse(String((await reader.execute({ cell_id: 'json-kinds', call_id: 1 }, { agent })).content)).result.data.value).toEqual(value);
  } finally { await closeScriptModelSession(agent); }
});

it.each([Array.from({ length: 100 }, (_, index) => index), 'source value '.repeat(80), '界'.repeat(30)].map(value => ({ value })))(
  'omits a displayed JSON value only when its original reference saves UTF-8 bytes ($value)', async ({ value }) => {
  const leaf = { content: `Structured content:\n${typeof value === 'string' ? value : JSON.stringify(value)}`, data: { kind: 'json' as const, value } };
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [],
    async () => ({ cellId: 'utf8-data', status: 'completed', hadToolErrors: false, value,
      receipts: [{ id: 1, name: 'lookup', input: {}, result: leaf }] }), () => ({ result: leaf }));
  try {
    const response = await (agent.tools![0] as RunnableTool).execute({ code: 'return sourceValue;', selected_output: true }, { agent });
    const visible = JSON.parse(String(response.content));
    expect(visible.receipts[0].result.data).toEqual({ kind: 'json', valueOmitted: true, original: { cell_id: 'utf8-data', call_id: 1 } });
    expect(Buffer.byteLength(JSON.stringify(visible.receipts[0].result.data))).toBeLessThan(Buffer.byteLength(JSON.stringify(leaf.data)));
    if (value === '界'.repeat(30)) expect(JSON.stringify(visible.receipts[0].result.data).length).toBeGreaterThan(JSON.stringify(leaf.data).length);
    expect(visible.value).toEqual(value);
    const reader = agent.tools!.find(tool => tool.name === 'script_read') as RunnableTool;
    expect(JSON.parse(String((await reader.execute({ cell_id: 'utf8-data', call_id: 1 }, { agent })).content)).result.data.value).toEqual(value);
  } finally { await closeScriptModelSession(agent); }
});

it('retains a structured duplicate when no original receipt reader exists', async () => {
  const value = { samples: Array(50).fill(3) };
  const leaf = { content: `Structured content:\n${JSON.stringify(value)}`, data: { kind: 'json' as const, value } };
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [],
    async () => ({ cellId: 'no-json-reader', status: 'completed', hadToolErrors: false,
      receipts: [{ id: 1, name: 'lookup', input: {}, result: leaf }] }));
  try {
    const response = await (agent.tools![0] as RunnableTool).execute({ code: 'return null;', selected_output: true }, { agent });
    expect(JSON.parse(String(response.content)).receipts[0].result).toEqual(leaf);
  } finally { await closeScriptModelSession(agent); }
});

it('keeps multimodal error evidence intact alongside structured original references', async () => {
  const image = { type: 'image', path: '/source-evidence.png', mediaType: 'image/png' } as const;
  const value = { partial: Array(60).fill(true) };
  const leaf = { content: [{ type: 'text', text: 'Source warning: partial failure.' }, image,
    { type: 'text', text: `Structured content:\n${JSON.stringify(value)}` }] as const, isError: true,
    data: { kind: 'json' as const, value } };
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [],
    async () => ({ cellId: 'json-image-error', status: 'failed', error: 'Source failed', hadToolErrors: true,
      receipts: [{ id: 1, name: 'lookup', input: {}, result: leaf }] }), () => ({ result: leaf }));
  try {
    const response = await (agent.tools![0] as RunnableTool).execute({ code: 'return null;', selected_output: true }, { agent });
    if (typeof response.content === 'string') throw new Error('Image evidence must remain typed');
    const text = response.content.find(item => item.type === 'text');
    if (text?.type !== 'text') throw new Error('Missing result presentation');
    const visible = JSON.parse(text.text);
    expect(visible.receipts[0].result.content).toEqual(leaf.content);
    expect(visible.receipts[0].result.data).toMatchObject({ kind: 'json', valueOmitted: true });
    expect(response.content.filter(item => item.type === 'image')).toEqual([image]);
    expect(response.isError).toBe(true);
    expect(visible).toMatchObject({ status: 'failed', error: 'Source failed', hadToolErrors: true });
  } finally { await closeScriptModelSession(agent); }
});

it('keeps a tiny selected text body hidden even when a reference costs more bytes', async () => {
  const leaf = { content: '     1\tX\n[End of file]',
    data: { kind: 'text' as const, text: 'X', normalized: true as const, offset: 1, line_offset: 0, lineCount: 1, complete: true },
    metadata: { scriptModelContent: '[End of file]' } };
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [],
    async () => ({ cellId: 'small-hidden-text', status: 'completed', hadToolErrors: false, value: 1,
      receipts: [{ id: 1, name: 'read', input: {}, result: leaf }] }), () => ({ result: leaf }));
  try {
    const response = await (agent.tools![0] as RunnableTool).execute({ code: 'return 1;', selected_output: true }, { agent });
    const visible = JSON.parse(String(response.content));
    expect(visible.receipts[0].result.content).toBe('[End of file]');
    expect(visible.receipts[0].result.data).not.toHaveProperty('text');
    expect(visible.receipts[0].result.data.textOmitted).toBe(true);
  } finally { await closeScriptModelSession(agent); }
});

it('shares an identical top-level output field while retaining independent return data and failure evidence', async () => {
  const content = 'Test run: 11 passed; exact stdout evidence.\n'.repeat(60);
  const cell: ScriptCellResult = { status: 'failed', error: 'later call failed', hadToolErrors: true,
    value: { output: content, summary: '11 tests passed before the failure', count: 11 },
    receipts: [
      { id: 3, name: 'bash', input: { command: 'node check.mjs' }, result: { content, isError: false } },
      { id: 4, name: 'write', input: { path: 'blocked.txt' }, result: { content: '[Tool Error] denied', isError: true } },
    ] };
  const original = structuredClone(cell);
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async () => cell);
  const output = await (agent.tools![0] as RunnableTool).execute({ code: 'return {output: result.content, summary, count};' }, { agent });
  if (typeof output.content !== 'string') throw new Error('Expected text receipt');
  const visible = JSON.parse(output.content);
  expect(visible.value).toEqual({ summary: '11 tests passed before the failure', count: 11 });
  expect(visible.value_fields_from_receipts).toEqual({ output: { id: 3, field: 'content' } });
  expect({ ...visible.value, output: visible.receipts[0].result.content }).toEqual(original.value);
  expect(visible.receipts[1].result).toEqual(original.receipts[1]!.result);
  expect(visible).toMatchObject({ status: 'failed', error: 'later call failed', hadToolErrors: true });
  expect(output.isError).toBe(true);
  expect(cell).toEqual(original);
});

it.each([undefined, null, 42, '', 'ok', { output: 'ok' }, { nested: { output: 'ok' } }, ['ok']])(
  'preserves small, independent or nested return values (%j) without adding a larger reference', async value => {
    const cell: ScriptCellResult = { status: 'completed', hadToolErrors: false, value,
      receipts: [{ id: 1, name: 'read', input: {}, result: { content: 'ok' } }] };
    const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async () => cell);
    const output = await (agent.tools![0] as RunnableTool).execute({ code: 'return value;' }, { agent });
    expect(output.content).toBe(JSON.stringify({ ...cell, receipts: [{ id: 1, name: 'read', result: { content: 'ok' } }] }));
  });

it('does not confuse a similar return result with an original receipt carrying different warnings or parameters', async () => {
  const leaf = { content: 'Evidence '.repeat(100), metadata: { warning: 'partial', toolCall: {
    name: 'write', input: { path: 'actual.txt', content: 'canonical content' } } } };
  const value = { ...leaf, metadata: { warning: 'different', toolCall: {
    name: 'write', input: { path: 'requested.txt', content: 'requested content' } } } };
  const cell: ScriptCellResult = { status: 'completed', hadToolErrors: false, value,
    receipts: [{ id: 2, name: 'write', input: {}, result: leaf }] };
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async () => cell);
  const output = await (agent.tools![0] as RunnableTool).execute({ code: 'return result;' }, { agent });
  if (typeof output.content !== 'string') throw new Error('Expected text receipt');
  const visible = JSON.parse(output.content);
  expect(visible).not.toHaveProperty('value_from_receipt');
  // Only the exactly shared content is eligible; independent metadata must remain.
  expect(visible.value.metadata).toEqual(value.metadata);
  expect(visible.receipts[0].result).toEqual(leaf);
});

it.each(['failed', 'cancelled', 'timed_out'] as const)('keeps %s status and all effect/continuation evidence in a referenced result', async status => {
  const leaf = { content: '[SOURCE_INCOMPLETE scan_offset=20] '.repeat(30), isError: true,
    metadata: { toolCall: { type: 'tool_use', id: 'canonical', name: 'edit', input: { path: 'actual.txt', edits: [] } },
      editRecoveryMessages: ['Use the current unique anchor'], artifact: 'artifact-1', partialEffects: true } };
  const cell: ScriptCellResult = { status, error: 'Stop; inspect settled effects', hadToolErrors: true,
    value: structuredClone(leaf), receipts: [
      { id: 4, name: 'edit', input: {}, result: leaf },
      { id: 5, name: 'edit', input: {}, result: structuredClone(leaf) },
    ] };
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async () => cell);
  const output = await (agent.tools![0] as RunnableTool).execute({ code: 'return result;' }, { agent });
  if (typeof output.content !== 'string') throw new Error('Expected text receipt');
  const visible = JSON.parse(output.content);
  expect(visible.value_from_receipt).toEqual({ id: 4, field: 'result' });
  expect(visible.receipts.map((receipt: { result: unknown }) => receipt.result)).toEqual([leaf, leaf]);
  expect(visible).toMatchObject({ status, error: cell.error, hadToolErrors: true });
  expect(output.isError).toBe(true);
  expect(output.metadata?.cancelled).toBe(status === 'cancelled' ? true : undefined);
});

it('keeps native shell available for background execution outside the foreground-only Script cell', () => {
  const tools = ['read', 'bash', 'undo'].map(name => getToolDefinition(name)!);
  const agent = withScriptModelTool({ name: 'worker', instructions: '', tools }, { backups: new Map() }, tools.slice(0, 2),
    async () => ({ status: 'completed', receipts: [], hadToolErrors: false }));
  const visible = projectScriptModelTools(agent, agent.tools!);
  expect(visible.map(tool => tool.name)).toEqual(['bash', 'undo', 'script_exec', 'script_wait']);
  expect(visible[0]).toEqual(tools[1]);
});

it('keeps native image receipts multimodal without treating guest-returned paths as trusted images', async () => {
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async () => ({
    status: 'completed', hadToolErrors: false, value: { type: 'image', path: 'untrusted.png' },
    receipts: [{ id: 1, name: 'read', input: { path: 'trusted.png' }, result: {
      content: [{ type: 'text', text: 'Actual image' }, { type: 'image', path: 'trusted.png', mediaType: 'image/png' }],
    } }],
  }));
  const tool = agent.tools?.find(tool => tool.name === 'script_exec') as RunnableTool;
  const result = await tool.execute({ code: 'return {};' }, { agent });
  expect(Array.isArray(result.content)).toBe(true);
  if (typeof result.content === 'string') throw new Error('Images must remain typed');
  expect(result.content.filter(block => block.type === 'image')).toEqual([{ type: 'image', path: 'trusted.png', mediaType: 'image/png' }]);
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"name":"read"') });
  expect(result.metadata?.scriptReadPaths).toEqual(['trusted.png']);
});

it('closes the parent model binding after a host persistence failure but permits invalid argument correction', async () => {
  const run = vi.fn(async () => { throw new Error('receipt persistence failed'); });
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], run);
  const tool = agent.tools![0] as RunnableTool;
  expect((await tool.execute({ code: 1 }, { agent })).isError).toBe(true);
  expect(run).not.toHaveBeenCalled();
  await expect(tool.execute({ code: 'return 1' }, { agent })).rejects.toThrow('receipt persistence failed');
  expect((await tool.execute({ code: 'return 2' }, { agent })).content).toContain('Script closed');
  expect(run).toHaveBeenCalledTimes(1);
});

it('does not advertise an uncallable bridge when Script contracts exceed a small context envelope', () => {
  const native = ['tool_call', 'tool_search', 'tool_describe'].map(name => getToolDefinition(name)!);
  const script = { name: 'script_exec', description: 'Complete callable leaf schema '.repeat(2000),
    input_schema: { type: 'object' as const, properties: { code: { type: 'string' } } } };
  const fitted = fitToolSchemasToContext([...native, script], { contextWindow: 8192, reservedResponseTokens: 1000, systemTokens: 700 });
  expect(fitted).toContainEqual(script);
  expect(fitted.find(tool => tool.name === 'tool_describe')?.description).not.toContain('script_exec');
});

it('recognizes paged read only when a real Script read binding is in the presented menu', () => {
  const worker = { name: 'worker', instructions: '', tools: [getToolDefinition('read')!] };
  const script = withScriptModelTool(worker, { backups: new Map() }, worker.tools, async () => ({ status: 'completed', receipts: [], hadToolErrors: false }));
  const menu = projectScriptModelTools(script, script.tools!);
  expect(menu.map(tool => tool.name)).toEqual(['script_exec', 'script_wait']);
  expect(canReadWithModelTools(script, menu)).toBe(true);
  expect(canReadWithModelTools(script, [])).toBe(false);
  expect(canReadWithModelTools(worker, menu)).toBe(false);
  expect(canReadWithModelTools(worker, worker.tools)).toBe(true);
});

it('exposes structured leaf contracts only behind the unchanged visible Script entry', () => {
  const leaves = [{ ...getToolDefinition('read')!, input_schema: structuredClone(getToolDefinition('read')!.input_schema) }];
  const worker = { name: 'worker', instructions: '', tools: leaves };
  const script = withScriptModelTool(worker, { backups: new Map() }, leaves,
    async () => ({ status: 'completed', receipts: [], hadToolErrors: false }));
  const menu = projectScriptModelTools(script, script.tools!);
  const bound = getScriptModelContracts(script, menu)!;
  expect(bound.leaves).toEqual(leaves);
  expect(bound.entry.description).toBe(buildScriptModelDescription(bound.leaves));
  expect(getScriptModelContracts(worker, menu)).toBeUndefined();
  expect(getScriptModelContracts(script, [])).toBeUndefined();
  const replaced = [{ ...menu[0]!, description: 'Host custom script entry' }];
  expect(getScriptModelContracts(script, replaced)).toBeUndefined();
  expect(canReadWithModelTools(script, replaced)).toBe(false);
  const withoutEntry = script.tools!.filter(tool => tool.name !== 'script_exec');
  expect(projectScriptModelTools(script, withoutEntry)).toBe(withoutEntry);
  leaves[0]!.description = 'Mutation after binding';
  expect(getScriptModelContracts(script, menu)!.leaves[0]!.description).toBe(getToolDefinition('read')!.description);
});

it('pairs each unchanged leaf schema with its exact executable namespace path', () => {
  const leaves = ['lookup_record', 'inventory.lookup-v2', '读取', 'default', 'quote"name'].map(name => ({
    name, description: 'An authorized generic lookup.',
    input_schema: { type: 'object' as const, properties: { key: { type: 'string' } }, required: ['key'] },
  }));
  const original = structuredClone(leaves);
  const description = buildScriptModelDescription(leaves);
  for (const leaf of leaves) {
    expect(description).toContain(`tools[${JSON.stringify(leaf.name)}](input): ${JSON.stringify(leaf)}`);
  }
  expect(leaves).toEqual(original);
  expect(description).not.toContain('unlisted_tool');
});

it('retains native evidence including warnings that are only encoded in the body', async () => {
  const agent = withScriptModelTool({ name: 'worker', instructions: '' }, { backups: new Map() }, [], async () => ({
    status: 'completed', hadToolErrors: true, value: { selected: 'useful evidence' },
    receipts: [
      { id: 1, name: 'grep', input: { pattern: 'value' }, result: { content: '[SOURCE_INCOMPLETE: continue with scan_offset=20]' } },
      { id: 2, name: 'edit', input: { path: 'file.ts' }, result: { content: 'unique anchor not found', isError: true } },
      { id: 3, name: 'web_fetch', input: { url: 'https://fixture.invalid' }, result: { content: 'HTTP 503 non-success status' } },
    ],
  }));
  const result = await (agent.tools![0] as RunnableTool).execute({ code: 'return {}' }, { agent });
  expect(result.content).toContain('useful evidence');
  expect(result.content).toContain('unique anchor not found');
  expect(result.content).toContain('SOURCE_INCOMPLETE');
  expect(result.content).toContain('HTTP 503');
  expect(result.isError).toBe(true);
});
