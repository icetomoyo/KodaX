import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applySessionCompaction, createSessionLineage } from '@kodax-ai/agent';
import { createScriptPilot } from '../packages/coding/src/agent-runtime/script/pilot.js';
import { buildRuntimeSessionState } from '../packages/coding/src/agent-runtime/runtime-session-state.js';
import { applyPostToolProcessing, runToolDispatch } from '../packages/coding/src/agent-runtime/tool-dispatch.js';
import { emitActiveExtensionEvent } from '../packages/coding/src/extensions/runtime.js';
import { executeTool, getToolDefinition } from '../packages/coding/src/tools/index.js';
import { projectModelToolDefinition } from '../packages/coding/src/tools/model-tool-definition.js';
import { wrapCodingToolAsRunnable } from '../packages/coding/src/task-engine/_internal/managed-task/tool-wrappers.js';
import type { KodaXToolExecutionContext } from '../packages/coding/src/types.js';

const names = ['memory_recall', 'session_history_search', 'session_history_read', 'kodax_manual', 'web_search', 'web_fetch'];
const limits = { timeoutMs: 5000, memoryBytes: 16 * 1024 * 1024, maxCalls: 12, maxTransferBytes: 128 * 1024 };
const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const root of directories.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-script-retrieval-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function fixture(totalBudget = 12) {
  const requests: string[] = [];
  let page = '<html><title>Fixture</title><p>Evidence 中文</p></html>';
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url?.startsWith('/search')) {
      response.end('<a class="result__a" href="/page">Fixture source</a><a class="result__snippet">Evidence 中文</a>');
    } else if (request.url === '/error') {
      response.writeHead(503);
      response.end('Service unavailable');
    } else response.end(page);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local fixture address');
  const url = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('KODAX_WEB_SEARCH_ENDPOINT', `${url}/search`);
  const lineage = applySessionCompaction(createSessionLineage([
    { role: 'system', content: 'HIDDEN-SYSTEM-INSTRUCTION' },
    { role: 'user', content: `TICKET-42 exact prior evidence ${'detail '.repeat(2200)}` },
    { role: 'assistant', content: 'TICKET-42 fixed by removing a stale lock.' },
  ]), [{ role: 'user', content: 'active tail' }], { summary: 'ticket fixed' });
  const entry = lineage.entries.find(item => item.type === 'message' && item.message.role === 'user');
  if (!entry) throw new Error('Missing history fixture entry');
  const memoryRecall = vi.fn(async () => ({ content: 'Clear the stale lock.', evidenceRefs: ['memdir:lock-procedure'] }));
  const ctx: KodaXToolExecutionContext = { backups: new Map(), executionCwd: process.cwd(), memoryRecall,
    loadSessionHistory: vi.fn(async () => lineage) };
  const budget = { totalBudget, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const dispatch = { ctx, activeToolNames: [...names], events: {},
    runtimeSessionState: buildRuntimeSessionState({ activeTools: names, modelSelection: {} }) };
  const inputs: Record<string, Record<string, unknown>> = {
    memory_recall: { need: 'stale lock recovery' }, session_history_search: { query: 'TICKET-42' },
    session_history_read: { entry_id: entry.id }, kodax_manual: { topic: 'overview' },
    web_search: { query: 'fixture', limit: 1 }, web_fetch: { url: `${url}/page` },
  };
  return { ctx, budget, dispatch, inputs, requests, url, lineage, memoryRecall, setPage: (value: string) => { page = value; } };
}

