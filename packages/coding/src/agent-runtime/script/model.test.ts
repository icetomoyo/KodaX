import { expect, it, vi } from 'vitest';
import type { RunnableTool } from '@kodax-ai/agent';
import { withScriptModelTool, canReadWithModelTools, projectScriptModelTools } from './model.js';
import { fitToolSchemasToContext } from '../tool-exposure-planner.js';
import { getToolDefinition } from '../../tools/index.js';

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
