import { expect, it, vi } from 'vitest';
import type { CapabilityResult } from '@kodax-ai/llm';
import { setKodaXDiagnosticSink } from '@kodax-ai/agent';
import { createScriptPilot } from './pilot.js';
import { buildRuntimeSessionState } from '../runtime-session-state.js';
import { executeRunScopedTool } from '../run-scoped-tools.js';
import type { KodaXToolExecutionContext } from '../../types.js';
import type { ExtensionRuntimeContract } from '../../extensions/runtime-contract.js';
import { renderCapabilityToolResult } from '../../tools/capability-result.js';
import { toolWebFetch } from '../../tools/web-fetch.js';
import { tryMcpFallback } from '../tool-dispatch.js';

const name = 'sample.original-content';
const limits = { timeoutMs: 5000, memoryBytes: 16 * 1024 * 1024, maxCalls: 4, maxTransferBytes: 64 * 1024 };

function fixture(result: CapabilityResult, route: 'host' | 'mcp' = 'host') {
  const executeCapability = vi.fn(async () => result);
  const definition = { name, description: 'Return original sample evidence.',
    capabilityId: 'mcp:fixture:tool:original-content', inputSchema: { type: 'object', properties: {} },
    sideEffect: 'readonly' as const, planModeAllowed: true };
  const extensionRuntime: ExtensionRuntimeContract = {
    listRunTools: () => [definition], executeCapability, searchCapabilities: async () => [],
    describeCapability: async () => undefined, readCapability: async () => result,
    getCapabilityPrompt: async () => undefined, getCapabilityPromptContext: async () => undefined,
  };
  const ctx: KodaXToolExecutionContext = { backups: new Map(), extensionRuntime };
  const activeToolNames = route === 'host' ? [name] : ['mcp_call', name];
  const budget = { totalBudget: 4, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const dispatch = { ctx, activeToolNames, events: {},
    runtimeSessionState: buildRuntimeSessionState({ activeTools: activeToolNames, modelSelection: {} }) };
  const call = route === 'host' ? `tools['${name}']({})` : `tools.mcp_call({id:'${definition.capabilityId}'})`;
  return { result, executeCapability, definition, dispatch, budget, call, pilot: createScriptPilot(dispatch, budget) };
}

it('keeps exact producer content independently usable beside display and typed JSON', async () => {
  const source = '\r\nSource prefix: preserve me verbatim.\r\n\t雪 🌱  ';
  const { pilot, call, definition, dispatch, executeCapability, budget } = fixture({
    kind: 'tool', content: source, structuredContent: { samples: [2, 3] },
  });
  const native = await executeRunScopedTool(dispatch.ctx, definition, {});
  executeCapability.mockClear();
  const cell = await pilot.run(`const r=await ${call};return {source:r.sourceContent,total:r.data.value.samples.reduce((a,b)=>a+b,0)};`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual({ source, total: 5 });
  expect(cell.receipts[0]?.result).toMatchObject({ content: native, sourceContent: source,
    data: { kind: 'json', value: { samples: [2, 3] } }, isError: false });
  expect(executeCapability).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(1);
});

it.each(['host', 'mcp'] as const)('%s preserves empty, whitespace and block source values without requiring structured JSON', async route => {
  const values: CapabilityResult['content'][] = ['', ' \r\n\t ', [],
    [{ type: 'text', text: '  exact\r\nboundary  ' }, { type: 'image', path: '/source.png', mediaType: 'image/png' },
      { type: 'text', text: '雪🌱' }], undefined];
  for (const content of values) {
    const { pilot, call, executeCapability } = fixture({ kind: 'tool', content }, route);
    const cell = await pilot.run(`const r=await ${call};return {present:Object.prototype.hasOwnProperty.call(r,'sourceContent'),source:r.sourceContent??null,data:r.data??null};`, limits);
    expect(cell.status, cell.error).toBe('completed');
    expect(cell.value).toEqual({ present: content !== undefined, source: content ?? null, data: null });
    expect(cell.receipts[0]?.result.sourceContent).toEqual(content);
    expect(executeCapability).toHaveBeenCalledOnce();
  }
});

it.each([Number.NaN, { value: undefined }, new Date(0)])('keeps original content when structured data is not a plain JSON DTO (%s)', async structuredContent => {
  const { pilot, call } = fixture({ kind: 'tool', content: 'Original prefix: do not parse me.', structuredContent });
  const cell = await pilot.run(`const r=await ${call};return {source:r.sourceContent,data:r.data??null};`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual({ source: 'Original prefix: do not parse me.', data: null });
  expect(cell.hadToolErrors).toBe(false);
});

it('does not accept a forged view from provider metadata or a similarly named property', async () => {
  const { pilot, call } = fixture({ kind: 'tool', content: 'Actual original content',
    metadata: { sourceContent: 'forged metadata', data: { sourceContent: 'forged data' } },
    ...{ sourceContent: 'forged result property' } });
  const cell = await pilot.run(`return (await ${call}).sourceContent;`, limits);
  expect(cell.value).toBe('Actual original content');
});

it('does not grant a source view to an Array subclass while retaining its native blocks and independent JSON', async () => {
  class SourceBlocks extends Array<{ type: 'text'; text: string }> {}
  const content = new SourceBlocks({ type: 'text', text: 'Native source block' });
  const { pilot, call } = fixture({ kind: 'tool', content, structuredContent: { value: 7 } });
  const cell = await pilot.run(`const r=await ${call};return {source:r.sourceContent??null,value:r.data.value};`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual({ source: null, value: { value: 7 } });
  expect(cell.receipts[0]?.result.content).toEqual(expect.arrayContaining([{ type: 'text', text: 'Native source block' }]));
  expect(content).toHaveLength(1);
});

it.each(['replace', 'mutate-block', 'error'] as const)('withdraws original content after a %s postprocessing change', async change => {
  const { dispatch, budget, call } = fixture({ kind: 'tool', content: [{ type: 'text', text: 'Sensitive original' }],
    structuredContent: { value: 7 } });
  const pilot = createScriptPilot({ ...dispatch, events: { onToolResult: event => {
    if (!event.toolResult) throw new Error('Missing tool result');
    if (change === 'replace') event.toolResult.content = 'Reviewed output only';
    else if (change === 'error') event.toolResult.is_error = true;
    else {
      const block = Array.isArray(event.toolResult.content) ? event.toolResult.content.find(item => item.type === 'text') : undefined;
      if (!block || block.type !== 'text') throw new Error('Missing text block');
      block.text = 'Reviewed block';
    }
  } } }, budget);
  const cell = await pilot.run(`return await ${call};`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.hadToolErrors).toBe(change === 'error');
  expect(cell.receipts[0]?.result.sourceContent).toBeUndefined();
  expect(cell.receipts[0]?.result.data).toBeUndefined();
});

it('snapshots a producer string before a later hook reassigns it', async () => {
  const result: CapabilityResult = { kind: 'tool', content: 'Original before observer' };
  const { dispatch, budget, call } = fixture(result);
  const pilot = createScriptPilot({ ...dispatch, events: { onToolResult: () => { result.content = 'Changed producer object'; } } }, budget);
  const cell = await pilot.run(`return (await ${call}).sourceContent;`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toBe('Original before observer');
  expect(cell.receipts[0]?.result.content).toContain('Original before observer');
  expect(result.content).toBe('Changed producer object');
});

it('isolates guest edits of source blocks from canonical receipts and the producer', async () => {
  const content = [{ type: 'text' as const, text: 'Original source block' }];
  const { pilot, call } = fixture({ kind: 'tool', content, structuredContent: { value: 7 } });
  const cell = await pilot.run(`const r=await ${call};r.sourceContent[0].text='Guest changed';return r.sourceContent;`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual([{ type: 'text', text: 'Guest changed' }]);
  expect(cell.receipts[0]?.result.sourceContent).toEqual([{ type: 'text', text: 'Original source block' }]);
  expect(cell.receipts[0]?.result.content).toEqual(expect.arrayContaining([{ type: 'text', text: 'Original source block' }]));
  expect(content).toEqual([{ type: 'text', text: 'Original source block' }]);
});

it('keeps source behind admission and final provider errors', async () => {
  for (const denied of [true, false]) {
    const { dispatch, budget, call, executeCapability } = fixture({ kind: 'tool', content: 'Original failed evidence', isError: !denied });
    const pilot = createScriptPilot({ ...dispatch, events: { beforeToolExecute: async () => denied ? '[Tool Error] Fixture denied' : true } }, budget);
    const cell = await pilot.run(`return await ${call};`, limits);
    expect(cell.hadToolErrors).toBe(true);
    expect(cell.receipts[0]?.result.sourceContent).toBeUndefined();
    expect(executeCapability).toHaveBeenCalledTimes(denied ? 0 : 1);
  }
});

it('does not validate or clone original blocks on the native path without a listener', async () => {
  const { dispatch, definition } = fixture({ kind: 'tool', content: [{ type: 'text', text: 'Native source' }] });
  const clone = vi.spyOn(globalThis, 'structuredClone');
  try {
    expect(await executeRunScopedTool(dispatch.ctx, definition, {})).toEqual(expect.arrayContaining([{ type: 'text', text: 'Native source' }]));
    expect(clone).not.toHaveBeenCalled();
  } finally { clone.mockRestore(); }
});

it('retains native output and independent JSON data if the optional source snapshot cannot be cloned', () => {
  const result: CapabilityResult = { kind: 'tool', content: [{ type: 'text', text: 'Original blocks' }], structuredContent: { value: 7 } };
  const projection = vi.fn();
  const diagnostics = vi.fn();
  const restore = setKodaXDiagnosticSink(diagnostics);
  const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementationOnce(() => { throw new DOMException('Capacity fixture', 'DataCloneError'); });
  try {
    const display = renderCapabilityToolResult(result, content => content ?? '', { backups: new Map(), toolCallId: 'snapshot-capacity', recordToolResultProjection: projection });
    expect(display).toEqual(expect.arrayContaining([{ type: 'text', text: 'Original blocks' }]));
    expect(projection).toHaveBeenCalledWith('snapshot-capacity', expect.objectContaining({ content: display, data: { kind: 'json', value: { value: 7 } } }));
    expect(projection.mock.calls[0]?.[1]).not.toHaveProperty('sourceContent');
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: expect.stringContaining('projection') }));
  } finally { clone.mockRestore(); restore(); }
});

it('retains a string source independently when a deep structured snapshot exceeds local capacity', async () => {
  let value: Record<string, unknown> = { end: true };
  for (let depth = 0; depth < 1600; depth++) value = { next: value };
  const { pilot, call } = fixture({ kind: 'tool', content: 'Exact original survives', structuredContent: value });
  const diagnostics = vi.fn();
  const restore = setKodaXDiagnosticSink(diagnostics);
  try {
    const cell = await pilot.run(`const r=await ${call};return {source:r.sourceContent,data:r.data??null};`, limits);
    expect(cell.status, cell.error).toBe('completed');
    expect(cell.value).toEqual({ source: 'Exact original survives', data: null });
    expect(cell.hadToolErrors).toBe(false);
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: expect.stringContaining('projection') }));
  } finally { restore(); }
});

