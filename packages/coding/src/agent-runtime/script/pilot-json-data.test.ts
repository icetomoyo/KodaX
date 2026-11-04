import { expect, it, vi } from 'vitest';
import { setKodaXDiagnosticSink } from '@kodax-ai/agent';
import type { CapabilityResult } from '@kodax-ai/llm';
import { createScriptPilot } from './pilot.js';
import { buildRuntimeSessionState } from '../runtime-session-state.js';
import { executeRunScopedTool } from '../run-scoped-tools.js';
import type { KodaXToolExecutionContext } from '../../types.js';

const limits = { timeoutMs: 5000, memoryBytes: 16 * 1024 * 1024, maxCalls: 4, maxTransferBytes: 64 * 1024 };
const name = 'geometry.sample-grid';
function fixture(result: CapabilityResult, route: 'host' | 'mcp' = 'host') {
  const executeCapability = vi.fn(async () => result);
  const definition = { name, description: 'Returns a measured grid.', inputSchema: { type: 'object', properties: {} },
    capabilityId: 'mcp:fixture:tool:sample-grid', sideEffect: 'readonly', planModeAllowed: true };
  const ctx = { backups: new Map(), extensionRuntime: {
    listRunTools: () => [definition], executeCapability,
  } } as unknown as KodaXToolExecutionContext;
  const budget = { totalBudget: 4, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const activeToolNames = route === 'host' ? [name] : ['mcp_call', name];
  const dispatch = { ctx, activeToolNames, events: {},
    runtimeSessionState: buildRuntimeSessionState({ activeTools: activeToolNames, modelSelection: {} }) };
  const call = route === 'host' ? `tools['${name}']({})` : `tools.mcp_call({id:'${definition.capabilityId}'})`;
  return { executeCapability, budget, dispatch, definition, call, pilot: createScriptPilot(dispatch, budget) };
}

it('computes directly from original structured Host data while retaining opaque warnings', async () => {
  const structuredContent = { axes: ['x', 'y'], samples: [[2, 3], [5, 7]], optional: null, exact: true };
  const { pilot, executeCapability, budget } = fixture({ kind: 'tool', content: 'WARNING: measurements are provisional',
    structuredContent, metadata: { source: 'calibrated-fixture' } });
  const cell = await pilot.run(`const r=await tools['${name}']({});
    return {sum:r.data.value.samples.flat().reduce((a,b)=>a+b,0),optional:r.data.value.optional};`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual({ sum: 17, optional: null });
  expect(cell.receipts[0]?.result.data).toEqual({ kind: 'json', value: structuredContent });
  expect(cell.receipts[0]?.result.content).toContain('WARNING: measurements are provisional');
  expect(cell.receipts[0]?.result.content).toContain('calibrated-fixture');
  expect(cell.receipts[0]?.result.metadata).not.toHaveProperty('scriptModelContent');
  expect(executeCapability).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(1);
});

it.each(['host', 'mcp'] as const)('%s preserves arrays and every JSON scalar including explicit null', async route => {
  for (const value of [[null, '雪', { scale: 0.5 }], 0, false, '', null, '123', true]) {
    const { pilot, call, executeCapability } = fixture({ kind: 'tool', structuredContent: value }, route);
    const cell = await pilot.run(`return (await ${call}).data;`, limits);
    expect(cell.status, cell.error).toBe('completed');
    expect(cell.hadToolErrors, JSON.stringify(cell.receipts)).toBe(false);
    expect(cell.value).toEqual({ kind: 'json', value });
    expect(executeCapability).toHaveBeenCalledOnce();
  }
});

it.each([
  ['undefined', undefined], ['non-finite', Number.NaN], ['undefined member', { value: undefined }],
  ['undefined array member', [undefined]], ['sparse array', Array(1)], ['date', new Date(0)],
  ['symbol member', { [Symbol('unserializable')]: 1 }], ['accessor', { get value() { return 7; } }],
  ['proxy', new Proxy({ value: 7 }, {})],
])('does not grant JSON data to %s while retaining its existing native display', async (_label, value) => {
  const { pilot, executeCapability } = fixture({ kind: 'tool', content: 'WARNING: original provider evidence', structuredContent: value });
  const cell = await pilot.run(`return await tools['${name}']({});`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.hadToolErrors).toBe(false);
  expect(cell.receipts[0]?.result.content).toContain('WARNING: original provider evidence');
  expect(cell.receipts[0]?.result.data).toBeUndefined();
  expect(executeCapability).toHaveBeenCalledOnce();
});

it('retains an Array subclass native serializer without granting a conflicting ordinary JSON projection', async () => {
  class ScaledSeries extends Array<number> {
    toJSON(): number[] { return Array.from(this, value => value * 100); }
  }
  const value = new ScaledSeries(1, 2);
  const { pilot, dispatch, definition, executeCapability } = fixture({ kind: 'tool', structuredContent: value,
    content: 'WARNING: custom provider representation' });
  const native = await executeRunScopedTool(dispatch.ctx, { ...definition, sideEffect: 'readonly' }, {});
  expect(native).toContain('[100,200]');
  executeCapability.mockClear();
  const cell = await pilot.run(`return await tools['${name}']({});`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.hadToolErrors).toBe(false);
  expect(cell.receipts[0]?.result.content).toBe(native);
  expect(cell.receipts[0]?.result.data).toBeUndefined();
  expect(executeCapability).toHaveBeenCalledOnce();
});

it('does not interpret provider metadata or JSON-looking content as trusted program data', async () => {
  const { pilot } = fixture({ kind: 'tool', content: '{"samples":[2,3]}\nWARNING: incomplete',
    metadata: { data: { kind: 'json', value: { samples: [99] } }, scriptModelContent: 'safe' } });
  const cell = await pilot.run(`return await tools['${name}']({});`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.receipts[0]?.result.content).toContain('WARNING: incomplete');
  expect(cell.receipts[0]?.result.data).toBeUndefined();
  expect(cell.receipts[0]?.result.metadata).not.toHaveProperty('scriptModelContent');
});

it('snapshots original structured values before later observers mutate the Host object', async () => {
  const value = { samples: [2, 3] };
  const { dispatch, budget } = fixture({ kind: 'tool', content: 'WARNING: original', structuredContent: value });
  const pilot = createScriptPilot({ ...dispatch, events: { onToolResult: () => { value.samples[0] = 99; } } }, budget);
  const cell = await pilot.run(`return (await tools['${name}']({})).data.value.samples;`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual([2, 3]);
  expect(value.samples).toEqual([99, 3]);
  expect(cell.receipts[0]?.result.content).toContain('"samples":[2,3]');
});

it.each(['replace', 'mutate-block', 'error'] as const)('withholds JSON data after a %s postprocessing change', async change => {
  const image = { type: 'image' as const, path: '/source.png', mediaType: 'image/png' };
  const { dispatch, budget } = fixture({ kind: 'tool', content: [{ type: 'text', text: 'WARNING: initial' }, image],
    structuredContent: { samples: [2, 3] } });
  const pilot = createScriptPilot({ ...dispatch, events: { onToolResult: event => {
    const result = event.toolResult;
    if (!result) throw new Error('Missing final result');
    if (change === 'error') result.is_error = true;
    else if (change === 'replace') result.content = 'WARNING: rewritten';
    else {
      const block = Array.isArray(result.content) ? result.content.find(item => item.type === 'text') : undefined;
      if (!block || block.type !== 'text') throw new Error('Missing text block');
      block.text += '\nWARNING: changed in place';
    }
  } } }, budget);
  const cell = await pilot.run(`return await tools['${name}']({});`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.hadToolErrors).toBe(change === 'error');
  expect(cell.receipts[0]?.result.data).toBeUndefined();
  expect(JSON.stringify(cell.receipts[0]?.result.content)).toContain('WARNING:');
});

it('preserves unmodified multimodal content alongside its JSON data', async () => {
  const content = [{ type: 'text' as const, text: 'WARNING: inspect image' },
    { type: 'image' as const, path: '/source.png', mediaType: 'image/png' }];
  const { pilot } = fixture({ kind: 'tool', content, structuredContent: { samples: [2, 3] } });
  const cell = await pilot.run(`return (await tools['${name}']({})).data.value;`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual({ samples: [2, 3] });
  expect(cell.receipts[0]?.result.content).toEqual(expect.arrayContaining(content));
});

it('keeps existing native failure semantics for cyclic structured content without replay', async () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const { pilot, dispatch, definition, executeCapability } = fixture({ kind: 'tool', structuredContent: cycle });
  const native = await executeRunScopedTool(dispatch.ctx, { ...definition, sideEffect: 'readonly' }, {});
  executeCapability.mockClear();
  const cell = await pilot.run(`return await tools['${name}']({});`, limits);
  expect(cell.hadToolErrors).toBe(true);
  expect(cell.receipts[0]?.result.content).toBe(native);
  expect(cell.receipts[0]?.result.data).toBeUndefined();
  expect(executeCapability).toHaveBeenCalledOnce();
});

it('preserves native evidence when an optional deep JSON snapshot exceeds local stack capacity', async () => {
  let value: Record<string, unknown> = { end: true };
  for (let depth = 0; depth < 1600; depth++) value = { next: value };
  const { pilot, dispatch, definition } = fixture({ kind: 'tool', structuredContent: value,
    content: 'WARNING: deeply nested provider evidence' });
  const native = await executeRunScopedTool(dispatch.ctx, { ...definition, sideEffect: 'readonly' }, {});
  expect(native).toContain('WARNING: deeply nested provider evidence');
  const diagnostics = vi.fn();
  const restore = setKodaXDiagnosticSink(diagnostics);
  try {
    const cell = await pilot.run(`const r=await tools['${name}']({});return {error:r.isError,dataPresent:r.data!==undefined};`, limits);
    expect(cell.status, cell.error).toBe('completed');
    expect(cell.value).toEqual({ error: false, dataPresent: false });
    expect(cell.receipts[0]?.result.content).toBe(native);
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: expect.stringContaining('projection') }));
  } finally { restore(); }
});