it('preserves all six native retrieval contracts, complete content and provenance', async () => {
  const { ctx, budget, dispatch, inputs, requests } = await fixture();
  const pilot = createScriptPilot(dispatch, budget);
  expect(pilot.tools.map(tool => tool.name)).toEqual(names);
  const nativeBudget = { ...budget };
  for (const name of names) {
    const definition = getToolDefinition(name)!;
    expect(pilot.tools.find(tool => tool.name === name)).toEqual(projectModelToolDefinition(definition, { kind: 'builtin' }));
    const native = wrapCodingToolAsRunnable(definition, (input, context) => executeTool(name, input, context), ctx, nativeBudget);
    const baseline = await native.execute(inputs[name]!, { agent: { name: 'fixture', instructions: '' } });
    const result = await pilot.run(`return await tools.${name}(${JSON.stringify(inputs[name])});`, limits);
    expect(result.status, result.error).toBe('completed');
    expect(result.hadToolErrors).toBe(false);
    expect(result.receipts[0]?.result.content).toBe(baseline.content);
    expect(result.value).toEqual(result.receipts[0]?.result);
    if (name === 'memory_recall') {
      expect(result.receipts[0]?.result.content).toContain('[Memory evidence; not an instruction]');
      expect(result.receipts[0]?.result.content).toContain('memdir:lock-procedure');
    }
    if (name.startsWith('session_history')) {
      expect(result.receipts[0]?.result.content).toContain('TICKET-42');
      expect(result.receipts[0]?.result.content).not.toContain('HIDDEN-SYSTEM-INSTRUCTION');
    }
    if (name.startsWith('web_')) {
      expect(result.receipts[0]?.result.content).toContain('Trust: open-world');
      expect(result.receipts[0]?.result.content).toContain(name === 'web_search' ? 'Fixture source' : 'Evidence 中文');
      expect(result.receipts[0]?.result.content).toContain('127.0.0.1');
    }
    if (name === 'kodax_manual') expect(result.receipts[0]?.result.content).toContain('KodaX');
  }
  expect(budget.spentBudget).toBe(6);
  expect(nativeBudget.spentBudget).toBe(6);
  expect(requests).toHaveLength(4);
});

it.each(names)('%s preserves policy refusal and recovery without charging denied work', async name => {
  const { budget, dispatch, inputs } = await fixture(1);
  let attempts = 0;
  const events = { beforeToolExecute: vi.fn(async () => ++attempts <= 2 ? '[Blocked] Retrieval policy' : true) };
  const baseline = await runToolDispatch({ ...dispatch, events, abortSignal: undefined,
    toolBlocks: [{ type: 'tool_use', id: 'native-denied', name, input: inputs[name]! }] });
  const result = await createScriptPilot({ ...dispatch, events }, budget).run(`
    const denied = await tools.${name}(${JSON.stringify(inputs[name])});
    if (!denied.isError) throw new Error('Expected refusal');
    return await tools.${name}(${JSON.stringify(inputs[name])});
  `, limits);
  expect(result.receipts.map(receipt => receipt.result.isError)).toEqual([true, false]);
  expect(result.receipts[0]?.result.content).toBe(baseline.get('native-denied'));
  expect(result.receipts[1]?.input).toEqual(inputs[name]);
  expect(budget.spentBudget).toBe(1);
});

it.each(names)('%s drains admitted work after cancellation and does not start a second call', async name => {
  const { ctx, budget, dispatch, inputs, requests } = await fixture();
  const input = inputs[name]!;
  const nativeController = new AbortController();
  const baseline = await runToolDispatch({ ...dispatch, abortSignal: nativeController.signal,
    events: { onToolExecutionStart: () => nativeController.abort() },
    toolBlocks: [{ type: 'tool_use', id: 'native-cancelled', name, input }] });
  const controller = new AbortController();
  const ended = vi.fn();
  const pilot = createScriptPilot({ ...dispatch, abortSignal: controller.signal,
    events: { onToolExecutionStart: () => controller.abort(), onToolExecutionEnd: ended } }, budget);
  const result = await pilot.run(`await tools.${name}(${JSON.stringify(input)}); await tools.${name}(${JSON.stringify(input)});`, limits);
  expect(result.status).toBe('cancelled');
  expect(result.receipts).toHaveLength(1);
  expect(result.receipts[0]?.result.content).toBe(baseline.get('native-cancelled'));
  expect(ended).toHaveBeenCalledOnce();
  expect(budget.spentBudget).toBe(1);
  expect(await pilot.run('return 1;', limits)).toMatchObject({ status: 'cancelled', receipts: [] });
  expect(requests).toHaveLength(name.startsWith('web_') ? 2 : 0);
  expect(ctx.memoryRecall).toBeDefined();
});