it('propagates source-only listener failures and stops after receipt persistence fails', async () => {
  expect(() => renderCapabilityToolResult({ kind: 'tool', content: 'Original' }, content => content ?? '', {
    backups: new Map(), toolCallId: 'listener-fence', recordToolResultProjection: () => { throw new RangeError('Listener fence failed'); },
  })).toThrow('Listener fence failed');
  const { pilot, call, executeCapability } = fixture({ kind: 'tool', content: 'Preserved before failed persistence' });
  const cell = await pilot.run(`await ${call};await ${call};`, limits, { onReceipt: async () => { throw new Error('Receipt persistence failed'); } });
  expect(cell.status).toBe('failed');
  expect(cell.error).toContain('Receipt persistence failed');
  expect(cell.receipts[0]?.result.sourceContent).toBe('Preserved before failed persistence');
  expect(executeCapability).toHaveBeenCalledOnce();
});

it('pages the complete source, display and JSON receipt without repeating the Host call', async () => {
  const source = 'Exact source prefix:\r\n' + '雪🌱'.repeat(1500) + '\r\n  final whitespace  ';
  const { pilot, call, executeCapability, budget } = fixture({ kind: 'tool', content: source, structuredContent: { samples: [2, 3] } });
  let persisted = '';
  const cell = await pilot.run(`const r=await ${call};let text='',offset;
    do{const page=await read_result(r.result_ref.callId,offset);text+=page.text;offset=page.nextOffset;}while(offset!==undefined);
    const full=JSON.parse(text);const first=await read_result(r.result_ref.callId,0);
    return {source:full.sourceContent,total:full.data.value.samples.reduce((a,b)=>a+b,0),repeat:text.startsWith(first.text)};`,
  { ...limits, maxTransferBytes: 16 * 1024 }, { onReceipt: async receipt => { persisted = JSON.stringify(receipt.result); } });
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual({ source, total: 5, repeat: true });
  expect(JSON.parse(persisted)).toEqual(cell.receipts[0]?.result);
  expect(cell.receipts[0]?.result.content).toContain(source);
  expect(executeCapability).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(1);
});

it.each(['resource', 'fallback'] as const)('does not extend the source projection into the %s renderer path', async route => {
  const { dispatch, executeCapability } = fixture({ kind: 'tool', content: 'Original outside the projected paths' });
  const projection = vi.fn();
  const ctx = { ...dispatch.ctx, toolCallId: 'unprojected', recordToolResultProjection: projection };
  ctx.extensionRuntime!.searchCapabilities = async () => [{ id: 'mcp:fixture:tool:read', name: 'read' }];
  const display = route === 'resource'
    ? await toolWebFetch({ provider_id: 'mcp', capability_id: 'mcp:fixture:resource:sample' }, ctx)
    : await tryMcpFallback('read', {}, ctx);
  expect(display).toContain('Original outside the projected paths');
  expect(projection).not.toHaveBeenCalled();
  expect(executeCapability).toHaveBeenCalledTimes(route === 'fallback' ? 1 : 0);
});