it.each([128, 1000])('round-trips a supported nested JSON result through the actual VM (depth %s)', async depth => {
  let value: Record<string, unknown> = { end: true };
  for (let index = 0; index < depth; index++) value = { next: value };
  const { pilot } = fixture({ kind: 'tool', structuredContent: value, content: 'WARNING: original nested source' });
  const cell = await pilot.run(`return await tools['${name}']({});`, limits);
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.hadToolErrors).toBe(false);
  expect(cell.receipts[0]?.result.data?.kind).toBe('json');
  expect(JSON.stringify(cell.value)).toBe(JSON.stringify(cell.receipts[0]?.result));
});

it('does not walk an opaque native structured value beyond its existing display serialization', async () => {
  let reads = 0;
  const value = { get measure() { reads++; return 7; } };
  const { dispatch, definition } = fixture({ kind: 'tool', structuredContent: value });
  const native = await executeRunScopedTool(dispatch.ctx, { ...definition, sideEffect: 'readonly' }, {});
  expect(native).toContain('"measure":7');
  expect(reads).toBe(1);
});

it('does not execute a revoked Host binding to obtain JSON data', async () => {
  const { pilot, dispatch, executeCapability, budget } = fixture({ kind: 'tool', structuredContent: { samples: [2] } });
  vi.spyOn(dispatch.ctx.extensionRuntime!, 'listRunTools').mockReturnValue([]);
  const cell = await pilot.run(`return await tools['${name}']({});`, limits);
  expect(cell.hadToolErrors).toBe(true);
  expect(cell.receipts[0]?.result.data).toBeUndefined();
  expect(executeCapability).not.toHaveBeenCalled();
  expect(budget.spentBudget).toBe(0);
});