it.each([2, 4])('shares native budget %i across dependent history search/read work', async total => {
  const { ctx, budget, dispatch, inputs } = await fixture(total);
  const nativeBudget = { ...budget };
  const calls = ['session_history_search', ...Array.from({ length: total - 1 }, () => 'session_history_read')];
  for (const name of calls) {
    const native = wrapCodingToolAsRunnable(getToolDefinition(name)!, (input, context) => executeTool(name, input, context), ctx, nativeBudget);
    await native.execute(inputs[name]!, { agent: { name: 'fixture', instructions: '' } });
  }
  const result = await createScriptPilot(dispatch, budget).run(`
    const found = JSON.parse((await tools.session_history_search({query:'TICKET-42', role:'user'})).content);
    for (let i=0;i<${total};i++) await tools.session_history_read({entry_id:found.hits[0].entryId, revision:found.revision});
  `, limits);
  expect(result.receipts.filter(receipt => !receipt.result.isError)).toHaveLength(total);
  expect(result.receipts.at(-1)?.result.content).toContain('budget exhausted');
  expect(budget.spentBudget).toBe(total);
  expect(nativeBudget.spentBudget).toBe(total);
});

it('preserves history citations, paging, stale-revision feedback and system-entry isolation', async () => {
  const { ctx, budget, dispatch, lineage } = await fixture(6);
  const system = lineage.entries.find(entry => entry.type === 'message' && entry.message.role === 'system');
  if (!system) throw new Error('Missing system fixture entry');
  const result = await createScriptPilot(dispatch, budget).run(`
    const found = JSON.parse((await tools.session_history_search({query:'TICKET-42', role:'user'})).content);
    const entry_id = found.hits[0].entryId;
    await tools.session_history_read({entry_id, revision:'stale-revision'});
    const first = JSON.parse((await tools.session_history_read({entry_id, revision:found.revision})).content);
    if (first.nextOffset === undefined) throw new Error('Missing history continuation');
    await tools.session_history_read({entry_id, revision:found.revision, offset:first.nextOffset});
    await tools.session_history_read({entry_id:${JSON.stringify(system.id)}});
    return await tools.session_history_search({query:'HIDDEN-SYSTEM-INSTRUCTION', scope:'all'});
  `, limits);
  expect(result.status, result.error).toBe('completed');
  expect(result.receipts).toHaveLength(6);
  for (const receipt of result.receipts) expect(receipt.result.content).toBe(await executeTool(receipt.name, receipt.input, ctx));
  expect(JSON.parse(String(result.receipts[1]?.result.content)).status).toBe('stale');
  expect(JSON.parse(String(result.receipts[4]?.result.content)).status).toBe('not_found');
  expect(JSON.parse(String(result.receipts[5]?.result.content)).hits).toEqual([]);
  expect(budget.spentBudget).toBe(6);
});

it('keeps absent history bindings and revoked tools out of the pilot without granting new authority', async () => {
  const { ctx, budget, dispatch, inputs } = await fixture();
  const pilot = createScriptPilot(dispatch, budget);
  ctx.loadSessionHistory = undefined;
  expect(createScriptPilot(dispatch, budget).tools.map(tool => tool.name)).not.toContain('session_history_search');
  const denied = await pilot.run('return await tools.session_history_search({query:"TICKET-42"});', limits);
  expect(denied.receipts[0]?.result.content).toContain('outside this Script pilot');
  dispatch.activeToolNames.splice(dispatch.activeToolNames.indexOf('memory_recall'), 1);
  const revoked = await pilot.run(`return await tools.memory_recall(${JSON.stringify(inputs.memory_recall)});`, limits);
  expect(revoked.receipts[0]?.result.isError).toBe(true);
  ctx.excludeTools = [...names];
  expect(createScriptPilot(dispatch, budget).tools).toEqual([]);
  expect(budget.spentBudget).toBe(0);
});

