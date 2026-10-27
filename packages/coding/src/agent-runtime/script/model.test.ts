import { expect, it, vi } from 'vitest';
import type { RunnableTool } from '@kodax-ai/agent';
import { withScriptModelTool, canReadWithModelTools, projectScriptModelTools, getScriptModelContracts, buildScriptModelDescription } from './model.js';
import { fitToolSchemasToContext } from '../tool-exposure-planner.js';
import { getToolDefinition } from '../../tools/index.js';
import type { ScriptCellResult } from './cell.js';

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
  expect(visible.map(tool => tool.name)).toEqual(['bash', 'undo', 'script_exec']);
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
  expect(menu.map(tool => tool.name)).toEqual(['script_exec']);
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