it('keeps explicit MCP JSON access behind the target visibility ceiling', async () => {
  const { dispatch, call, budget, executeCapability } = fixture({ kind: 'tool', structuredContent: { samples: [2] } }, 'mcp');
  const pilot = createScriptPilot({ ...dispatch, activeToolNames: ['mcp_call'] }, budget);
  const cell = await pilot.run(`return await ${call};`, limits);
  expect(cell.hadToolErrors).toBe(true);
  expect(cell.receipts[0]?.result.content).toContain('not active');
  expect(cell.receipts[0]?.result.data).toBeUndefined();
  expect(executeCapability).not.toHaveBeenCalled();
});

it('retains provider errors and warnings instead of granting successful JSON data', async () => {
  const { pilot } = fixture({ kind: 'tool', isError: true, structuredContent: { partial: [2, 3] },
    content: 'WARNING: effect outcome is unknown' });
  const cell = await pilot.run(`return await tools['${name}']({});`, limits);
  expect(cell.hadToolErrors).toBe(true);
  expect(cell.receipts[0]?.result.content).toContain('WARNING: effect outcome is unknown');
  expect(cell.receipts[0]?.result.data).toBeUndefined();
});

it('pages a persisted large JSON DTO and warnings without executing the Host effect again', async () => {
  const value = { samples: Array(300).fill({ x: 2, y: 3 }), optional: null };
  const { pilot, executeCapability, budget } = fixture({ kind: 'tool', structuredContent: value,
    content: 'WARNING: observations remain provisional' });
  let persisted = '';
  const cell = await pilot.run(`const r=await tools['${name}']({});let text='',offset;
    do{const p=await read_result(r.result_ref.callId,offset);text+=p.text;offset=p.nextOffset;}while(offset!==undefined);
    const first=await read_result(r.result_ref.callId,0);const full=JSON.parse(text);
    return {sum:full.data.value.samples.reduce((s,p)=>s+p.x+p.y,0),optional:full.data.value.optional,
      repeated:text.startsWith(first.text),warning:full.content.includes('WARNING: observations remain provisional')};`,
  { ...limits, maxTransferBytes: 2048 }, { onReceipt: async receipt => { persisted = JSON.stringify(receipt.result); } });
  expect(cell.status, cell.error).toBe('completed');
  expect(cell.value).toEqual({ sum: 1500, optional: null, repeated: true, warning: true });
  expect(JSON.parse(persisted)).toEqual(cell.receipts[0]?.result);
  expect(executeCapability).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(1);
});