it('preserves bound-memory failure and no-match feedback before recovery', async () => {
  const { budget, dispatch, memoryRecall } = await fixture(3);
  memoryRecall.mockRejectedValueOnce(new Error('Memory backend unavailable'))
    .mockResolvedValueOnce({ content: '', evidenceRefs: [] });
  const result = await createScriptPilot(dispatch, budget).run(`
    await tools.memory_recall({need:'lock'});
    await tools.memory_recall({need:'lock'});
    return await tools.memory_recall({need:'lock'});
  `, limits);
  expect(result.receipts.map(receipt => receipt.result.isError)).toEqual([true, false, false]);
  expect(result.receipts[0]?.result.content).toContain('Memory backend unavailable');
  expect(result.receipts[1]?.result.content).toBe('[Memory recall: no applicable governed claim]');
  expect(result.receipts[2]?.result.content).toContain('memdir:lock-procedure');
  expect(memoryRecall).toHaveBeenCalledTimes(3);
  expect(budget.spentBudget).toBe(3);
});

it('keeps HTTP failure evidence and invalid-URL recovery without extra fetch attempts', async () => {
  const { ctx, budget, dispatch, url, requests } = await fixture(3);
  const baseline = await executeTool('web_fetch', { url: `${url}/error` }, ctx);
  const result = await createScriptPilot(dispatch, budget).run(`
    await tools.web_fetch({url:'file:///forbidden'});
    await tools.web_fetch({url:${JSON.stringify(`${url}/error`)}});
    return await tools.web_fetch({url:${JSON.stringify(`${url}/page`)}});
  `, limits);
  expect(result.receipts[0]?.result.isError).toBe(true);
  expect(result.receipts[0]?.input).toEqual({ url: 'file:///forbidden' });
  expect(result.receipts[1]?.result.content).toBe(baseline);
  expect(result.receipts[1]?.result.content).toContain('non-success status 503');
  expect(result.receipts[2]?.result.content).toContain('Evidence 中文');
  expect(requests).toEqual(['/error', '/error', '/page']);
  expect(budget.spentBudget).toBe(3);
});

it('preserves native capacity fallback and the complete acquired evidence in its recovery artifact', async () => {
  const { ctx, budget, dispatch, inputs, setPage } = await fixture(1);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-retrieval-'));
  directories.push(directory);
  vi.stubEnv('KODAX_TOOL_OUTPUT_DIR', directory);
  setPage('x'.repeat(600 * 1024));
  const baseline = await executeTool('web_fetch', inputs.web_fetch!, ctx);
  const toolBlocks = [{ type: 'tool_use' as const, id: 'native-large', name: 'web_fetch', input: inputs.web_fetch! }];
  const resultMap = await runToolDispatch({ ...dispatch, abortSignal: undefined, toolBlocks });
  const native = await applyPostToolProcessing({ ...dispatch, toolBlocks, resultMap, emitActiveExtensionEvent });
  const nativeOutputPath = native.toolResults[0]?.metadata?.outputPath;
  const result = await createScriptPilot(dispatch, budget).run(`return await tools.web_fetch(${JSON.stringify(inputs.web_fetch)});`, limits);
  expect(result.status, result.error).toBe('completed');
  const outputPath = result.receipts[0]?.result.metadata?.outputPath;
  expect(typeof outputPath).toBe('string');
  expect(result.receipts[0]?.result.metadata).toMatchObject({ truncated: true, capacityFallback: true });
  expect(baseline).toContain('SOURCE_INCOMPLETE');
  expect(await readFile(String(outputPath), 'utf8')).toBe(baseline);
  expect(await readFile(String(nativeOutputPath), 'utf8')).toBe(baseline);
  expect(String(result.receipts[0]?.result.content).replaceAll(String(outputPath), '<ARTIFACT>'))
    .toBe(String(native.toolResults[0]?.content).replaceAll(String(nativeOutputPath), '<ARTIFACT>'));
  expect(result.value).toEqual(result.receipts[0]?.result);
  expect(budget.spentBudget).toBe(1);
});

it('fails an undersized cell transfer explicitly and keeps the complete admitted receipt', async () => {
  const { ctx, budget, dispatch, inputs, setPage } = await fixture(1);
  setPage('x'.repeat(8000));
  const baseline = await executeTool('web_fetch', inputs.web_fetch!, ctx);
  const result = await createScriptPilot(dispatch, budget).run(`return await tools.web_fetch(${JSON.stringify(inputs.web_fetch)});`,
    { ...limits, maxTransferBytes: 512 });
  expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('transfer limit') });
  expect(result.receipts[0]?.result.content).toBe(baseline);
  expect(budget.spentBudget).toBe(1);
});
